/**
 * Round 46: Drive/Dropbox controls only after OAuth connected; Dropbox popup
 * failure inline alerts; restore dialog Merge/Add missing ≥44px.
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

// 1. Controls gated on connected state, not merely configured key
assert.ok(appJs.includes('isGoogleDriveConnected'));
assert.ok(appJs.includes('isDropboxConnected'));
assert.ok(appJs.includes('controls.hidden = !connected'));
assert.ok(appJs.includes("Connect Google Drive"));
assert.ok(appJs.includes("Connect Dropbox"));
assert.ok(appJs.includes("Back up to Google Drive"));
assert.ok(appJs.includes('connectGoogleDrive') || appJs.includes('requestAccessToken'));
// HTML defaults: controls hidden until JS reveals after OAuth
assert.ok(/id="google-drive-controls"[^>]*\bhidden\b/.test(appHtml)
  || /id="google-drive-controls" class="[^"]*" hidden/.test(appHtml));
assert.ok(/id="dropbox-controls"[^>]*\bhidden\b/.test(appHtml)
  || /id="dropbox-controls" class="[^"]*" hidden/.test(appHtml));
assert.ok(appHtml.includes('Connect Google Drive') || appHtml.includes('btn-backup-google-drive'));

// 2. Dropbox popup failure messages (inline alert)
assert.ok(appJs.includes('mapDropboxAuthError'));
assert.ok(appJs.includes('Popup was blocked — allow popups for deeperguard.com.'));
assert.ok(appJs.includes('Dropbox sign-in didn’t complete. Check your App key and try again.')
  || appJs.includes("Dropbox sign-in didn't complete. Check your App key and try again."));
assert.ok(appHtml.includes('id="dropbox-key-error"') && /dropbox-key-error[^>]*role="alert"/.test(appHtml));
assert.ok(cloudSrc.includes('Popup was blocked — allow popups for deeperguard.com.'));
assert.ok(cloudSrc.includes('Dropbox sign-in didn’t complete') || cloudSrc.includes("Dropbox sign-in didn't complete"));

// 3. Restore dialog buttons ≥44px
assert.ok(/\.confirm-dialog-actions\s+\.btn\s*\{[^}]*min-height:\s*var\(--touch\)/s.test(appCss));
assert.ok(appHtml.includes('id="confirm-ok"'));
assert.ok(appHtml.includes('id="confirm-extra"'));
assert.ok(appJs.includes('Add missing only'));
assert.ok(appJs.includes("confirmLabel: 'Merge'") || appJs.includes('confirmLabel: "Merge"'));

(async () => {
  // Behavioral: prefs.driveConnected gates controls; popup-blocked message
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
  Cloud.setUserProviderKeys({ googleClientId: '123.apps.googleusercontent.com', dropboxAppKey: 'fake0test0key12' });
  assert.strictEqual(Cloud.isGoogleConfigured(), true);
  assert.strictEqual(!!Cloud.readPrefs().driveConnected, false);
  Cloud.writePrefs({ driveConnected: true });
  assert.strictEqual(!!Cloud.readPrefs().driveConnected, true);
  Cloud.writePrefs({ driveConnected: false });
  assert.strictEqual(!!Cloud.readPrefs().driveConnected, false);

  sandbox.window.open = () => null;
  let blocked = null;
  try {
    await Cloud.beginDropboxOAuth({ pending: 'connect' });
  } catch (err) {
    blocked = String(err.message || '');
  }
  assert.ok(blocked && /Popup was blocked/.test(blocked));

  console.log('test_round46_cloud_connected_state ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
