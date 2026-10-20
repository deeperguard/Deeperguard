/**
 * Round 41 part 2: encrypted file backup roundtrip, share→download fallback,
 * Drive upload with Google API mocked, Google button hidden when not configured.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const cloudSrc = fs.readFileSync(path.join(root, 'app/static/js/cloud-backup.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');
const configPy = fs.readFileSync(path.join(root, 'app/config.py'), 'utf8');
const legal = fs.readFileSync(path.join(root, 'app/templates/legal.html'), 'utf8');

assert.ok(configPy.includes('GOOGLE_OAUTH_CLIENT_ID'));
assert.ok(authPy.includes('accounts.google.com'));
assert.ok(authPy.includes('www.googleapis.com'));
assert.ok(appHtml.includes('btn-save-backup-file'));
assert.ok(appHtml.includes('btn-backup-google-drive'));
assert.ok(appHtml.includes('restore-backup-file'));
assert.ok(appHtml.includes('On iPhone choose Save to Files'));
assert.ok(appHtml.includes('cloud-backup.js'));
assert.ok(appHtml.includes('google-drive-not-configured'));
assert.ok(appJs.includes('NotesCloudBackup'));
assert.ok(appJs.includes('confirmRestoreBackupChoice'));
assert.ok(appJs.includes('prepareEncryptedBackupBlob'));
assert.ok(appJs.includes('isGoogleConfigured'));
assert.ok(legal.includes('Google Drive'));
assert.ok(legal.includes('iCloud Drive') || legal.includes('Files / iCloud'));

function loadCloud({ clientId = '', canShare = false, shareImpl = null, fetchImpl = null } = {}) {
  const store = new Map();
  const downloads = [];
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
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
        this._parts = parts;
        this.name = name;
        this.type = (opts && opts.type) || '';
        this.size = parts.reduce((n, p) => n + String(p && p.size != null ? p.size : p).length, 0);
      }
    },
    FormData: class FormData {
      constructor() { this.entries = []; }
      append(k, v, n) { this.entries.push([k, v, n]); }
    },
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL() {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      querySelector: (sel) => {
        if (sel === 'meta[name="google-oauth-client-id"]') {
          return { getAttribute: () => clientId };
        }
        return null;
      },
      getElementById: () => ({ dataset: { googleOauthClientId: clientId } }),
      createElement: () => {
        const el = {
          style: {},
          click() { downloads.push({ href: el.href, download: el.download }); },
          remove() {},
          setAttribute() {},
          appendChild() {},
        };
        return el;
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: {
      canShare: canShare ? () => true : undefined,
      share: shareImpl || (async () => {}),
    },
    fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => ({}) })),
    module: { exports: {} },
    exports: {},
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox);
  const Cloud = sandbox.module.exports;
  Cloud.__downloads = downloads;
  Cloud.__store = store;
  return Cloud;
}

// --- backup file roundtrip (create → parse equals original) ---
{
  const Cloud = loadCloud();
  const original = {
    format: 'deeperguard-backup-v1',
    user_email: 'user@example.com',
    kdf_salt: 'abc',
    exported_at: '2026-10-20T12:00:00.000Z',
    items: [
      {
        item_uuid: '11111111-1111-1111-1111-111111111111',
        content_version: 1,
        ciphertext: '{"iv":"aabb","data":"ccdd"}',
        content_hash: 'hash1',
        deleted: false,
        updated_at: 1,
      },
    ],
  };
  const name = Cloud.backupFilename(new Date(Date.UTC(2026, 9, 20)));
  assert.strictEqual(name, 'deeperguard-backup-2026-10-20.dgbackup');
  const blob = Cloud.backupBlobFromObject(original);
  const restored = JSON.parse(blob._parts.join(''));
  assert.deepStrictEqual(restored, original);
}

(async () => {
  // --- share unsupported → download fallback ---
  {
    const Cloud = loadCloud({ canShare: false });
    const blob = Cloud.backupBlobFromObject({ format: 'deeperguard-backup-v1', items: [] });
    const result = await Cloud.saveBackupFile(blob, { filename: 'deeperguard-backup-2026-10-20.dgbackup' });
    assert.strictEqual(result.method, 'download');
    assert.strictEqual(result.filename, 'deeperguard-backup-2026-10-20.dgbackup');
    assert.ok(Cloud.__downloads.length >= 1);
  }

  // share path
  {
    let sharedFiles = null;
    const Cloud = loadCloud({
      canShare: true,
      shareImpl: async (payload) => { sharedFiles = payload.files; },
    });
    const blob = Cloud.backupBlobFromObject({ format: 'deeperguard-backup-v1', items: [] });
    const result = await Cloud.saveBackupFile(blob, { filename: 'deeperguard-backup-2026-10-20.dgbackup' });
    assert.strictEqual(result.method, 'share');
    assert.ok(sharedFiles && sharedFiles.length === 1);
  }

  // Google not configured
  {
    const Cloud = loadCloud({ clientId: '' });
    assert.strictEqual(Cloud.isGoogleConfigured(), false);
  }

  // Drive upload mocked
  {
    const calls = [];
    const Cloud = loadCloud({
      clientId: '123.apps.googleusercontent.com',
      fetchImpl: async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url: String(url), method });
        if (String(url).includes('/upload/drive/v3/files')) {
          return {
            ok: true,
            json: async () => ({
              id: 'file1',
              name: 'deeperguard-backup-2026-10-20.dgbackup',
              modifiedTime: '2026-10-20T12:00:00.000Z',
            }),
          };
        }
        if (method === 'GET' && String(url).includes('/drive/v3/files')) {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ files: [] }),
          };
        }
        if (method === 'POST' && String(url).includes('/drive/v3/files')) {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ id: 'folder1', name: 'Deeperguard Backups' }),
          };
        }
        return { ok: false, status: 404, headers: { get: () => '' }, json: async () => ({}) };
      },
    });
    assert.strictEqual(Cloud.isGoogleConfigured(), true);
    // Bypass GIS: inject token helpers by overwriting on the exported object
    // and calling a local upload that mirrors the module (internals are closed).
    // Exercise uploadBackupBlob by stubbing requestAccessToken via google global.
    Cloud.__store.clear();
    // Directly test list/upload via patched ensure: run vm again with google mock.
  }

  // Re-load with google.accounts mock so uploadBackupBlob works end-to-end.
  {
    const calls = [];
    const store = new Map();
    const sandbox = {
      console,
      Date,
      Math,
      JSON,
      setTimeout,
      clearTimeout,
      Blob: class Blob {
        constructor(parts, opts) {
          this._parts = parts.map((p) => (typeof p === 'string' ? p : String(p)));
          this.type = (opts && opts.type) || '';
          this.size = this._parts.reduce((n, p) => n + p.length, 0);
        }
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
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      document: {
        querySelector: () => ({ getAttribute: () => 'client.apps.googleusercontent.com' }),
        getElementById: () => ({ dataset: {} }),
        createElement: () => ({ click() {}, remove() {}, style: {}, setAttribute() {} }),
        head: { appendChild() {} },
        body: { appendChild() {} },
        querySelectorAll: () => [],
      },
      navigator: {},
      fetch: async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url: String(url), method });
        if (String(url).includes('/upload/drive/v3/files')) {
          return {
            ok: true,
            json: async () => ({
              id: 'file1',
              name: 'deeperguard-backup-2026-10-20.dgbackup',
              modifiedTime: '2026-10-20T12:00:00.000Z',
            }),
          };
        }
        if (method === 'GET') {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ files: [] }),
          };
        }
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ id: 'folder1', name: 'Deeperguard Backups' }),
        };
      },
      module: { exports: {} },
      exports: {},
      google: {
        accounts: {
          oauth2: {
            initTokenClient: ({ callback }) => ({
              requestAccessToken: () => {
                callback({ access_token: 'ya29.test', expires_in: 3600 });
              },
            }),
            revoke: (_t, cb) => cb && cb(),
          },
        },
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(cloudSrc, sandbox);
    const Cloud = sandbox.module.exports;
    const blob = Cloud.backupBlobFromObject({ format: 'deeperguard-backup-v1', items: [] });
    const file = await Cloud.uploadBackupBlob(blob, {
      filename: 'deeperguard-backup-2026-10-20.dgbackup',
    });
    assert.strictEqual(file.id, 'file1');
    assert.ok(calls.some((c) => c.url.includes('/upload/drive/v3/files') && c.method === 'POST'));
    assert.ok(Cloud.readPrefs().lastDriveBackupAt);
    assert.strictEqual(Cloud.readPrefs().lastDriveFileName, 'deeperguard-backup-2026-10-20.dgbackup');
  }

  console.log('test_cloud_backup ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
