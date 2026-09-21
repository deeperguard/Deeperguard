const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(
  path.join(__dirname, '../app/static/js/app.js'),
  'utf8',
);

function slice(startMarker, endMarker) {
  const start = appJs.indexOf(startMarker);
  const end = appJs.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `could not locate ${startMarker}`);
  return appJs.slice(start, end);
}

// Execute the shell-cache helpers against a fake Cache API.
const helpers = slice('function shellCacheKeys()', 'let shellPreseedInFlight');
const puts = [];
const fakeShell = {
  put: async (key, response) => {
    puts.push({ key: typeof key === 'string' ? key : key.url, response });
  },
};
const sandbox = {
  location: { origin: 'https://www.deeperguard.com', pathname: '/' },
  caches: { open: async () => fakeShell },
  Request: class Request { constructor(url) { this.url = url; } },
  Response: class Response {
    constructor(body, init) { this.body = body; this.status = init.status; this.headers = init.headers; }
  },
  Blob: class Blob { constructor(parts) { this.text = parts.join(''); } },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  fetch: async () => { throw new Error('not used'); },
};
const factory = new Function(
  ...Object.keys(sandbox),
  `${helpers}\nreturn { shellCacheKeys, writeShellCache, buildFromHtml };`,
);
const api = factory(...Object.values(sandbox));

// The notes shell is cached under /app only. "/" is the marketing site.
const keys = api.shellCacheKeys().map((k) => (typeof k === 'string' ? k : k.url));
assert.deepStrictEqual(
  keys.sort(),
  ['/app', 'https://www.deeperguard.com/app'].sort(),
);

assert.strictEqual(api.buildFromHtml('<meta name="notes-build" content="c8aebc63">'), 'c8aebc63');
assert.strictEqual(api.buildFromHtml('<html></html>'), '');

(async () => {
  const html = '<!DOCTYPE html><meta name="notes-build" content="c8aebc63"><body>x</body>';
  const ok = await api.writeShellCache(html, { build: 'c8aebc63' });
  assert.strictEqual(ok, true);
  assert.strictEqual(puts.length, 2, 'the notes shell is stored under /app only');
  for (const entry of puts) {
    assert.strictEqual(entry.response.body.text, html);
    assert.strictEqual(entry.response.headers['X-Notes-Build'], 'c8aebc63');
  }

  // Update download must bypass the service worker (which would hand back the
  // stale cached shell on a slow network) and never navigate with hard=1.
  const fetchFn = slice('async function fetchLatestShellHtml(', 'async function prefetchShellAssets(');
  assert.match(fetchFn, /\/api\/app-shell\?t=/);
  assert.doesNotMatch(fetchFn, /hard=1/);

  const forceFn = slice('async function forceRefreshApp()', 'window.notesForceRefreshApp =');
  assert.match(forceFn, /fetchLatestShellHtml\(\)/);
  assert.match(forceFn, /downloadedBuild === currentBuild/);
  assert.match(forceFn, /Update did not download the new build/);
  assert.match(forceFn, /location\.pathname !== '\/' \? location\.pathname : '\/app'/);
  assert.doesNotMatch(forceFn, /hard=1/);

  // A newer server build pre-seeds the shell cache so the next launch is new
  // even when the user never taps Update; it must never reload the page.
  const preseed = slice('function preseedLatestShell(serverBuild)', 'async function persistAppShell()');
  assert.match(preseed, /notes_preseeded_build/);
  assert.match(preseed, /writeShellCache\(html, \{ build: target \}\)/);
  assert.doesNotMatch(preseed, /location\.(replace|reload|assign)/);
  const applyFn = slice('function applyServerBuildStatus(serverBuild)', 'function openOfflineSecuritySettings()');
  assert.match(applyFn, /preseedLatestShell\(build\)/);
  const persistFn = slice('async function persistAppShell()', 'async function clearAppCaches(');
  assert.match(persistFn, /preseedLatestShell\(String\(data\.build\)\)/);
  assert.match(persistFn, /writeShellCache\(lockedShellHtml\(\)/);

  console.log('test_shell_cache_update.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
