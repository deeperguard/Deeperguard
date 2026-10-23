/**
 * Round 65–67: release-hash check (compute, latest warning, timeouts, unlisted).
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
assert.ok(appHtml.includes('SubtleCrypto'));
assert.ok(verify.includes('data-status-prefix="Status: "'));
assert.ok(verify.includes('timed out') || verify.includes('unlisted asset'));
assert.ok(verify.includes('newer release'));
assert.ok(!/<script[\s>]/i.test(verify));
assert.ok(authPy.includes('https://api.github.com'));
assert.ok(appJs.includes('NotesReleaseIntegrity'));
assert.ok(appJs.includes("last.status === 'pending'") || appJs.includes('force'));
assert.ok(src.includes('AbortController') || src.includes('fetchWithTimeout'));
assert.ok(src.includes('crossCheckLoadedAssets'));
assert.ok(src.includes('timed out'));
assert.ok(src.includes('unlisted asset') || src.includes('unlistedAssets'));
assert.ok(!src.includes('/api/health'));

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
    // Real timers — AbortController timeouts must not fire immediately.
    setTimeout,
    clearTimeout,
    AbortController: global.AbortController,
    console,
    TextEncoder,
    URL,
  };
  sandbox.document = harness.document;
  sandbox.localStorage = harness.localStorage;
  sandbox.fetch = harness.fetch;
  sandbox.crypto = harness.crypto;
  sandbox.location = harness.location;
  vm.runInNewContext(src, sandbox, { filename: 'release-integrity.js' });
  return harness.NotesReleaseIntegrity;
}

function makeHarness({ hash, tag, fetchImpl, storage, scripts, links, worker }) {
  const store = storage || Object.create(null);
  const meta = {
    'notes-client-hash': hash || '',
    'notes-release-tag': tag || '',
    'notes-crypto-worker': worker || '',
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
  const scriptEls = (scripts || []).map((srcUrl) => ({
    getAttribute: (n) => (n === 'src' ? srcUrl : null),
    src: srcUrl,
  }));
  const linkEls = (links || []).map((href) => ({
    getAttribute: (n) => (n === 'href' ? href : null),
    href,
  }));
  const harness = {
    AbortController: global.AbortController,
    setTimeout,
    clearTimeout,
    location: { href: 'https://www.deeperguard.com/app' },
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
        if (sel === 'script[src]') return scriptEls;
        if (sel === 'link[rel="stylesheet"][href]') return linkEls;
        return [];
      },
      getElementById(id) {
        if (id === 'about-client-hash') return { textContent: hash || '' };
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
  const assets = {};
  for (const { key, bytes, url } of entries) {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assets[key] = { sha256: sha, url: url || `/static/${key}`, bytes: bytes.length };
  }
  const keys = Object.keys(assets).sort();
  const lines = keys.map((key) => `${key}:${assets[key].sha256}`);
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
  assert.ok(api.formatMessage({
    status: 'match', tag: 'v0.62.1', signed: true, newerTag: 'v0.63.0',
  }).includes('newer release v0.63.0 exists'));
  assert.ok(api.formatMessage({
    status: 'unavailable', reason: 'timeout',
  }).includes('Could not check (timed out)'));
  assert.ok(api.formatMessage({
    status: 'mismatch', unlistedAssets: ['/static/js/evil.js'],
  }).includes('Does not match: unlisted asset /static/js/evil.js'));
}

(async () => {
  const entries = [
    { key: 'css/app.css', bytes: assetBytes('css'), url: '/static/css/app.1111111111111111.css' },
    { key: 'js/app.js', bytes: assetBytes('js'), url: '/static/js/app.2222222222222222.js' },
  ];
  const manifest = buildManifestDoc(entries);
  const computed = manifest.manifest_sha256;

  function assetFetchImpl({ tagBody, latestTag, tagName, failKey, hangUrl }) {
    return async (url, init) => {
      const u = String(url);
      const signal = init && init.signal;
      if (hangUrl && u.includes(hangUrl)) {
        // Never resolve unless aborted (AbortController timeout).
        return new Promise((resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
      if (u.endsWith('/client-manifest.json') || u === '/static/client-manifest.json') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => manifest,
        };
      }
      for (const e of entries) {
        if (u === e.url || u.endsWith(e.key) || u.includes(e.url)) {
          if (failKey && e.key === failKey) {
            return { ok: false, status: 500, headers: { get: () => null } };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => e.bytes.buffer.slice(
              e.bytes.byteOffset,
              e.bytes.byteOffset + e.bytes.byteLength,
            ),
          };
        }
      }
      if (u.includes('/releases/latest')) {
        return githubOk({
          tag_name: latestTag || tagName || 'v0.63.1',
          body: '`manifest_sha256`: `' + computed + '`',
          assets: [{ name: 'client-manifest.sigstore.json' }],
        });
      }
      if (u.includes('/releases/tags/')) {
        return githubOk({
          tag_name: tagName || 'v0.63.1',
          body: tagBody || ('`manifest_sha256`: `' + computed + '`'),
          assets: [{ name: 'client-manifest.json' }, { name: 'client-manifest.sigstore.json' }],
        });
      }
      throw new Error('unexpected fetch ' + u);
    };
  }

  // Match + signed
  {
    const { harness, statusEl } = makeHarness({
      hash: computed,
      tag: 'v0.63.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.1', latestTag: 'v0.63.1' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.strictEqual(result.message, 'Matches signed release v0.63.1');
    api.paint(statusEl, result);
    assert.ok(statusEl.textContent.startsWith('Status: Matches signed release'));
  }

  // Newer release warning
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.62.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({
        tagName: 'v0.62.1',
        latestTag: 'v0.63.1',
        tagBody: '`manifest_sha256`: `' + computed + '`',
      }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.strictEqual(result.newerTag, 'v0.63.1');
    assert.ok(result.message.includes('newer release v0.63.1 exists'));
  }

  // Meta differs from computed
  {
    const { harness } = makeHarness({
      hash: HASH_B,
      tag: 'v0.63.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.1', latestTag: 'v0.63.1' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'match');
    assert.ok(result.metaMismatch);
  }

  // Unlisted loaded script
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.1',
      scripts: [entries[1].url, '/static/js/evil.ffffffffffffffff.js'],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.1', latestTag: 'v0.63.1' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'mismatch');
    assert.ok(result.message.includes('Does not match: unlisted asset'));
    assert.ok(result.message.includes('evil.ffffffffffffffff.js'));
  }

  // Failed asset
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({ tagName: 'v0.63.1', latestTag: 'v0.63.1', failKey: 'js/app.js' }),
    });
    const api = loadApi(harness);
    const result = await api.runCheck({ force: true });
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.failedAssets.join(','), 'js/app.js');
  }

  // Never-resolving fetch → timeout
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({
        tagName: 'v0.63.1',
        latestTag: 'v0.63.1',
        hangUrl: 'client-manifest.json',
      }),
    });
    const api = loadApi(harness);
    api._setTimeoutsForTests(40, 120);
    const started = Date.now();
    const result = await api.runCheck({ force: true });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.reason, 'timeout');
    assert.strictEqual(result.message, 'Could not check (timed out)');
    assert.ok(elapsed < 2000, `timeout too slow: ${elapsed}ms`);
    api._setTimeoutsForTests(9000, 28000);
  }

  // ensureChecked clears stuck inflight and retries
  {
    const { harness } = makeHarness({
      hash: computed,
      tag: 'v0.63.1',
      scripts: [entries[1].url],
      links: [entries[0].url],
      fetchImpl: assetFetchImpl({
        tagName: 'v0.63.1',
        latestTag: 'v0.63.1',
        hangUrl: 'client-manifest.json',
      }),
    });
    const api = loadApi(harness);
    api._setTimeoutsForTests(40, 100);
    const p1 = api.ensureChecked({ force: true });
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(api.getResult().status, 'pending');
    harness.fetch = assetFetchImpl({ tagName: 'v0.63.1', latestTag: 'v0.63.1' });
    api._setTimeoutsForTests(9000, 28000);
    const result = await api.ensureChecked({ force: true });
    assert.strictEqual(result.status, 'match');
    await p1.catch(() => {}); // settle abandoned generation quickly (short timeouts)
  }

  console.log('test_round65_release_hash ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
