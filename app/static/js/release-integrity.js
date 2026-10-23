/**
 * Client-side build-hash check against the published GitHub Release.
 *
 * Local hash: SHA-256 over the canonical manifest form of the same-origin
 * assets listed in /static/client-manifest.json (fetch each asset URL, hash
 * bytes with SubtleCrypto). The shell meta notes-client-hash is only a
 * convenience mirror — if it differs from the computed value, that is flagged.
 *
 * Expected hash: public GitHub Releases API JSON for the preferred tag. The
 * release body embeds `manifest_sha256` from the signing workflow. Release
 * asset CDN bodies lack CORS ACAO, so the API JSON is the clean path.
 *
 * Also fetches /releases/latest (cached) and warns when the matched tag is
 * older than latest — warning, not an error.
 *
 * Honesty: a match proves the hashed same-origin assets equal the hash
 * published with that release. The checker script itself is served by the
 * same origin, so independent verification still means cosign / building from
 * source. Not Sigstore verification. Never blocks the app; never sends vault data.
 */
(function (global) {
  const REPO = 'deeperguard/Deeperguard';
  const API = 'https://api.github.com';
  const MANIFEST_URL = '/static/client-manifest.json';
  const CACHE_KEY = 'notes_release_hash_check_v2';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const RATE_COOLDOWN_MS = 60 * 60 * 1000;

  const STATUS = {
    match: 'match',
    mismatch: 'mismatch',
    unavailable: 'unavailable',
    pending: 'pending',
  };

  let lastResult = null;
  let inflight = null;
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

  /** Convenience mirror from the shell (may be stamped by a tampered origin). */
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

  // Back-compat alias used by older tests / callers.
  function localClientHash() {
    return metaClientHash();
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
    } catch (err) { /* quota / private mode */ }
  }

  function cacheLooksFresh(doc, computedHash, tag) {
    if (!doc || doc.localHash !== computedHash) return false;
    if ((tag || '') !== (doc.tag || '')) return false;
    const at = Number(doc.checkedAt || 0);
    if (!at || (Date.now() - at) > CACHE_TTL_MS) return false;
    return doc.status === STATUS.match
      || doc.status === STATUS.mismatch
      || doc.status === STATUS.unavailable;
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

  function formatMessage(result) {
    if (!result) return 'Checking signed release…';
    if (result.status === STATUS.pending) return 'Checking signed release…';

    if (result.failedAssets && result.failedAssets.length) {
      const list = result.failedAssets.slice(0, 8).join(', ');
      const more = result.failedAssets.length > 8
        ? ` (+${result.failedAssets.length - 8} more)`
        : '';
      return `Could not check — failed to hash: ${list}${more}`;
    }

    if (result.status === STATUS.mismatch) return 'Does not match';
    if (result.status === STATUS.unavailable) {
      return 'Could not check (offline / rate-limited)';
    }

    // match
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

  /**
   * Fetch same-origin client-manifest.json, hash each listed asset URL, then
   * SHA-256 the canonical "logical:sha256\\n…" payload (same as build script).
   */
  async function computeLocalManifestHash() {
    const metaHash = metaClientHash();
    const failedAssets = [];
    let doc;
    try {
      const resp = await global.fetch(MANIFEST_URL, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!resp.ok) {
        return {
          computedHash: '',
          metaHash,
          failedAssets: ['client-manifest.json'],
          metaMismatch: false,
        };
      }
      doc = await resp.json();
    } catch (err) {
      return {
        computedHash: '',
        metaHash,
        failedAssets: ['client-manifest.json'],
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
        metaMismatch: false,
      };
    }

    const lines = [];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const info = assets[key] || {};
      const url = String(info.url || `/static/${key}`);
      try {
        const resp = await global.fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'force-cache',
        });
        if (!resp.ok) {
          failedAssets.push(key);
          continue;
        }
        const buf = await resp.arrayBuffer();
        const hex = await sha256Hex(buf);
        lines.push(`${key}:${hex}`);
      } catch (err) {
        failedAssets.push(key);
      }
    }

    if (failedAssets.length) {
      return {
        computedHash: '',
        metaHash,
        failedAssets,
        metaMismatch: false,
      };
    }

    const payload = new TextEncoder().encode(lines.join('\n'));
    const computedHash = await sha256Hex(payload);
    return {
      computedHash,
      metaHash,
      failedAssets: [],
      metaMismatch: !!(metaHash && computedHash && metaHash !== computedHash),
    };
  }

  async function fetchReleaseJson(tag) {
    const path = tag
      ? `/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
      : `/repos/${REPO}/releases/latest`;
    const url = `${API}${path}`;
    const resp = await global.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
    });
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
      message: '',
    };
    result.message = formatMessage(result);
    return result;
  }

  async function runCheck(opts) {
    const force = !!(opts && opts.force);
    const tag = preferredTag();

    let computed;
    try {
      computed = await computeLocalManifestHash();
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
    const metaMismatch = !!computed.metaMismatch;

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

    try {
      const release = await fetchReleaseJson(tag);
      const releaseTag = String(release.tag_name || tag || '').trim();
      const expectedHash = parseManifestShaFromBody(release.body);
      const signed = releaseHasSigstore(release.assets);

      let newerTag = '';
      try {
        // One extra call; skipped when preferred tag already is latest.
        const latest = await fetchReleaseJson('');
        const latestTag = String(latest.tag_name || '').trim();
        if (latestTag && releaseTag && tagOlderThan(releaseTag, latestTag)) {
          newerTag = latestTag;
        }
      } catch (err) {
        // Latest probe is best-effort; do not fail the whole check.
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

  async function ensureChecked(opts) {
    if (inflight) return inflight;
    const pending = resultFromParts({
      status: STATUS.pending,
      tag: preferredTag(),
      metaHash: metaClientHash(),
    });
    emit(pending);
    paintAll(pending);
    inflight = runCheck(opts).then((result) => {
      inflight = null;
      emit(result);
      paintAll(result);
      return result;
    }, () => {
      inflight = null;
      const result = resultFromParts({
        status: STATUS.unavailable,
        tag: preferredTag(),
        metaHash: metaClientHash(),
        reason: 'error',
      });
      emit(result);
      paintAll(result);
      return result;
    });
    return inflight;
  }

  function start(opts) {
    try {
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(() => { ensureChecked(opts); }, { timeout: 4000 });
      } else {
        global.setTimeout(() => { ensureChecked(opts); }, 0);
      }
    } catch (err) {
      global.setTimeout(() => { ensureChecked(opts); }, 0);
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
    sha256Hex,
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
  };

  global.NotesReleaseIntegrity = api;
  autoStart();
})(typeof window !== 'undefined' ? window : globalThis);
