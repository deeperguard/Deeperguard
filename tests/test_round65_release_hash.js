/**
 * Round 65 Feature B: client release-hash check (independent of server).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/static/js/release-integrity.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

assert.ok(appHtml.includes("asset_script('js/release-integrity.js')"));
assert.ok(appHtml.includes('data-release-hash-status'));
assert.ok(appHtml.includes('name="notes-release-tag"'));
assert.ok(appHtml.includes('id="about-release-hash-status"'));

assert.ok(verify.includes("asset_script('js/release-integrity.js')"));
assert.ok(verify.includes('data-release-hash-status'));
assert.ok(verify.includes('api.github.com'));
assert.ok(verify.includes('release-assets.githubusercontent.com'));
assert.ok(verify.includes('Access-Control-Allow-Origin'));
assert.ok(verify.includes('not</strong> Sigstore') || verify.includes('not Sigstore'));
assert.ok(verify.includes('cosign'));
assert.ok(verify.includes('Could not check (offline / rate-limited)'));
assert.ok(verify.includes('Does not match'));
assert.ok(verify.includes('Matches signed release'));

// /verify may load only the release-integrity helper (SRI via asset_script).
const scriptTags = verify.match(/<script[\s>]/gi) || [];
assert.strictEqual(scriptTags.length, 0, 'no raw <script> tags — use asset_script only');
assert.ok(verify.includes("asset_script('js/release-integrity.js')"));

assert.ok(authPy.includes("https://api.github.com"));
assert.ok(authPy.includes('connect-src'));
assert.ok(!authPy.includes('release-assets.githubusercontent.com'), 'do not widen CSP for unused CDN');

assert.ok(appJs.includes('NotesReleaseIntegrity'));
assert.ok(src.includes('api.github.com'));
assert.ok(src.includes('notes-client-hash'));
assert.ok(!src.includes('/api/health'), 'must not trust server health for expected hash');

function loadApi(harness) {
  const sandbox = {
    window: harness,
    globalThis: harness,
    setTimeout: (fn) => { fn(); return 0; },
    requestIdleCallback: undefined,
    console,
  };
  sandbox.window = harness;
  sandbox.document = harness.document;
  sandbox.localStorage = harness.localStorage;
  sandbox.fetch = harness.fetch;
  vm.runInNewContext(src, sandbox, { filename: 'release-integrity.js' });
  return sandbox.NotesReleaseIntegrity || harness.NotesReleaseIntegrity;
}

function makeHarness({ hash, tag, fetchImpl, storage }) {
  const store = storage || Object.create(null);
  const meta = {
    'notes-client-hash': hash || '',
    'notes-release-tag': tag || '',
  };
  const statusEl = {
    textContent: '',
    hidden: false,
    dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
    },
    setAttribute() {},
    removeAttribute() {},
  };
  const harness = {
    document: {
      // Keep loading so autoStart does not race unit tests.
      readyState: 'loading',
      querySelector(sel) {
        const m = /^meta\[name="([^"]+)"\]$/.exec(sel);
        if (m && meta[m[1]] !== undefined) {
          return { getAttribute: (k) => (k === 'content' ? meta[m[1]] : null) };
        }
        if (sel === '[data-release-hash-status]') return statusEl;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-release-hash-status]') return [statusEl];
        return [];
      },
      getElementById(id) {
        if (id === 'about-client-hash') {
          return { textContent: hash || '' };
        }
        return null;
      },
      addEventListener() {},
    },
    localStorage: {
      getItem(k) { return store[k] == null ? null : store[k]; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    },
    fetch: fetchImpl,
  };
  return { harness, statusEl, store };
}

const HASH_A = '605a4d7e53679551a3b99d9144547a56a77dc8970d29c94c266e055ab96bab7c';
const HASH_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

{
  const { harness } = makeHarness({
    hash: HASH_A,
    tag: 'v0.62.1',
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
  });
  const api = loadApi(harness);
  assert.strictEqual(
    api.parseManifestShaFromBody('## Client\n\n`manifest_sha256`: `' + HASH_A + '`\n'),
    HASH_A,
  );
  assert.strictEqual(api.parseManifestShaFromBody('no hash here'), '');
  assert.ok(api.formatMessage({ status: 'match', tag: 'v0.62.1' }).includes('Matches signed release v0.62.1'));
  assert.strictEqual(api.formatMessage({ status: 'mismatch' }), 'Does not match');
  assert.strictEqual(api.formatMessage({ status: 'unavailable' }), 'Could not check (offline / rate-limited)');
}

(async () => {
  // Match + signed
  {
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '50' : null) },
        json: async () => ({
          tag_name: 'v0.62.1',
          body: '`manifest_sha256`: `' + HASH_A + '`',
          assets: [
            { name: 'client-manifest.json' },
            { name: 'client-manifest.sigstore.json' },
          ],
        }),
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.strictEqual(result.message, 'Matches signed release v0.62.1');
    assert.ok(result.signed);
  }

  // Mismatch — only when hash fetched
  {
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => '50' },
        json: async () => ({
          tag_name: 'v0.62.1',
          body: '`manifest_sha256`: `' + HASH_B + '`',
          assets: [{ name: 'client-manifest.sigstore.json' }],
        }),
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'mismatch');
    assert.strictEqual(result.message, 'Does not match');
  }

  // Network error → unavailable (not mismatch)
  {
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      fetchImpl: async () => { throw new Error('offline'); },
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.message, 'Could not check (offline / rate-limited)');
  }

  // Rate limit
  {
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: { get: (h) => (h === 'x-ratelimit-reset' ? String(Math.floor(Date.now() / 1000) + 3600) : null) },
        json: async () => ({}),
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.reason, 'rate_limited');
  }

  // Cache hit skips fetch
  {
    let fetches = 0;
    const storage = Object.create(null);
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      storage,
      fetchImpl: async () => {
        fetches += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => '50' },
          json: async () => ({
            tag_name: 'v0.62.1',
            body: '`manifest_sha256`: `' + HASH_A + '`',
            assets: [{ name: 'client-manifest.sigstore.json' }],
          }),
        };
      },
    });
    const api = loadApi(harness);
    await api.runCheck({ force: true });
    assert.strictEqual(fetches, 1);
    const cached = await api.runCheck({ force: false });
    assert.strictEqual(fetches, 1);
    assert.ok(cached.fromCache);
    assert.strictEqual(cached.status, 'match');
  }

  // Must not call Deeperguard APIs
  {
    const urls = [];
    const { harness } = makeHarness({
      hash: HASH_A,
      tag: 'v0.62.1',
      fetchImpl: async (url) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          headers: { get: () => '50' },
          json: async () => ({
            tag_name: 'v0.62.1',
            body: '`manifest_sha256`: `' + HASH_A + '`',
            assets: [{ name: 'client-manifest.sigstore.json' }],
          }),
        };
      },
    });
    const api = loadApi(harness);
    await api.runCheck({ force: true });
    assert.ok(urls.every((u) => u.startsWith('https://api.github.com/')));
    assert.ok(urls.some((u) => u.includes('/releases/tags/v0.62.1')));
  }

  console.log('test_round65_release_hash ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
