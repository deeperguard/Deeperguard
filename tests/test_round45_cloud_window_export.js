/**
 * Round 45: NotesCloudBackup must be on window (const alone is invisible to
 * app.js). Also audit other Notes* modules for the same mismatch, Dropbox
 * popup OAuth, Configure/Remove/inline-error UI, and howto gaps.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const cloudSrc = fs.readFileSync(path.join(jsRoot, 'cloud-backup.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// --- Real browser-like load: NO module.exports path ---
{
  const windowObj = {};
  const sandbox = {
    window: windowObj,
    document: {
      querySelector: () => null,
      getElementById: () => ({ dataset: {} }),
      createElement: () => ({ click() {}, remove() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    location: {
      origin: 'https://www.deeperguard.com',
      search: '',
      href: 'https://www.deeperguard.com/app',
      pathname: '/app',
      assign() {},
    },
    navigator: {},
    history: { state: null, replaceState() {} },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Math,
    JSON,
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
    // Intentionally omit `module` so the script must attach to window.
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox);
  assert.ok(
    sandbox.window.NotesCloudBackup,
    'window.NotesCloudBackup must exist when cloud-backup.js loads without module.exports',
  );
  assert.strictEqual(typeof sandbox.window.NotesCloudBackup.isValidGoogleClientId, 'function');
  assert.strictEqual(typeof sandbox.window.NotesCloudBackup.isValidDropboxAppKey, 'function');
  assert.strictEqual(
    sandbox.window.NotesCloudBackup.isValidGoogleClientId('123456789012-faketest.apps.googleusercontent.com'),
    true,
  );
  assert.strictEqual(
    sandbox.window.NotesCloudBackup.isValidDropboxAppKey('fake0test0key12'),
    true,
  );
  assert.ok(cloudSrc.includes('window.NotesCloudBackup = NotesCloudBackup'));
  assert.ok(cloudSrc.includes('openDropboxOAuthPopup') || cloudSrc.includes('dg-dropbox-oauth'));
  assert.ok(cloudSrc.includes('window.open'));
  assert.ok(!/location\.assign\(url\)/.test(cloudSrc) || cloudSrc.includes('openDropboxOAuthPopup'));
}

// --- Audit: every Notes* IIFE module that exports via module.exports must also set window ---
{
  const files = fs.readdirSync(jsRoot).filter((f) => f.endsWith('.js'));
  const missing = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(jsRoot, file), 'utf8');
    // Match classic pattern: const NotesFoo = (() => { ... })();
    const m = src.match(/^const (Notes[A-Za-z0-9]+) = \(\(\) =>/m);
    if (!m) continue;
    const name = m[1];
    const hasModule = /module\.exports\s*=\s*/.test(src);
    const hasWindow = new RegExp(`window\\.${name}\\s*=`).test(src)
      || new RegExp(`root\\.${name}\\s*=`).test(src)
      || new RegExp(`global\\.${name}\\s*=`).test(src);
    if (hasModule && !hasWindow) missing.push(`${file} (${name})`);
  }
  assert.deepStrictEqual(missing, [], `modules missing window export: ${missing.join(', ')}`);
}

// --- UI: Remove hidden by default, Configured badge, inline errors, howto gaps ---
assert.ok(appHtml.includes('id="btn-google-key-remove"') && /btn-google-key-remove[^>]*hidden/.test(appHtml));
assert.ok(appHtml.includes('id="btn-dropbox-key-remove"') && /btn-dropbox-key-remove[^>]*hidden/.test(appHtml));
assert.ok(appHtml.includes('google-key-configured') && appHtml.includes('Configured ✓'));
assert.ok(appHtml.includes('dropbox-key-configured'));
assert.ok(appHtml.includes('google-key-error'));
assert.ok(appHtml.includes('dropbox-key-error'));
assert.ok(appHtml.includes('OAuth consent screen') || appHtml.includes('consent screen'));
assert.ok(appHtml.includes('Leave redirect URIs empty') || appHtml.includes('Leave redirect URIs empty') || /redirect URIs empty/i.test(appHtml));
assert.ok(appHtml.includes('Permissions') && appHtml.includes('Submit'));
assert.ok(appJs.includes('setGoogleKeyError') || appJs.includes('google-key-error'));
assert.ok(appJs.includes('keyRemove.hidden') || appJs.includes('btn-google-key-remove'));
assert.ok(appCss.includes('settings-field-error') || appCss.includes('cloud-configured-badge'));

// app.js must keep using window.NotesCloudBackup (not bare NotesCloudBackup-only)
assert.ok(appJs.includes('window.NotesCloudBackup'));

console.log('test_round45_cloud_window_export ok');
