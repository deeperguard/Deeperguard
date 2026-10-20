/**
 * Round 48: opener must not call popup.close() (COOP on cross-origin Dropbox
 * authorize page). Same-origin /app redirect closes itself; cancel/fail still
 * shows the Dropbox sign-in inline alert.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(jsRoot, 'cloud-backup.js'), 'utf8');

// Opener finish() must not call popup.close(); redirect page may window.close() itself
assert.ok(cloudSrc.includes('Never call popup.close()'));
// Strip comments before checking for executable popup.close() calls
const cloudNoComments = cloudSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
assert.ok(!/\bpopup\.close\s*\(/.test(cloudNoComments), 'no popup.close() call in opener path');
// Same-origin callback still self-closes
assert.ok(/window\.opener\.postMessage[\s\S]*window\.close\s*\(/.test(cloudSrc));
// Inline alert message still mapped in app.js
assert.ok(appJs.includes('mapDropboxAuthError'));
assert.ok(
  appJs.includes('Dropbox sign-in didn’t complete. Check your App key and try again.')
  || appJs.includes("Dropbox sign-in didn't complete. Check your App key and try again."),
);
assert.ok(cloudSrc.includes('Dropbox sign-in didn’t complete') || cloudSrc.includes("Dropbox sign-in didn't complete"));

(async () => {
  const store = new Map();
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    URLSearchParams,
    Buffer,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: webcrypto,
    Blob: class Blob {},
    File: class File {},
    FormData: class FormData { append() {} },
    URL: class URL {
      constructor(href) {
        this.href = href;
        this.origin = 'https://www.deeperguard.com';
        this.pathname = '/app';
        this.search = '';
        this.hash = '';
        this.searchParams = new URLSearchParams();
      }
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      querySelector: () => ({ getAttribute: () => '' }),
      getElementById: () => ({ dataset: {} }),
      createElement: () => ({ click() {}, remove() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: {},
    location: {
      origin: 'https://www.deeperguard.com',
      search: '',
      href: 'https://www.deeperguard.com/app',
      pathname: '/app',
      assign() {},
    },
    history: { state: null, replaceState() {} },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    module: { exports: {} },
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox);
  const Cloud = sandbox.window.NotesCloudBackup;
  Cloud.setUserProviderKeys({
    googleClientId: '123.apps.googleusercontent.com',
    dropboxAppKey: 'abcdefghijklmno',
  });

  let closeCalls = 0;
  let closedReads = 0;
  const fakePopup = {
    get closed() {
      closedReads += 1;
      return false;
    },
    close() {
      closeCalls += 1;
    },
  };
  const listeners = {};
  sandbox.window.open = () => fakePopup;
  sandbox.window.addEventListener = (type, fn) => {
    listeners[type] = listeners[type] || [];
    listeners[type].push(fn);
  };
  sandbox.window.removeEventListener = (type, fn) => {
    listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
  };

  let cancelMsg = null;
  const oauthPromise = Cloud.beginDropboxOAuth({ pending: 'connect' }).then(
    () => { cancelMsg = null; },
    (err) => { cancelMsg = String(err.message || ''); },
  );
  for (let i = 0; i < 80 && !(listeners.message || []).length; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok((listeners.message || []).length >= 1, 'message listener registered');

  // Failed Dropbox authorize redirects to /app with error — popup page would
  // postMessage + self-close; opener must not call popup.close().
  for (const fn of listeners.message) {
    fn({
      origin: 'https://www.deeperguard.com',
      data: {
        type: 'dg-dropbox-oauth',
        search: '?error=invalid_client&error_description=unknown+client&state=dg-dropbox:x',
      },
    });
  }
  await oauthPromise;

  assert.ok(
    cancelMsg
    && (/Dropbox sign-in didn’t complete/.test(cancelMsg)
      || /Dropbox sign-in didn't complete/.test(cancelMsg)
      || /invalid|unknown.?client|App key/i.test(cancelMsg)),
    cancelMsg,
  );
  assert.strictEqual(closeCalls, 0, 'opener must not call popup.close() (COOP)');
  assert.strictEqual(closedReads, 0, 'opener must not read popup.closed (COOP)');

  console.log('test_round48_dropbox_popup_close ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
