/**
 * Round 65/66: client release-hash check (computed local hash, latest warning).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/static/js/release-integrity.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

assert.ok(appHtml.includes("asset_script('js/release-integrity.js')"));
assert.ok(appHtml.includes('data-release-hash-status'));
assert.ok(appHtml.includes('name="notes-release-tag"'));
assert.ok(appHtml.includes('SubtleCrypto'));
assert.ok(appHtml.includes('same origin'));

assert.ok(verify.includes("asset_script('js/release-integrity.js')"));
assert.ok(verify.includes('data-release-hash-status'));
assert.ok(verify.includes('data-status-prefix="Status: "'));
assert.ok(verify.includes('Status: Checking signed release'));
assert.ok(verify.includes('<strong>Status</strong> line above'));
assert.ok(verify.includes('api.github.com'));
assert.ok(verify.includes('SubtleCrypto') || verify.includes('hashes them in the browser'));
assert.ok(verify.includes('compromised server') || verify.includes('itself served'));
assert.ok(verify.includes('cosign'));
assert.ok(verify.includes('newer release'));
assert.ok(!/<script[\s>]/i.test(verify), 'no raw <script> tags');

assert.ok(authPy.includes('https://api.github.com'));
assert.ok(!authPy.includes('release-assets.githubusercontent.com'));
assert.ok(appJs.includes('NotesReleaseIntegrity'));
assert.ok(src.includes('computeLocalManifestHash'));
assert.ok(src.includes('force-cache'));
assert.ok(src.includes('/releases/latest') || src.includes("fetchReleaseJson('')"));
assert.ok(!src.includes('/api/health'));

function webcryptoSubtle() {
  return {
    digest: async (algo, buf) => {
      assert.strictEqual(algo, 'SHA-256');
      const hash = crypto.createHash('sha256');
      hash.update(Buffer.from(buf));
      return hash.digest().buffer.slice(hash.digest().byteOffset, hash.digest().byteOffset + hash.digest().byteLength);
    },
  };
}

// Node crypto subtle returns ArrayBuffer via digest sync helper
function nodeSubtle() {
  return {
    digest: async (algo, buf) => {
      assert.ok(String(algo).includes('SHA-256'));
      const dig = crypto.createHash('sha256').update(Buffer.from(buf)).digest();
      return dig.buffer.slice(dig.byteOffset, dig.byteOffset + dig.byteLength);
    },
  };
}

function loadApi(harness) {
  const sandbox = {
    window: harness,
    globalThis: harness,
    setTimeout: (fn) => { fn(); return 0; },
    requestIdleCallback: undefined,
    console,
    TextEncoder,
  };
  sandbox.window = harness;
  sandbox.document = harness.document;
  sandbox.localStorage = harness.localStorage;
  sandbox.fetch = harness.fetch;
  sandbox.crypto = harness.crypto;
  vm.runInNewContext(src, sandbox, { filename: 'release-integrity.js' });
  return harness.NotesReleaseIntegrity;
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
    attributes: { 'data-status-prefix': 'Status: ' },
    getAttribute(name) { return this.attributes[name] || null; },
    setAttribute(name, val) { this.attributes[name] = String(val); },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name.startsWith('data-')) delete this.dataset[name.slice(5)];
    },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
    },
  };
  const harness = {
    document: {
      readyState: 'loading',
      querySelector(sel) {
        const m = /^meta\[name="([^"]+)"\]$/.exec(sel);
        if (m && meta[m[1]] !== undefined) {
          return { getAttribute: (k) => (k === 'content' ? meta[m[1]] : null) };
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-release-hash-status]') return [statusEl];
        return [];
      },
      getElementById(id) {
        if (id === 'about-client-hash') return { textContent: hash || '' };
        if (id === 'verify-release-hash-status') return statusEl;
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
    crypto: { subtle: nodeSubtle() },
  };
  return { harness, statusEl, store };
}

const HASH_A = '605a4d7e53679551a3b99d9144547a56a77dc8970d29c94c266e055ab96bab7c';
const HASH_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function assetBytes(label) {
  return Buffer.from(`asset-body:${label}`, 'utf8');
}

function buildManifestDoc(entries) {
  // entries: [{key, bytes}]
  const assets = {};
  const lines = [];
  for (const { key, bytes } of entries) {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assets[key] = { sha256: sha, url: `/static/${key}`, bytes: bytes.length };
  }
  const keys = Object.keys(assets).sort();
  for (const key of keys) lines.push(`${key}:${assets[key].sha256}`);
  const manifest_sha256 = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  return { version: 1, created: 0, manifest_sha256, asset_count: keys.length, assets };
}

function githubOk(bodyObj) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '50' : null) },
    json: async () => bodyObj,
  };
}

{
  const { harness } = makeHarness({
    hash: HASH_A,
    tag: 'v0.62.1',
    fetchImpl: async () => githubOk({}),
  });
  const api = loadApi(harness);
  assert.strictEqual(api.parseManifestShaFromBody('`manifest_sha256`: `' + HASH_A + '`'), HASH_A);
  assert.ok(api.tagOlderThan('v0.62.1', 'v0.63.0'));
  assert.ok(!api.tagOlderThan('v0.63.0', 'v0.62.1'));
  assert.ok(api.formatMessage({
    status: 'match', tag: 'v0.62.1', signed: true, newerTag: 'v0.63.0',
  }).includes('newer release v0.63.0 exists'));
  assert.ok(api.formatMessage({
    status: 'unavailable', failedAssets: ['js/app.js', 'css/app.css'],
  }).includes('failed to hash: js/app.js, css/app.css'));
}

(async () => {
  const entries = [
    { key: 'css/app.css', bytes: assetBytes('css') },
    { key: 'js/app.js', bytes: assetBytes('js') },
  ];
  const manifest = buildManifestDoc(entries);
  const computed = manifest.manifest_sha256;

  function assetFetchImpl({ tagBody, latestTag, tagName, failKey, metaHash }) {
    return async (url) => {
      const u = String(url);
      if (u.endsWith('/client-manifest.json') || u === '/static/client-manifest.json') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => manifest,
          arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)),
        };
      }
      for (const e of entries) {
        if (u.endsWith(e.key) || u.includes(`/static/${e.key}`)) {
          if (failKey && e.key === failKey) {
            return { ok: false, status: 500, headers: { get: () => null } };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength),
          };
        }
      }
      if (u.includes('/releases/latest')) {
        return githubOk({
          tag_name: latestTag || tagName || 'v0.63.0',
          body: '`manifest_sha256`: `' + (latestTag === tagName ? computed : HASH_B) + '`',
          assets: [{ name: 'client-manifest.sigstore.json' }],
        });
      }
      if (u.includes('/releases/tags/')) {
        return githubOk({
          tag_name: tagName || 'v0.63.0',
          body: tagBody || ('`manifest_sha256`: `' + computed + '`'),
          assets: [{ name: 'client-manifest.json' }, { name: 'client-manifest.sigstore.json' }],
        });
      }
      throw new Error('unexpected fetch ' + u);
    };
  }

  // Match + signed (meta equals computed)
  {
    const { harness, statusEl } = makeHarness({
      hash: computed,
      tag: 'v0.63.0',
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.0', latestTag: 'v0.63.0' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.strictEqual(result.localHash, computed);
    assert.strictEqual(result.message, 'Matches signed release v0.63.0');
    assert.ok(!result.newerTag);
    api.paint(statusEl, result);
    assert.ok(statusEl.textContent.startsWith('Status: Matches signed release'));
  }

  // Newer release warning
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.62.1',
      fetchImpl: assetFetchImpl({
        tagName: 'v0.62.1',
        latestTag: 'v0.63.0',
        tagBody: '`manifest_sha256`: `' + computed + '`',
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.strictEqual(result.newerTag, 'v0.63.0');
    assert.ok(result.message.includes('Matches signed release v0.62.1'));
    assert.ok(result.message.includes('newer release v0.63.0 exists'));
  }

  // Meta differs from computed — still match release, flag meta
  {
    const { harness } = makeHarness({
      hash: HASH_B, // wrong meta
      tag: 'v0.63.0',
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.0', latestTag: 'v0.63.0' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.ok(result.metaMismatch);
    assert.ok(result.message.includes('shell meta hash differs'));
  }

  // Mismatch vs release
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.0',
      fetchImpl: assetFetchImpl({
        tagName: 'v0.63.0',
        latestTag: 'v0.63.0',
        tagBody: '`manifest_sha256`: `' + HASH_B + '`',
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'mismatch');
    assert.strictEqual(result.message, 'Does not match');
  }

  // Failed asset named exactly
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.0',
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.0', latestTag: 'v0.63.0', failKey: 'js/app.js' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'unavailable');
    assert.ok(Array.isArray(result.failedAssets));
    assert.strictEqual(result.failedAssets.join(','), 'js/app.js');
    assert.ok(result.message.includes('failed to hash: js/app.js'));
  }

  // Must not call Deeperguard APIs for expected hash
  {
    const urls = [];
    const base = assetFetchImpl({ tagName: 'v0.63.0', latestTag: 'v0.63.0' });
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.0',
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        return base(url, init);
      },
    });
    const api = loadApi(harness);
    await api.runCheck({ force: true });
    assert.ok(urls.some((u) => u.includes('api.github.com')));
    assert.ok(urls.some((u) => u.includes('/static/')));
    assert.ok(!urls.some((u) => u.includes('/api/health')));
  }

  console.log('test_round65_release_hash ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
