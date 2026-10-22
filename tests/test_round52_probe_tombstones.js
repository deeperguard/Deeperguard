/**
 * Round 52: probeServerKey must page past deleted tombstones before proving
 * the vault key. A first pull page of only deleted rows must not mean Wrong password.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
/** Full server catalog ordered by synced_at (tombstones first). */
const serverCatalog = [];

global.addEventListener = () => {};
global.window = global;
global.localStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.sessionStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.NotesIDB = {
  async putItem(row) {
    idb.set(row.uuid, JSON.parse(JSON.stringify(row)));
  },
  async deleteItem(uuid) {
    idb.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async getMeta() {
    return null;
  },
  async putMeta() {},
  async clearAll() {
    idb.clear();
  },
  async iterateItems(fn) {
    for (const row of idb.values()) {
      if (fn(row) === false) break;
    }
  },
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

function rowCursor(row) {
  return Math.max(Number(row.synced_at) || 0, Number(row.updated_at) || 0);
}

global.fetch = async (url, options = {}) => {
  const pathUrl = String(url || '');
  if (pathUrl.includes('/api/sync/pull')) {
    let body = {};
    try {
      body = JSON.parse(options.body || '{}');
    } catch (err) {
      body = {};
    }
    const since = Number(body.since) || 0;
    const after = String(body.after || '');
    const limit = Math.max(1, Number(body.limit) || 8);
    const matched = serverCatalog.filter((row) => {
      const mark = rowCursor(row);
      if (mark > since) return true;
      if (mark === since && after && String(row.item_uuid) > after) return true;
      return false;
    });
    matched.sort((a, b) => {
      const da = rowCursor(a) - rowCursor(b);
      if (da !== 0) return da;
      return String(a.item_uuid).localeCompare(String(b.item_uuid));
    });
    const page = matched.slice(0, limit);
    const live = serverCatalog.filter((row) => row && !row.deleted).length;
    return {
      ok: true,
      json: async () => ({
        items: page,
        total_undeleted: live,
        has_more: matched.length > limit,
        server_time: Date.now() / 1000,
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({ items: [], server_time: Date.now() / 1000 }),
  };
};

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vault-secrets.js'), 'utf8'));

async function waitPersist(uuid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const row = idb.get(uuid);
    if (row && row.ciphertext) return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`persist timeout for ${uuid}`);
}

(async () => {
  const salt = 'c3d4e5f60718293a4b5c6d7e8f90a1b2';
  const password = 'probe-tombstone-local-test-pass';

  await NotesStore.unlock(password, salt, { kdfVersion: 2 });
  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 2 };

  // Live note encrypted with vault KDF v2.
  const liveId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  NotesStore.upsert(liveId, { ...NotesStore.defaultNote(), title: 'live note after tombstones' });
  await waitPersist(liveId);
  clearTimeout(NotesStore.state.saveTimer);
  const liveRow = idb.get(liveId);

  // More than one probe page (limit 20) of tombstones so live notes are on page 2+.
  for (let i = 0; i < 28; i += 1) {
    const tid = `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, '0')}`;
    serverCatalog.push({
      item_uuid: tid,
      ciphertext: JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAA', data: 'deadbeef' }),
      content_hash: `tomb-${i}`,
      deleted: true,
      updated_at: i + 1,
      synced_at: i + 1,
    });
  }
  serverCatalog.push({
    item_uuid: liveId,
    ciphertext: liveRow.ciphertext,
    content_hash: liveRow.content_hash || 'live',
    deleted: false,
    updated_at: 100,
    synced_at: 100,
  });

  await NotesStore.clearDeviceData();
  NotesStore.lock();
  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 2 };
  localStorage.setItem('notes_vault_kdf_version', '2');
  localStorage.setItem('notes_kdf_salt', salt);
  NotesVaultSecrets.setVaultPassword(password);

  await NotesStore.unlock(password, salt, { kdfVersion: 2 });
  NotesStore.state.keyVerified = false;

  const probe = await NotesStore.probeServerKey();
  assert.ok(probe.ok, 'probe must open live note after paging past tombstones');
  assert.ok(probe.opened > 0);
  assert.ok(Number(probe.pages) >= 2, `expected multi-page probe, got pages=${probe.pages}`);
  assert.strictEqual(NotesStore.state.kdfVersion, 2);

  const storeJs = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');
  assert.ok(storeJs.includes('probe-no-sample'));
  assert.ok(storeJs.includes('Tombstones sort first'));
  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  assert.ok(appJs.includes('[notes-unlock] build'));
  assert.ok(appJs.includes('PROBE_NO_SAMPLE'));

  console.log('test_round52_probe_tombstones ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
