/**
 * Client-side build-hash check against the published GitHub Release.
 *
 * Local hash: meta[name="notes-client-hash"] (same value as client-manifest.json
 * → manifest_sha256, stamped into the shell when the origin served it).
 *
 * Expected hash: public GitHub Releases API JSON for the matching tag (or
 * latest). The release body embeds `manifest_sha256` from the same workflow
 * that publishes and Sigstore-signs client-manifest.json. Release asset
 * download URLs redirect to release-assets.githubusercontent.com, which does
 * not send Access-Control-Allow-Origin, so the browser cannot read the asset
 * body; the Releases API JSON is CORS-enabled (*) and is the clean path.
 *
 * A hash match proves the served client hash equals the hash published with
 * that release. It is NOT Sigstore/cosign signature verification — do that
 * with cosign (see /verify). Never blocks the app; never sends vault data.
 */
(function (global) {
  const REPO = 'deeperguard/Deeperguard';
  const API = 'https://api.github.com';
  const CACHE_KEY = 'notes_release_hash_check_v1';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — stay under unauthenticated API budget
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

  function localClientHash() {
    const fromMeta = metaContent('notes-client-hash').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(fromMeta)) return fromMeta;
    try {
      const el = global.document && global.document.getElementById('about-client-hash');
      const text = el ? String(el.textContent || '').trim().toLowerCase() : '';
      if (/^[a-f0-9]{64}$/.test(text)) return text;
    } catch (err) { /* ignore */ }
    return '';
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

  function cacheLooksFresh(doc, localHash, tag) {
    if (!doc || doc.localHash !== localHash) return false;
    if ((tag || '') !== (doc.tag || '')) return false;
    const at = Number(doc.checkedAt || 0);
    if (!at || (Date.now() - at) > CACHE_TTL_MS) return false;
    return doc.status === STATUS.match
      || doc.status === STATUS.mismatch
      || doc.status === STATUS.unavailable;
  }

  function formatMessage(result) {
    if (!result) return 'Checking signed release…';
    if (result.status === STATUS.match) {
      return `Matches signed release ${result.tag || ''}`.trim();
    }
    if (result.status === STATUS.mismatch) {
      return 'Does not match';
    }
    if (result.status === STATUS.pending) {
      return 'Checking signed release…';
    }
    return 'Could not check (offline / rate-limited)';
  }

  function parseManifestShaFromBody(body) {
    const text = String(body || '');
    // Release workflow body: `manifest_sha256`: `<64 hex>`
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
      // Body may still be usable this once; note cooldown for next time.
      writeCache({
        ...(readCache() || {}),
        rateLimitedUntil: reset ? Number(reset) * 1000 : Date.now() + RATE_COOLDOWN_MS,
      });
    }
    return resp.json();
  }

  function resultFromParts({ status, tag, localHash, expectedHash, signed, reason }) {
    const result = {
      status,
      tag: tag || '',
      localHash: localHash || '',
      expectedHash: expectedHash || '',
      signed: !!signed,
      reason: reason || '',
      checkedAt: Date.now(),
      message: '',
    };
    result.message = formatMessage(result);
    return result;
  }

  async function runCheck(opts) {
    const force = !!(opts && opts.force);
    const localHash = localClientHash();
    const tag = preferredTag();

    if (!localHash) {
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        reason: 'no_local_hash',
      });
    }

    const cached = readCache();
    if (!force && cacheLooksFresh(cached, localHash, tag)) {
      return {
        status: cached.status,
        tag: cached.tag || tag,
        localHash,
        expectedHash: cached.expectedHash || '',
        signed: !!cached.signed,
        reason: cached.reason || 'cache',
        checkedAt: cached.checkedAt,
        message: formatMessage(cached),
        fromCache: true,
      };
    }

    const rateUntil = Number((cached && cached.rateLimitedUntil) || 0);
    if (!force && rateUntil && Date.now() < rateUntil) {
      return resultFromParts({
        status: STATUS.unavailable,
        tag,
        localHash,
        reason: 'rate_limited',
      });
    }

    try {
      const release = await fetchReleaseJson(tag);
      const releaseTag = String(release.tag_name || tag || '').trim();
      const expectedHash = parseManifestShaFromBody(release.body);
      const signed = releaseHasSigstore(release.assets);

      if (!expectedHash) {
        const unavailable = resultFromParts({
          status: STATUS.unavailable,
          tag: releaseTag,
          localHash,
          signed,
          reason: 'no_hash_in_release',
        });
        writeCache({ ...unavailable, localHash, rateLimitedUntil: 0 });
        return unavailable;
      }

      const match = expectedHash === localHash;
      // Only claim "signed release" match when the release publishes a Sigstore bundle.
      // A bare hash match on an unsigned release still uses status=match but message
      // stays honest via formatMessage only when signed; if unsigned, treat as match
      // with tag but message "Matches signed release" would be wrong — require signed.
      if (match && !signed) {
        const result = resultFromParts({
          status: STATUS.match,
          tag: releaseTag,
          localHash,
          expectedHash,
          signed: false,
          reason: 'hash_match_unsigned',
        });
        // Honest copy when the release is not Sigstore-signed yet.
        result.message = `Matches release ${releaseTag} (not Sigstore-signed)`.trim();
        writeCache({ ...result, localHash, rateLimitedUntil: 0 });
        return result;
      }

      const result = resultFromParts({
        status: match ? STATUS.match : STATUS.mismatch,
        tag: releaseTag,
        localHash,
        expectedHash,
        signed,
        reason: match ? 'hash_match' : 'hash_mismatch',
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
        reason: code || 'network',
      });
    }
  }

  function paint(el, result) {
    if (!el) return;
    const r = result || lastResult;
    const text = r ? (r.message || formatMessage(r)) : 'Checking signed release…';
    el.textContent = text;
    el.dataset.status = r ? r.status : STATUS.pending;
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.remove('release-check-match', 'release-check-mismatch', 'release-check-unavailable', 'release-check-pending');
    const cls = r && r.status === STATUS.match
      ? 'release-check-match'
      : r && r.status === STATUS.mismatch
        ? 'release-check-mismatch'
        : r && r.status === STATUS.pending
          ? 'release-check-pending'
          : 'release-check-unavailable';
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
    const pending = resultFromParts({ status: STATUS.pending, tag: preferredTag(), localHash: localClientHash() });
    emit(pending);
    paintAll(pending);
    inflight = runCheck(opts).then((result) => {
      inflight = null;
      emit(result);
      paintAll(result);
      return result;
    }, (err) => {
      inflight = null;
      const result = resultFromParts({
        status: STATUS.unavailable,
        tag: preferredTag(),
        localHash: localClientHash(),
        reason: 'error',
      });
      emit(result);
      paintAll(result);
      return result;
    });
    return inflight;
  }

  function start(opts) {
    // Never block app boot — schedule after the current turn.
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

  // Auto-start when this script is the page's integrity helper (app + /verify).
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
    preferredTag,
    parseManifestShaFromBody,
    formatMessage,
    runCheck,
    ensureChecked,
    start,
    paint,
    paintAll,
    onChange,
    getResult,
    // test hooks
    _readCache: readCache,
    _writeCache: writeCache,
    _CACHE_KEY: CACHE_KEY,
  };

  global.NotesReleaseIntegrity = api;
  autoStart();
})(typeof window !== 'undefined' ? window : globalThis);
