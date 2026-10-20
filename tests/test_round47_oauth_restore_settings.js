/**
 * Round 47: no COOP popup.closed polling; friendly Google popup messages;
 * persistent restore result status; Settings buttons ≥44px.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(jsRoot, 'cloud-backup.js'), 'utf8');

// 1. No popup.closed polling (COOP console errors)
assert.ok(!/\bif\s*\(\s*popup\.closed\s*\)/.test(cloudSrc), 'must not poll popup.closed');
assert.ok(cloudSrc.includes('Do not poll popup.closed') || cloudSrc.includes('postMessage'));
assert.ok(cloudSrc.includes('addEventListener(\'message\'') || cloudSrc.includes('addEventListener("message"'));
assert.ok(cloudSrc.includes('DROPBOX_OAUTH_TIMEOUT_MS') || /5\s*\*\s*60\s*\*\s*1000/.test(cloudSrc));

// 2. Friendly Google popup-closed / blocked messages
assert.ok(cloudSrc.includes('mapGoogleAuthError') || appJs.includes('mapGoogleAuthError'));
assert.ok(cloudSrc.includes('popup_closed') || appJs.includes('popup_closed') || /popup.*closed/i.test(cloudSrc));
assert.ok(
  cloudSrc.includes('Google sign-in didn’t complete. Check your Client ID and try again.')
  || cloudSrc.includes("Google sign-in didn't complete. Check your Client ID and try again.")
  || appJs.includes('Google sign-in didn’t complete. Check your Client ID and try again.')
  || appJs.includes("Google sign-in didn't complete. Check your Client ID and try again."),
);
assert.ok(
  cloudSrc.includes('Popup was blocked — allow popups for deeperguard.com.')
  || appJs.includes('Popup was blocked — allow popups for deeperguard.com.'),
);
assert.ok(appHtml.includes('id="google-key-error"') && /google-key-error[^>]*role="alert"/.test(appHtml));

// 3. Persistent restore result (role=status), toast kept
assert.ok(appHtml.includes('id="restore-result-status"'));
assert.ok(/restore-result-status[^>]*role="status"/.test(appHtml));
assert.ok(appJs.includes('setRestoreResultStatus'));
assert.ok(appJs.includes('showRestoreResult'));
assert.ok(appJs.includes('Restore complete:'));
assert.ok(appJs.includes('already up to date'));
assert.ok(appJs.includes('kept newer local'));
// toast still used alongside persistent status
assert.ok(/function showRestoreResult[\s\S]*?toast\(msg\)/.test(appJs));

// 4. Settings buttons ≥44px
assert.ok(/\.settings-panel\s+\.btn:not\(\.icon\):not\(\.password-toggle\)/.test(appCss)
  || /\.settings-panel\s+\.btn:not\([^)]*\)[\s\S]*?min-height:\s*var\(--touch\)/.test(appCss));
assert.ok(/\.settings-panel\s+\.theme-opt[\s\S]*?min-height:\s*var\(--touch\)/.test(appCss)
  || /settings-panel[\s\S]*?\.theme-opt[\s\S]*?min-height:\s*var\(--touch\)/.test(appCss));
assert.ok(appCss.includes('--touch: 44px') || appCss.includes('--touch:44px'));

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
    dropboxAppKey: 'fake0test0key12',
  });
  assert.ok(typeof Cloud.requestAccessToken === 'function');

  // Popup blocked still works without touching .closed
  sandbox.window.open = () => null;
  let blocked = null;
  try {
    await Cloud.beginDropboxOAuth({ pending: 'connect' });
  } catch (err) {
    blocked = String(err.message || '');
  }
  assert.ok(blocked && /Popup was blocked/.test(blocked));

  // Opened popup: never read .closed; settle via postMessage
  let closedReads = 0;
  const fakePopup = {
    get closed() {
      closedReads += 1;
      return false;
    },
    close() {},
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

  const oauthPromise = Cloud.beginDropboxOAuth({ pending: 'connect' });
  for (let i = 0; i < 80 && !(listeners.message || []).length; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok((listeners.message || []).length >= 1, 'message listener registered');
  assert.ok((listeners.focus || []).length >= 1, 'focus listener registered');
  // Simulate successful same-origin redirect postMessage (no .closed access).
  for (const fn of listeners.message) {
    fn({
      origin: 'https://www.deeperguard.com',
      data: { type: 'dg-dropbox-oauth', search: '?error=access_denied&state=dg-dropbox:x' },
    });
  }
  let settledMsg = null;
  try {
    await oauthPromise;
  } catch (err) {
    settledMsg = String(err.message || '');
  }
  assert.ok(settledMsg, 'OAuth should settle from postMessage without polling closed');
  assert.strictEqual(closedReads, 0, 'must not read popup.closed (COOP)');

  console.log('test_round47_oauth_restore_settings ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
