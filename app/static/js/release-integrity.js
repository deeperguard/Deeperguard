/**
 * Client-side build-hash check against the published GitHub Release.
 *
 * Local hash: SHA-256 over the canonical manifest form of the same-origin
 * assets listed in /static/client-manifest.json (fetch each asset URL, hash
 * bytes with SubtleCrypto). Also cross-checks document <script>/<link> (and
 * crypto-worker meta) against manifest URLs.
 *
 * Expected hash: public GitHub Releases API JSON. Fetches use AbortController
 * timeouts plus an overall deadline so a hung request cannot leave the UI on
 * "Checking signed release…" forever.
 *
 * Honesty: a match proves the hashed same-origin assets equal the published
 * release hash. The checker itself is served by the same origin — independent
 * verification still means cosign / building from source.
 */
(function (global) {
  const REPO = 'deeperguard/Deeperguard';
  const API = 'https://api.github.com';
  const MANIFEST_URL = '/static/client-manifest.json';
  const CACHE_KEY = 'notes_release_hash_check_v3';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const RATE_COOLDOWN_MS = 60 * 60 * 1000;
  let REQUEST_TIMEOUT_MS = 9000;
  let OVERALL_DEADLINE_MS = 28000;

  const STATUS = {
    match: 'match',
    mismatch: 'mismatch',
    unavailable: 'unavailable',
    pending: 'pending',
  };

  let lastResult = null;
  let inflight = null;
  let checkGeneration = 0;
  const listeners = [];

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function emit(result) {
    lastResult = result;
    listeners.forEach((fn) => {
      try { fn(result); } catch (err) { /* ignore */ }
    });
  }

  function metaContent(name) {
    try {
      const el = global.document && global.document.querySelector(`meta[name="${name}"]`);
      return el ? String(el.getAttribute('content') || '').trim() : '';
    } catch (err) {
      return '';
    }
  }

  function metaClientHash() {
    const fromMeta = metaContent('notes-client-hash').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(fromMeta)) return fromMeta;
    try {
      const el = global.document && global.document.getElementById('about-client-hash');
      const text = el ? String(el.textContent || '').trim().toLowerCase() : '';
      if (/^[a-f0-9]{64}$/.test(text)) return text;
    } catch (err) { /* ignore */ }
    return '';
  }

  function localClientHash() {
    return metaClientHash();
  }

  function githubRemoteAllowed() {
    return metaContent('notes-release-github') === '1';
  }

  function preferredTag() {
    const fromMeta = metaContent('notes-release-tag');
    if (fromMeta) return fromMeta;
    try {
      const el = global.document && global.document.getElementById('about-release-tag');
      const t = el ? String(el.getAttribute('data-tag') || el.textContent || '').trim() : '';
      if (t) return t;
    } catch (err) { /* ignore */ }
    return '';
  }

  function readCache() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object') return null;
      return doc;
    } catch (err) {
      return null;
    }
  }

  function writeCache(doc) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(CACHE_KEY, JSON.stringify(doc));
      }
    } catch (err) { /* ignore */ }
  }

  function cacheLooksFresh(doc, computedHash, tag) {
    if (!doc || doc.localHash !== computedHash) return false;
    if ((tag || '') !== (doc.tag || '')) return false;
    const at = Number(doc.checkedAt || 0);
    if (!at || (Date.now() - at) > CACHE_TTL_MS) return false;
    // Do not treat unavailable/timeout as fresh — About must be able to retry.
    return doc.status === STATUS.match || doc.status === STATUS.mismatch;
  }

  function parseTagParts(tag) {
    const m = String(tag || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function tagOlderThan(a, b) {
    const pa = parseTagParts(a);
    const pb = parseTagParts(b);
    if (!pa || !pb) return false;
    for (let i = 0; i < 3; i += 1) {
      if (pa[i] < pb[i]) return true;
      if (pa[i] > pb[i]) return false;
    }
    return false;
  }

  function remainingMs(deadlineAt) {
    return Math.max(0, Number(deadlineAt || 0) - Date.now());
  }

  function timeoutError() {
    const err = new Error('timed out');
    err.code = 'timeout';
    return err;
  }

  // Prefer window timers, but fall back to lexical setTimeout (vm test harnesses
  // often pass a plain object as `window` without timer methods).
  function schedule(fn, ms) {
    const st = (global && typeof global.setTimeout === 'function')
      ? global.setTimeout
      : setTimeout;
    return st(fn, ms);
  }

  function unschedule(id) {
    const ct = (global && typeof global.clearTimeout === 'function')
      ? global.clearTimeout
      : clearTimeout;
    return ct(id);
  }

  async function fetchWithTimeout(url, init, deadlineAt) {
    const budget = remainingMs(deadlineAt);
    if (budget <= 0) throw timeoutError();
    const ms = Math.min(REQUEST_TIMEOUT_MS, budget);
    const AbortCtrl = global.AbortController;
    if (typeof AbortCtrl !== 'function') {
      // Extremely old engines: still bound by overall Promise.race deadline.
      return global.fetch(url, init || {});
    }
    const ctrl = new AbortCtrl();
    const outer = init && init.signal;
    let onOuter = null;
    if (outer) {
      if (outer.aborted) {
        ctrl.abort();
      } else {
        onOuter = () => ctrl.abort();
        outer.addEventListener('abort', onOuter, { once: true });
      }
    }
    const timer = schedule(() => {
      try { ctrl.abort(); } catch (err) { /* ignore */ }
    }, ms);
    try {
      return await global.fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }));
    } catch (err) {
      if (ctrl.signal.aborted || (err && err.name === 'AbortError')) {
        throw timeoutError();
      }
      throw err;
    } finally {
      unschedule(timer);
      if (outer && onOuter) {
        try { outer.removeEventListener('abort', onOuter); } catch (err) { /* ignore */ }
      }
    }
  }

  function formatMessage(result) {
    if (!result) return 'Checking signed release…';
    if (result.status === STATUS.pending) return 'Checking signed release…';

    if (result.unlistedAssets && result.unlistedAssets.length) {
      return `Does not match: unlisted asset ${result.unlistedAssets[0]}`;
    }

    if (result.failedAssets && result.failedAssets.length) {
      const list = result.failedAssets.slice(0, 8).join(', ');
      const more = result.failedAssets.length > 8
        ? ` (+${result.failedAssets.length - 8} more)`
        : '';
      return `Could not check — failed to hash: ${list}${more}`;
    }

    if (result.reason === 'timeout') {
      return 'Could not check (timed out)';
    }

    if (result.status === STATUS.mismatch) return 'Does not match';
    if (result.status === STATUS.unavailable) {
      return 'Could not check (offline / rate-limited)';
    }

    let msg;
    if (result.signed) {
      msg = `Matches signed release ${result.tag || ''}`.trim();
    } else {
      msg = `Matches release ${result.tag || ''} (not Sigstore-signed)`.trim();
    }
    if (result.newerTag) {
      msg += ` — newer release ${result.newerTag} exists`;
    }
    if (result.metaMismatch) {
      msg += ' (shell meta hash differs from computed)';
    }
    return msg;
  }

  function parseManifestShaFromBody(body) {
    const text = String(body || '');
    let m = text.match(/`manifest_sha256`\s*:\s*`([a-f0-9]{64})`/i);
    if (m) return m[1].toLowerCase();
    m = text.match(/manifest_sha256[`\s:=]+([a-f0-9]{64})/i);
    if (m) return m[1].toLowerCase();
    return '';
  }

  function releaseHasSigstore(assets) {
    if (!Array.isArray(assets)) return false;
    return assets.some((a) => a && String(a.name || '') === 'client-manifest.sigstore.json');
  }

  async function sha256Hex(buffer) {
    const subtle = global.crypto && global.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      const err = new Error('no SubtleCrypto');
      err.code = 'no_crypto';
      throw err;
    }
    const digest = await subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function normalizePath(url) {
    try {
      const base = (global.location && global.location.href) || 'https://deeperguard.local/';
      const u = new URL(String(url), base);
      return u.pathname;
    } catch (err) {
      return String(url || '').split('?')[0];
    }
  }

  function isStaticClientAssetPath(pathname) {
    if (!pathname || pathname.indexOf('/static/') !== 0) return false;
    return /\.(js|mjs|css)$/i.test(pathname);
  }

  /** Map /static/js/app.<16hex>.js → js/app.js (null if not a hashed URL). */
  function logicalFromHashedPath(pathname) {
    const m = String(pathname || '').match(
      /^\/static\/(.+)\.([a-f0-9]{16})\.(js|mjs|css)$/i,
    );
    if (!m) return null;
    return `${m[1]}.${m[3].toLowerCase()}`;
  }

  function collectLoadedAssetPaths() {
    const out = [];
    const seen = Object.create(null);
    const doc = global.document;
    if (!doc) return out;

    function add(raw) {
      if (!raw) return;
      const path = normalizePath(raw);
      if (!isStaticClientAssetPath(path)) return;
      if (seen[path]) return;
      seen[path] = 1;
      out.push(path);
    }

    try {
      doc.querySelectorAll('script[src]').forEach((el) => add(el.getAttribute('src') || el.src));
      doc.querySelectorAll('link[rel="stylesheet"][href]').forEach((el) => {
        add(el.getAttribute('href') || el.href);
      });
    } catch (err) { /* ignore */ }

    add(metaContent('notes-crypto-worker'));
    return out;
  }

  /**
   * Loaded same-origin JS/CSS/worker must appear in the manifest URL set.
   * Also: if a loaded hashed URL maps to a logical key whose manifest URL
   * differs, treat the loaded path as unlisted (listed URL not what loaded).
   */
  function crossCheckLoadedAssets(assets) {
    const manifestUrls = Object.create(null);
    const logicalToUrl = Object.create(null);
    const keys = Object.keys(assets || {});
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const info = assets[key] || {};
      const path = normalizePath(info.url || `/static/${key}`);
      manifestUrls[path] = key;
      logicalToUrl[key] = path;
    }

    const loaded = collectLoadedAssetPaths();
    const unlisted = [];
    for (let i = 0; i < loaded.length; i += 1) {
      const path = loaded[i];
      if (manifestUrls[path]) continue;
      const logical = logicalFromHashedPath(path);
      if (logical && logicalToUrl[logical] && logicalToUrl[logical] !== path) {
        // Page loaded a different hash than the manifest lists for this file.
        unlisted.push(path);
        continue;
      }
      if (logical && !logicalToUrl[logical]) {
        unlisted.push(path);
        continue;
      }
      if (!logical) {
        unlisted.push(path);
      }
    }
    return unlisted;
  }

  async function computeLocalManifestHash(deadlineAt) {
    const metaHash = metaClientHash();
    const failedAssets = [];
    let doc;
    try {
      const resp = await fetchWithTimeout(MANIFEST_URL, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      }, deadlineAt);
      if (!resp.ok) {
        return {
          computedHash: '',
          metaHash,
          failedAssets: ['client-manifest.json'],
          unlistedAssets: [],
          metaMismatch: false,
        };
      }
      doc = await resp.json();
    } catch (err) {
      if (err && err.code === 'timeout') throw err;
      return {
        computedHash: '',
        metaHash,
        failedAssets: ['client-manifest.json'],
        unlistedAssets: [],
        metaMismatch: false,
      };
    }

    const assets = (doc && doc.assets) || {};
    const keys = Object.keys(assets).sort();
    if (!keys.length) {
      return {
        computedHash: '',
        metaHash,
        failedAssets: ['client-manifest.json (empty assets)'],
        unlistedAssets: [],
        metaMismatch: false,
      };
    }

    const unlistedAssets = crossCheckLoadedAssets(assets);
    if (unlistedAssets.length) {
      return {
        computedHash: '',
        metaHash,
        failedAssets: [],
        unlistedAssets,
        metaMismatch: false,
      };
    }

    // Parallel fetches; each call still has its own AbortController timeout.
    const lineByKey = Object.create(null);
    await Promise.all(keys.map(async (key) => {
      if (remainingMs(deadlineAt) <= 0) {
        failedAssets.push(key);
        return;
      }
      const info = assets[key] || {};
      const url = String(info.url || `/static/${key}`);
      try {
        const resp = await fetchWithTimeout(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'force-cache',
        }, deadlineAt);
        if (!resp.ok) {
          failedAssets.push(key);
          return;
        }
        const buf = await resp.arrayBuffer();
        const hex = await sha256Hex(buf);
        lineByKey[key] = `${key}:${hex}`;
      } catch (err) {
        if (err && err.code === 'timeout') throw err;
        failedAssets.push(key);
      }
    }));

    if (failedAssets.length) {
      // De-dupe while preserving order
      const seen = Object.create(null);
      const uniq = [];
      for (let i = 0; i < failedAssets.length; i += 1) {
        const k = failedAssets[i];
        if (seen[k]) continue;
        seen[k] = 1;
        uniq.push(k);
      }
      return {
        computedHash: '',
        metaHash,
        failedAssets: uniq,
        unlistedAssets: [],
        metaMismatch: false,
      };
    }

    const lines = keys.map((k) => lineByKey[k]);
    const payload = new TextEncoder().encode(lines.join('\n'));
    const computedHash = await sha256Hex(payload);
    return {
      computedHash,
      metaHash,
      failedAssets: [],
      unlistedAssets: [],
      metaMismatch: !!(metaHash && computedHash && metaHash !== computedHash),
    };
  }

  async function fetchReleaseJson(tag, deadlineAt) {
    const path = tag
      ? `/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
      : `/repos/${REPO}/releases/latest`;
    const url = `${API}${path}`;
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
    }, deadlineAt);
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const reset = resp.headers.get('x-ratelimit-reset');
    if (resp.status === 403 || resp.status === 429) {
      const err = new Error('rate-limited');
      err.code = 'rate_limited';
      err.resetAt = reset ? Number(reset) * 1000 : Date.now() + RATE_COOLDOWN_MS;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`github ${resp.status}`);
      err.code = resp.status === 404 ? 'not_found' : 'http';
      throw err;
    }
    if (remaining !== null && Number(remaining) <= 0) {
      writeCache({
        ...(readCache() || {}),
        rateLimitedUntil: reset ? Number(reset) * 1000 : Date.now() + RATE_COOLDOWN_MS,
      });
    }
    return resp.json();
  }

  function resultFromParts(parts) {
    const result = {
      status: parts.status || STATUS.unavailable,
      tag: parts.tag || '',
      localHash: parts.localHash || '',
      expectedHash: parts.expectedHash || '',
      signed: !!parts.signed,
      reason: parts.reason || '',
      checkedAt: Date.now(),
      metaHash: parts.metaHash || '',
      metaMismatch: !!parts.metaMismatch,
      newerTag: parts.newerTag || '',
      failedAssets: Array.isArray(parts.failedAssets) ? parts.failedAssets : [],
      unlistedAssets: Array.isArray(parts.unlistedAssets) ? parts.unlistedAssets : [],
      message: '',
    };
    result.message = formatMessage(result);
    return result;
  }

  async function runCheckBody(opts, deadlineAt) {
    const force = !!(opts && opts.force);
    const tag = preferredTag();

    let computed;
    try {
      computed = await computeLocalManifestHash(deadlineAt);
    } catch (err) {
      const code = err && err.code;
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        metaHash: metaClientHash(),
        reason: code || 'compute_failed',
        failedAssets: code === 'no_crypto' ? ['SubtleCrypto unavailable'] : [],
      });
    }

    const localHash = computed.computedHash;
    const metaHash = computed.metaHash;
    const failedAssets = computed.failedAssets || [];
    const unlistedAssets = computed.unlistedAssets || [];
    const metaMismatch = !!computed.metaMismatch;

    if (unlistedAssets.length) {
      return resultFromParts({
        status: STATUS.mismatch,
        tag,
        metaHash,
        metaMismatch,
        unlistedAssets,
        reason: 'unlisted_asset',
      });
    }

    if (failedAssets.length) {
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        metaHash,
        metaMismatch,
        failedAssets,
        reason: 'asset_hash_failed',
      });
    }

    if (!localHash) {
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        metaHash,
        reason: 'no_local_hash',
      });
    }

    const cached = readCache();
    if (!force && cacheLooksFresh(cached, localHash, tag)) {
      const restored = {
        status: cached.status,
        tag: cached.tag || tag,
        localHash,
        expectedHash: cached.expectedHash || '',
        signed: !!cached.signed,
        reason: cached.reason || 'cache',
        checkedAt: cached.checkedAt,
        metaHash: cached.metaHash || metaHash,
        metaMismatch: cached.metaMismatch != null ? !!cached.metaMismatch : metaMismatch,
        newerTag: cached.newerTag || '',
        failedAssets: [],
        unlistedAssets: cached.unlistedAssets || [],
        fromCache: true,
      };
      restored.message = formatMessage(restored);
      return restored;
    }

    const rateUntil = Number((cached && cached.rateLimitedUntil) || 0);
    if (!force && rateUntil && Date.now() < rateUntil) {
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        localHash,
        metaHash,
        metaMismatch,
        reason: 'rate_limited',
      });
    }

    if (!githubRemoteAllowed()) {
      const localOnlyMatch = !!(metaHash && localHash && metaHash === localHash);
      return resultFromParts({
        status: localOnlyMatch ? STATUS.match : STATUS.unavailable,
        tag,
        localHash,
        metaHash,
        metaMismatch,
        signed: false,
        reason: localOnlyMatch ? 'meta_local_match' : 'no_remote_check',
      });
    }

    try {
      const release = await fetchReleaseJson(tag, deadlineAt);
      const releaseTag = String(release.tag_name || tag || '').trim();
      const expectedHash = parseManifestShaFromBody(release.body);
      const signed = releaseHasSigstore(release.assets);

      let newerTag = '';
      try {
        const latest = await fetchReleaseJson('', deadlineAt);
        const latestTag = String(latest.tag_name || '').trim();
        if (latestTag && releaseTag && tagOlderThan(releaseTag, latestTag)) {
          newerTag = latestTag;
        }
      } catch (err) {
        if (err && err.code === 'timeout') throw err;
        if (err && err.code === 'rate_limited') {
          writeCache({
            ...(readCache() || {}),
            rateLimitedUntil: err.resetAt || (Date.now() + RATE_COOLDOWN_MS),
          });
        }
      }

      if (!expectedHash) {
        const unavailable = resultFromParts({
          status: STATUS.unavailable,
          tag: releaseTag,
          localHash,
          metaHash,
          metaMismatch,
          signed,
          newerTag,
          reason: 'no_hash_in_release',
        });
        writeCache({ ...unavailable, localHash, rateLimitedUntil: 0 });
        return unavailable;
      }

      const match = expectedHash === localHash;
      const result = resultFromParts({
        status: match ? STATUS.match : STATUS.mismatch,
        tag: releaseTag,
        localHash,
        expectedHash,
        signed,
        metaHash,
        metaMismatch,
        newerTag,
        reason: match
          ? (signed ? 'hash_match' : 'hash_match_unsigned')
          : 'hash_mismatch',
      });
      writeCache({ ...result, localHash, rateLimitedUntil: 0 });
      return result;
    } catch (err) {
      const code = err && err.code;
      if (code === 'rate_limited') {
        writeCache({
          ...(readCache() || {}),
          localHash,
          tag,
          status: STATUS.unavailable,
          reason: 'rate_limited',
          checkedAt: Date.now(),
          rateLimitedUntil: err.resetAt || (Date.now() + RATE_COOLDOWN_MS),
        });
      }
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        localHash,
        metaHash,
        metaMismatch,
        reason: code || 'network',
      });
    }
  }

  async function runCheck(opts) {
    const deadlineAt = Date.now() + OVERALL_DEADLINE_MS;
    try {
      const result = await Promise.race([
        runCheckBody(opts, deadlineAt),
        new Promise((_, reject) => {
          schedule(() => reject(timeoutError()), OVERALL_DEADLINE_MS + 50);
        }),
      ]);
      return result;
    } catch (err) {
      const code = err && err.code;
      return resultFromParts({
        status: STATUS.unavailable,
        tag: preferredTag(),
        metaHash: metaClientHash(),
        reason: code === 'timeout' ? 'timeout' : (code || 'error'),
      });
    }
  }

  function paint(el, result) {
    if (!el) return;
    const r = result || lastResult;
    let text = r ? (r.message || formatMessage(r)) : 'Checking signed release…';
    const prefix = el.getAttribute('data-status-prefix') || '';
    if (prefix) {
      const bare = text.replace(/^Status:\s*/i, '');
      text = `${prefix}${bare}`;
    }
    el.textContent = text;
    el.dataset.status = r ? r.status : STATUS.pending;
    if (r && r.newerTag) el.dataset.newer = r.newerTag;
    else el.removeAttribute('data-newer');
    if (r && r.metaMismatch) el.dataset.metaMismatch = '1';
    else el.removeAttribute('data-meta-mismatch');
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.remove(
      'release-check-match',
      'release-check-mismatch',
      'release-check-unavailable',
      'release-check-pending',
      'release-check-warn',
    );
    let cls = 'release-check-unavailable';
    if (r && r.status === STATUS.match) {
      cls = (r.newerTag || r.metaMismatch) ? 'release-check-warn' : 'release-check-match';
    } else if (r && r.status === STATUS.mismatch) {
      cls = 'release-check-mismatch';
    } else if (r && r.status === STATUS.pending) {
      cls = 'release-check-pending';
    }
    el.classList.add(cls);
    if (r && r.status === STATUS.mismatch) {
      el.setAttribute('role', 'alert');
    } else {
      el.setAttribute('role', 'status');
    }
  }

  function paintAll(result) {
    try {
      const nodes = global.document
        ? global.document.querySelectorAll('[data-release-hash-status]')
        : [];
      nodes.forEach((el) => paint(el, result));
    } catch (err) { /* ignore */ }
  }

  function shouldForceRetry(opts) {
    if (opts && opts.force) return true;
    const last = lastResult;
    if (!last) return false;
    if (last.status === STATUS.pending) return true;
    if (last.status === STATUS.unavailable) return true;
    return false;
  }

  async function ensureChecked(opts) {
    const options = opts || {};
    const forceRetry = shouldForceRetry(options);

    if (inflight && !forceRetry && !options.force) {
      return inflight;
    }

    // Abandon a hung/stale inflight reference so About can retry.
    // Prior promise may still settle; generation guard ignores late writes.
    const gen = (checkGeneration += 1);
    if (inflight) inflight = null;

    const pending = resultFromParts({
      status: STATUS.pending,
      tag: preferredTag(),
      metaHash: metaClientHash(),
    });
    emit(pending);
    paintAll(pending);

    const runOpts = Object.assign({}, options, { force: !!(options.force || forceRetry) });
    const p = runCheck(runOpts).then((result) => {
      if (gen === checkGeneration) {
        inflight = null;
        emit(result);
        paintAll(result);
      }
      return result;
    }, () => {
      const result = resultFromParts({
        status: STATUS.unavailable,
        tag: preferredTag(),
        metaHash: metaClientHash(),
        reason: 'error',
      });
      if (gen === checkGeneration) {
        inflight = null;
        emit(result);
        paintAll(result);
      }
      return result;
    });
    inflight = p;
    return p;
  }

  function start(opts) {
    // Always schedule a timer fallback — requestIdleCallback alone can defer
    // past unlock / About open on busy main threads.
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      ensureChecked(opts).catch(() => {});
    };
    try {
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(go, { timeout: 2000 });
      }
    } catch (err) { /* ignore */ }
    try {
      schedule(go, 300);
    } catch (err) {
      go();
    }
  }

  function getResult() {
    return lastResult;
  }

  function autoStart() {
    try {
      if (!global.document) return;
      if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', () => start(), { once: true });
      } else {
        start();
      }
    } catch (err) { /* ignore */ }
  }

  const api = {
    STATUS,
    localClientHash,
    metaClientHash,
    preferredTag,
    parseManifestShaFromBody,
    parseTagParts,
    tagOlderThan,
    formatMessage,
    computeLocalManifestHash,
    crossCheckLoadedAssets,
    collectLoadedAssetPaths,
    sha256Hex,
    fetchWithTimeout,
    runCheck,
    ensureChecked,
    start,
    paint,
    paintAll,
    onChange,
    getResult,
    _readCache: readCache,
    _writeCache: writeCache,
    _CACHE_KEY: CACHE_KEY,
    _MANIFEST_URL: MANIFEST_URL,
    get _REQUEST_TIMEOUT_MS() { return REQUEST_TIMEOUT_MS; },
    get _OVERALL_DEADLINE_MS() { return OVERALL_DEADLINE_MS; },
    _setTimeoutsForTests(requestMs, overallMs) {
      if (requestMs != null) REQUEST_TIMEOUT_MS = Number(requestMs);
      if (overallMs != null) OVERALL_DEADLINE_MS = Number(overallMs);
    },
  };

  global.NotesReleaseIntegrity = api;
  autoStart();
})(typeof window !== 'undefined' ? window : globalThis);
