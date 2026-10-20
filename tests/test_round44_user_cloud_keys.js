/**
 * Round 44: per-user Google/Dropbox OAuth app IDs in vault settings,
 * resolution order, validation, not-set-up Configure UI, mocked connect,
 * remove revokes, and no cross-user key leak.
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
const legal = fs.readFileSync(path.join(root, 'app/templates/legal.html'), 'utf8');

assert.ok(appHtml.includes('google-drive-configure'));
assert.ok(appHtml.includes('dropbox-configure'));
assert.ok(appHtml.includes('google-oauth-client-id-input'));
assert.ok(appHtml.includes('dropbox-app-key-input'));
assert.ok(appHtml.includes('btn-google-key-save'));
assert.ok(appHtml.includes('btn-dropbox-key-remove'));
assert.ok(appHtml.includes('How to get this'));
assert.ok(appHtml.includes('console.cloud.google.com') || appHtml.includes('Google Cloud Console'));
assert.ok(appHtml.includes('dropbox.com/developers/apps'));
assert.ok(appHtml.includes('https://www.deeperguard.com/app'));
assert.ok(appHtml.includes('Not set up yet — add your own key'));
assert.ok(appJs.includes('googleOauthClientId'));
assert.ok(appJs.includes('dropboxAppKey'));
assert.ok(appJs.includes("VAULT_ONLY_PREF_KEYS = ['aiChat', 'googleOauthClientId', 'dropboxAppKey']")
  || (appJs.includes('googleOauthClientId') && appJs.includes('VAULT_ONLY_PREF_KEYS')));
assert.ok(appJs.includes('setUserProviderKeys'));
assert.ok(appJs.includes('isValidGoogleClientId'));
assert.ok(appJs.includes('disconnectGoogle'));
assert.ok(legal.includes('own Google OAuth Client ID') || legal.includes('supply your own'));

function loadCloud({
  serverGoogle = '',
  serverDropbox = '',
  fetchImpl = null,
  locationOrigin = 'https://www.deeperguard.com',
} = {}) {
  const store = new Map();
  const session = new Map();
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
      }
    },
    File: class File {
      constructor(parts, name) { this.name = name; }
    },
    FormData: class FormData {
      constructor() { this.entries = []; }
      append(k, v, n) { this.entries.push([k, v, n]); }
    },
    URL: class URL {
      constructor(href) {
        this.href = href;
        this.origin = locationOrigin;
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
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    },
    document: {
      querySelector: (sel) => {
        if (sel === 'meta[name="google-oauth-client-id"]') {
          return { getAttribute: () => serverGoogle };
        }
        if (sel === 'meta[name="dropbox-app-key"]') {
          return { getAttribute: () => serverDropbox };
        }
        return null;
      },
      getElementById: () => ({
        dataset: {
          googleOauthClientId: serverGoogle,
          dropboxAppKey: serverDropbox,
        },
      }),
      createElement: () => ({ click() {}, remove() {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: {},
    location: {
      origin: locationOrigin,
      search: '',
      href: `${locationOrigin}/app`,
      pathname: '/app',
      assign() {},
    },
    history: { state: null, replaceState() {} },
    fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => ({}) })),
    module: { exports: {} },
    exports: {},
    window: null,
    globalThis: null,
    NotesStore: {
      cachedAccount: () => ({ email: session.get('notes_email') || '' }),
    },
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

// Format validation
{
  const Cloud = loadCloud();
  assert.strictEqual(Cloud.isValidGoogleClientId('123-abc.apps.googleusercontent.com'), true);
  assert.strictEqual(Cloud.isValidGoogleClientId('not-a-client-id'), false);
  assert.strictEqual(Cloud.isValidGoogleClientId(''), false);
  assert.strictEqual(Cloud.isValidDropboxAppKey('abcdefghij'), true);
  assert.strictEqual(Cloud.isValidDropboxAppKey('abcdefghijklmnop'), true);
  assert.strictEqual(Cloud.isValidDropboxAppKey('short'), false);
  assert.strictEqual(Cloud.isValidDropboxAppKey('has spaces!!'), false);
}

// Resolution order: user → server → none
{
  const Cloud = loadCloud({
    serverGoogle: 'server.apps.googleusercontent.com',
    serverDropbox: 'serverdropboxkey',
  });
  assert.strictEqual(Cloud.googleKeySource(), 'server');
  assert.strictEqual(Cloud.googleClientId(), 'server.apps.googleusercontent.com');
  assert.strictEqual(Cloud.dropboxKeySource(), 'server');
  Cloud.setUserProviderKeys({
    googleClientId: 'user.apps.googleusercontent.com',
    dropboxAppKey: 'userdropboxkey1',
  });
  assert.strictEqual(Cloud.googleKeySource(), 'user');
  assert.strictEqual(Cloud.googleClientId(), 'user.apps.googleusercontent.com');
  assert.strictEqual(Cloud.dropboxKeySource(), 'user');
  assert.strictEqual(Cloud.dropboxAppKey(), 'userdropboxkey1');
  Cloud.setUserProviderKeys({ googleClientId: '', dropboxAppKey: '' });
  assert.strictEqual(Cloud.googleKeySource(), 'server');
  assert.strictEqual(Cloud.dropboxKeySource(), 'server');
}
{
  const Cloud = loadCloud({ serverGoogle: '', serverDropbox: '' });
  assert.strictEqual(Cloud.isGoogleConfigured(), false);
  assert.strictEqual(Cloud.isDropboxConfigured(), false);
  assert.strictEqual(Cloud.googleKeySource(), '');
}

(async () => {
  // Per-user key + mocked upload/list/download using user Dropbox key
  {
    const files = new Map();
    let revoked = false;
    const Cloud = loadCloud({
      serverDropbox: '',
      fetchImpl: async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/files/upload')) {
          const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
          const text = opts.body && opts.body._parts ? opts.body._parts.join('') : String(opts.body || '');
          files.set(arg.path, text);
          return {
            ok: true,
            json: async () => ({
              name: arg.path.replace(/^\//, ''),
              path_display: arg.path,
              server_modified: '2026-10-20T13:00:00Z',
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
                server_modified: '2026-10-20T13:00:00Z',
              })),
            }),
          };
        }
        if (u.includes('/files/download')) {
          const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
          return { ok: true, text: async () => files.get(arg.path) || '' };
        }
        if (u.includes('/auth/token/revoke')) {
          revoked = true;
          return { ok: true, json: async () => ({}) };
        }
        if (u.includes('/users/get_current_account')) {
          return { ok: true, json: async () => ({ email: 'user@example.com', name: { display_name: 'User' } }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    Cloud.setAccountScope('alice@example.com');
    Cloud.setUserProviderKeys({ dropboxAppKey: 'aliceappkey12' });
    assert.strictEqual(Cloud.isDropboxConfigured(), true);
    assert.strictEqual(Cloud.dropboxKeySource(), 'user');
    Cloud.writePrefs({
      dropboxConnected: true,
      dropboxAccessToken: 'sl.alice',
      dropboxTokenExpiresAt: Date.now() + 3600_000,
    });
    const original = { format: 'deeperguard-backup-v1', items: [{ item_uuid: 'u1', ciphertext: '{}' }] };
    const blob = Cloud.backupBlobFromObject(original);
    await Cloud.uploadDropboxBackupBlob(blob, { filename: 'deeperguard-backup-2026-10-20.dgbackup' });
    const listed = await Cloud.listDropboxBackups({ limit: 5 });
    assert.strictEqual(listed.length, 1);
    const text = await Cloud.downloadDropboxBackup('/deeperguard-backup-2026-10-20.dgbackup');
    assert.deepStrictEqual(JSON.parse(text), original);

    await Cloud.disconnectDropbox();
    assert.ok(revoked);
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, '');
    assert.strictEqual(Cloud.readPrefs().dropboxConnected, false);
  }

  // Two users: tokens/prefs do not leak across account scopes
  {
    const Cloud = loadCloud({ serverDropbox: '' });
    Cloud.setAccountScope('alice@example.com');
    Cloud.setUserProviderKeys({ dropboxAppKey: 'alicekey12345' });
    Cloud.writePrefs({ dropboxAccessToken: 'token-alice', dropboxConnected: true });
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, 'token-alice');

    Cloud.setAccountScope('bob@example.com');
    Cloud.setUserProviderKeys({ dropboxAppKey: 'bobkey6789012' });
    assert.strictEqual(Cloud.dropboxAppKey(), 'bobkey6789012');
    assert.notStrictEqual(Cloud.readPrefs().dropboxAccessToken, 'token-alice');
    Cloud.writePrefs({ dropboxAccessToken: 'token-bob', dropboxConnected: true });
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, 'token-bob');

    Cloud.setAccountScope('alice@example.com');
    assert.strictEqual(Cloud.readPrefs().dropboxAccessToken, 'token-alice');
  }

  // Vault settings round-trip for user keys (via NotesStore saveGlobalSettings)
  {
    const idb = new Map();
    global.addEventListener = () => {};
    global.window = global;
    global.navigator = { onLine: true };
    global.localStorage = {
      store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; },
    };
    global.sessionStorage = {
      store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; },
    };
    global.NotesIDB = {
      async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
      async deleteItem(uuid) { idb.delete(uuid); },
      async loadItems() { return [...idb.values()]; },
      async iterateItems(onRow) { for (const row of idb.values()) onRow(row); },
      async getItem(uuid) { return idb.get(uuid) || null; },
      async putBlob() {},
      async getBlob() { return ''; },
      async deleteBlob() {},
      async getMeta() { return null; },
      async putMeta() {},
    };
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) });
    global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
    vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
    global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
    global.NotesSearch = require(path.join(jsRoot, 'search.js'));
    const NotesStore = require(path.join(jsRoot, 'store.js'));

    await NotesStore.unlock('round44-pass', 'round44-salt');
    NotesStore.markKeyVerified();
    const saved = NotesStore.saveGlobalSettings({
      theme: 'system',
      googleOauthClientId: '123.apps.googleusercontent.com',
      dropboxAppKey: 'mydropboxkey12',
    });
    assert.ok(saved);
    const loaded = NotesStore.getGlobalSettings();
    assert.ok(loaded);
    assert.strictEqual(loaded.prefs.googleOauthClientId, '123.apps.googleusercontent.com');
    assert.strictEqual(loaded.prefs.dropboxAppKey, 'mydropboxkey12');

    // Simulate another device pulling the same settings item after re-encrypt
    const settings = [...NotesStore.state.items.values()].find((i) => i.content?.type === 'settings');
    assert.ok(settings);
    assert.strictEqual(settings.content.prefs.googleOauthClientId, '123.apps.googleusercontent.com');
  }

  console.log('test_round44_user_cloud_keys ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
