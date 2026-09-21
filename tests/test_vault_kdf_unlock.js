const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
const fetchCalls = [];

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
};
global.fetch = async (url, options = {}) => {
  const pathUrl = String(url || '');
  let body = null;
  if (options.body) {
    try {
      body = JSON.parse(options.body);
    } catch (err) {
      body = options.body;
    }
  }
  fetchCalls.push({ url: pathUrl, method: options.method || 'GET', body });
  return {
    ok: true,
    json: async () => ({ items: [], server_time: Date.now() / 1000 }),
  };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

async function waitPersist(uuid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const row = idb.get(uuid);
    if (row && row.ciphertext) return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`persist timeout for ${uuid}`);
}

function resetClient() {
  NotesStore.lock();
  idb.clear();
  fetchCalls.length = 0;
  localStorage.store = {};
  sessionStorage.store = {};
  NotesStore.state.account = null;
  NotesStore.state.lastSync = 0;
  NotesStore.state.localReady = false;
}

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';

  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  assert.strictEqual(NotesStore.state.kdfVersion, 1);

  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Keep me' });
  await waitPersist(noteId);
  clearTimeout(NotesStore.state.saveTimer);
  const originalUpdatedAt = NotesStore.get(noteId).updated_at;

  NotesStore.state.account = { vault_kdf_version: 2, kdf_salt: salt };
  localStorage.setItem('notes_vault_kdf_version', '2');
  NotesStore.lock();

  await NotesStore.unlock('vault-password', salt);
  assert.strictEqual(
    NotesStore.state.kdfVersion,
    1,
    'stale server vault_kdf_version=2 must not force Argon2 over v1 notes',
  );
  const opened = await NotesStore.loadLocal();
  assert.ok(opened.opened > 0, 'v1 notes must open with the real password');
  assert.strictEqual(NotesStore.get(noteId).content.title, 'Keep me');

  clearTimeout(NotesStore.state.saveTimer);
  NotesStore.state.pushing = false;
  NotesStore.state.dirty.add(noteId);
  fetchCalls.length = 0;
  await NotesStore.pushDirty({ quiet: true });
  const push = fetchCalls.find((call) => String(call.url).includes('/api/sync/items') && call.method === 'POST');
  assert.ok(push, 'dirty note should push');
  assert.strictEqual(
    push.body.items[0].updated_at,
    originalUpdatedAt,
    'push must keep the item timestamp — Date.now() restamps cause PC↔phone bounce',
  );

  NotesStore.lock();
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  assert.strictEqual(NotesStore.state.kdfVersion, 1, 'explicit v1 must win over server v2');

  resetClient();
  localStorage.setItem('notes_vault_kdf_upgrade_pending', '1');
  NotesStore.state.account = { vault_kdf_version: 2, kdf_salt: salt };
  await NotesStore.unlock('vault-password', salt);
  assert.strictEqual(
    NotesStore.state.kdfVersion,
    1,
    'empty vault + leftover upgrade_pending must not force Argon2',
  );

  resetClient();
  NotesStore.state.account = { vault_kdf_version: 2, kdf_salt: salt };
  await NotesStore.unlock('vault-password', salt);
  assert.strictEqual(
    NotesStore.state.kdfVersion,
    2,
    'empty new account with server v2 should still use Argon2',
  );

  resetClient();
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  const v1a = NotesStore.newUuid();
  const v1b = NotesStore.newUuid();
  NotesStore.upsert(v1a, { ...NotesStore.defaultNote(), title: 'v1-a' });
  NotesStore.upsert(v1b, { ...NotesStore.defaultNote(), title: 'v1-b' });
  await waitPersist(v1a);
  await waitPersist(v1b);
  const { key: v2Key } = await NotesCrypto.deriveKey('vault-password', salt, { kdfVersion: 2 });
  const leftover = NotesStore.newUuid();
  const leftoverPayload = await NotesCrypto.encryptObject(v2Key, {
    ...NotesStore.defaultNote(),
    title: 'v2 leftover',
  });
  idb.set(leftover, {
    uuid: leftover,
    ciphertext: JSON.stringify(leftoverPayload),
    updated_at: 1,
    deleted: false,
  });
  NotesStore.state.account = { vault_kdf_version: 1, kdf_salt: salt };
  localStorage.setItem('notes_vault_kdf_version', '1');
  NotesStore.lock();
  await NotesStore.unlock('vault-password', salt);
  assert.strictEqual(NotesStore.state.kdfVersion, 1, 'majority v1 wins over a leftover v2 blob');
  const mixedOpen = await NotesStore.loadLocal();
  assert.ok(mixedOpen.opened >= 2);
  assert.strictEqual(NotesStore.get(v1a).content.title, 'v1-a');
  assert.strictEqual(NotesStore.get(leftover).content.title, 'v2 leftover', 'alt key must open the leftover v2 item');

  resetClient();
  localStorage.setItem('notes_vault_kdf_upgrade_pending', '1');
  NotesStore.state.account = { vault_kdf_version: 1, kdf_salt: salt };
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 2 });
  fetchCalls.length = 0;
  await NotesStore.sync({ quiet: true });
  assert.ok(
    !fetchCalls.some((call) => String(call.url).includes('/api/account/vault-kdf')),
    'sync must not set vault_kdf_version=2 without v2 ciphertext',
  );
  assert.notStrictEqual(localStorage.getItem('notes_vault_kdf_upgrade_pending'), '1');

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
