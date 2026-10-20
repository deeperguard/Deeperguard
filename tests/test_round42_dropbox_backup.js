/**
 * Round 42 part 2: Dropbox PKCE encrypted backups — not-configured UI,
 * mocked upload/list/download, PKCE redirect handling, existing paths intact.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const cloudSrc = fs.readFileSync(path.join(root, 'app/static/js/cloud-backup.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');
const configPy = fs.readFileSync(path.join(root, 'app/config.py'), 'utf8');
const legal = fs.readFileSync(path.join(root, 'app/templates/legal.html'), 'utf8');

assert.ok(configPy.includes('DROPBOX_APP_KEY'));
assert.ok(authPy.includes('api.dropboxapi.com'));
assert.ok(authPy.includes('content.dropboxapi.com'));
assert.ok(authPy.includes('www.dropbox.com'));
assert.ok(appHtml.includes('btn-backup-dropbox'));
assert.ok(appHtml.includes('dropbox-not-configured'));
assert.ok(appHtml.includes('Dropbox: Not configured on this server.'));
assert.ok(appHtml.includes('dropbox_configured') || appHtml.includes('dropbox_app_key'));
assert.ok(/btn-backup-dropbox[\s\S]*?disabled/.test(appHtml) || appHtml.includes('if not dropbox_configured'));
assert.ok(appHtml.includes('meta name="dropbox-app-key"') || appHtml.includes('dropbox-app-key'));
assert.ok(appJs.includes('isDropboxConfigured'));
assert.ok(appJs.includes('refreshDropboxBackupUi'));
assert.ok(appJs.includes('uploadDropboxBackupBlob'));
assert.ok(appJs.includes('consumeDropboxOAuthRedirect') || appJs.includes('finishDropboxOAuthIfPresent'));
assert.ok(appJs.includes("missing.textContent = 'Dropbox: Not configured on this server.'"));
assert.ok(legal.includes('Dropbox'));
// Existing backup paths must remain.
assert.ok(appHtml.includes('btn-save-backup-file'));
assert.ok(appHtml.includes('btn-backup-google-drive'));
assert.ok(appHtml.includes('btn-backup-now'));
assert.ok(appHtml.includes('restore-backup-file'));
assert.ok(cloudSrc.includes('uploadBackupBlob'));
assert.ok(cloudSrc.includes('saveBackupFile'));

function loadCloud({
  dropboxKey = '',
  googleClientId = '',
  fetchImpl = null,
  locationOrigin = 'https://www.deeperguard.com',
  locationSearch = '',
  historyReplace = null,
} = {}) {
  const store = new Map();
  const session = new Map();
  let search = locationSearch;
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    TextEncoder,
    URLSearchParams,
    Buffer,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: webcrypto,
    Blob: class Blob {
      constructor(parts, opts) {
        this._parts = parts.map((p) => (typeof p === 'string' ? p : String(p)));
        this.type = (opts && opts.type) || '';
        this.size = this._parts.reduce((n, p) => n + p.length, 0);
      }
      async text() { return this._parts.join(''); }
    },
    File: class File {
      constructor(parts, name, opts) {
        this.name = name;
        this.type = (opts && opts.type) || '';
      }
    },
    FormData: class FormData {
      constructor() { this.entries = []; }
      append(k, v, n) { this.entries.push([k, v, n]); }
    },
    URL: class URL {
      constructor(href) {
        const m = String(href).match(/^(https?:\/\/[^/?#]+)(\/[^?]*)?(\?[^#]*)?(#.*)?$/);
        this.origin = m ? m[1] : locationOrigin;
        this.pathname = (m && m[2]) || '/app';
        this.search = (m && m[3]) || '';
        this.hash = (m && m[4]) || '';
        this.searchParams = new URLSearchParams(this.search.startsWith('?') ? this.search.slice(1) : this.search);
        this.href = href;
      }
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    },
    document: {
      querySelector: (sel) => {
        if (sel === 'meta[name="dropbox-app-key"]') {
          return { getAttribute: () => dropboxKey };
        }
        if (sel === 'meta[name="google-oauth-client-id"]') {
          return { getAttribute: () => googleClientId };
        }
        return null;
      },
      getElementById: () => ({
        dataset: {
          dropboxAppKey: dropboxKey,
          googleOauthClientId: googleClientId,
        },
      }),
      createElement: () => ({ click() {}, remove() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: {},
    location: {
      origin: locationOrigin,
      get search() { return search; },
      set search(v) { search = v; },
      href: `${locationOrigin}/app${locationSearch}`,
      pathname: '/app',
      assign() {},
    },
    history: {
      state: null,
      replaceState: historyReplace || ((_s, _t, url) => {
        const u = String(url);
        const qi = u.indexOf('?');
        search = qi >= 0 ? u.slice(qi) : '';
      }),
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => ({}) })),
    module: { exports: {} },
    exports: {},
    window: null,
    globalThis: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox);
  const Cloud = sandbox.module.exports;
  Cloud.__store = store;
  Cloud.__session = session;
  Cloud.__sandbox = sandbox;
  return Cloud;
}

// Not configured
{
  const Cloud = loadCloud({ dropboxKey: '' });
  assert.strictEqual(Cloud.isDropboxConfigured(), false);
  assert.strictEqual(Cloud.dropboxAppKey(), '');
}

// Redirect URI
{
  const Cloud = loadCloud({ dropboxKey: 'abc123', locationOrigin: 'https://www.deeperguard.com' });
  assert.strictEqual(Cloud.dropboxRedirectUri(), 'https://www.deeperguard.com/app');
}

(async () => {
  // PKCE begin + consume redirect
  {
    const calls = [];
    let assigned = '';
    const Cloud = loadCloud({
      dropboxKey: 'test-app-key',
      fetchImpl: async (url, opts = {}) => {
        calls.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), body: opts.body });
        if (String(url).includes('/oauth2/token')) {
          const body = String(opts.body || '');
          assert.ok(body.includes('grant_type=authorization_code'));
          assert.ok(body.includes('code_verifier='));
          assert.ok(body.includes('client_id=test-app-key'));
          assert.ok(body.includes(encodeURIComponent('https://www.deeperguard.com/app')) || body.includes('redirect_uri='));
          return {
            ok: true,
            json: async () => ({
              access_token: 'sl.access',
              refresh_token: 'sl.refresh',
              expires_in: 14400,
              token_type: 'bearer',
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    Cloud.__sandbox.location.assign = (url) => { assigned = String(url); };
    // Capture verifier/state without navigating away permanently
    const origAssign = Cloud.__sandbox.location.assign;
    let authUrl = '';
    Cloud.__sandbox.location.assign = (url) => { authUrl = String(url); };
    await Cloud.beginDropboxOAuth({ pending: 'backup' });
    Cloud.__sandbox.location.assign = origAssign;
    assert.ok(authUrl.includes('https://www.dropbox.com/oauth2/authorize'));
    assert.ok(authUrl.includes('code_challenge_method=S256'));
    assert.ok(authUrl.includes('token_access_type=offline'));
    assert.ok(authUrl.includes('files.content.write'));
    assert.ok(authUrl.includes('files.content.read'));
    const authParams = new URLSearchParams(authUrl.split('?')[1]);
    const state = authParams.get('state');
    assert.ok(state && state.startsWith('dg-dropbox:'));
    assert.ok(Cloud.__session.get('dg-dropbox-pkce-verifier'));
    assert.strictEqual(Cloud.__session.get('dg-dropbox-pending-action'), 'backup');

    const result = await Cloud.consumeDropboxOAuthRedirect({
      search: `?code=authcode1&state=${encodeURIComponent(state)}`,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pending, 'backup');
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, 'sl.access');
    assert.strictEqual(Cloud.readPrefs().dropboxRefreshToken, 'sl.refresh');
    assert.ok(calls.some((c) => c.url.includes('/oauth2/token')));
  }

  // Upload + list + download roundtrip (mocked Dropbox)
  {
    const files = new Map();
    const Cloud = loadCloud({
      dropboxKey: 'test-app-key',
      fetchImpl: async (url, opts = {}) => {
        const u = String(url);
        const method = (opts.method || 'GET').toUpperCase();
        if (u.includes('/files/upload')) {
          const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
          const text = opts.body && opts.body._parts ? opts.body._parts.join('') : String(opts.body || '');
          files.set(arg.path, text);
          return {
            ok: true,
            json: async () => ({
              id: 'id:abc',
              name: arg.path.replace(/^\//, ''),
              path_display: arg.path,
              path_lower: arg.path.toLowerCase(),
              server_modified: '2026-10-20T12:00:00Z',
              client_modified: '2026-10-20T12:00:00Z',
            }),
          };
        }
        if (u.includes('/files/list_folder')) {
          return {
            ok: true,
            json: async () => ({
              entries: [...files.keys()].map((p) => ({
                '.tag': 'file',
                name: p.replace(/^\//, ''),
                path_display: p,
                path_lower: p.toLowerCase(),
                server_modified: '2026-10-20T12:00:00Z',
              })),
            }),
          };
        }
        if (u.includes('/files/download')) {
          const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
          const text = files.get(arg.path) || '';
          return {
            ok: true,
            text: async () => text,
            // downloadDropboxBackup uses res.text()
          };
        }
        if (u.includes('/auth/token/revoke')) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    // Seed a valid token so ensureDropboxToken does not redirect
    Cloud.writePrefs({
      dropboxConnected: true,
      dropboxAccessToken: 'sl.access',
      dropboxTokenExpiresAt: Date.now() + 3600_000,
      dropboxRefreshToken: 'sl.refresh',
    });
    const original = {
      format: 'deeperguard-backup-v1',
      items: [{ item_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ciphertext: '{}' }],
    };
    const blob = Cloud.backupBlobFromObject(original);
    const filename = 'deeperguard-backup-2026-10-20.dgbackup';
    const uploaded = await Cloud.uploadDropboxBackupBlob(blob, { filename });
    assert.strictEqual(uploaded.name, filename);
    assert.ok(Cloud.readPrefs().lastDropboxBackupAt);
    assert.strictEqual(Cloud.readPrefs().lastDropboxFilePath, `/${filename}`);

    const listed = await Cloud.listDropboxBackups({ limit: 5 });
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].name, filename);

    // Patch download to return text via Response-like object used by cloud-backup
    const prevFetch = Cloud.__sandbox.fetch;
    Cloud.__sandbox.fetch = async (url, opts = {}) => {
      if (String(url).includes('/files/download')) {
        const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
        const text = files.get(arg.path) || '';
        return { ok: true, text: async () => text };
      }
      return prevFetch(url, opts);
    };
    // Re-bind: uploadDropboxBackupBlob/list use module-local fetch from sandbox —
    // the module captured sandbox.fetch at call time via global fetch, so reassign works.
    const text = await Cloud.downloadDropboxBackup(`/${filename}`);
    assert.deepStrictEqual(JSON.parse(text), original);

    await Cloud.disconnectDropbox();
    assert.strictEqual(Cloud.readPrefs().dropboxConnected, false);
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, '');
  }

  // Google path still works when Dropbox key is set
  {
    const Cloud = loadCloud({ dropboxKey: 'dbx', googleClientId: 'g.apps.googleusercontent.com' });
    assert.strictEqual(Cloud.isDropboxConfigured(), true);
    assert.strictEqual(Cloud.isGoogleConfigured(), true);
    const blob = Cloud.backupBlobFromObject({ format: 'deeperguard-backup-v1', items: [] });
    assert.ok(blob);
  }

  console.log('test_round42_dropbox_backup ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
