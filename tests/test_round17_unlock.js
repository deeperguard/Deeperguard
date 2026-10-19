const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
const fetchCalls = [];
let pullBody = { items: [], total_undeleted: 0 };

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
  let body = null;
  if (options.body) {
    try { body = JSON.parse(options.body); } catch (err) { body = options.body; }
  }
  fetchCalls.push({ url: String(url || ''), method: options.method || 'GET', body });
  const payload = String(url || '').includes('/api/sync/pull') ? pullBody : { items: [] };
  return {
    ok: true,
    headers: { get() { return null; } },
    json: async () => payload,
  };
};

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

const salt = '74b797214bcbc094863155104fb361bb';

async function waitPersist(uuid) {
  for (let i = 0; i < 40; i += 1) {
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
  pullBody = { items: [], total_undeleted: 0 };
  NotesStore.state.account = { vault_kdf_version: 1, kdf_salt: salt };
  NotesStore.state.lastSync = 0;
  NotesStore.state.localReady = false;
}

async function browserUnlock(password) {
  await NotesStore.unlock(password, salt, { kdfVersion: 1 });
  // Browsers leave the key unverified. Node's harness shortcut must not hide that.
  NotesStore.state.keyVerified = false;
}

(async () => {
  resetClient();
  await browserUnlock('vault-password');
  const empty = await NotesStore.probeServerKey();
  assert.strictEqual(empty.ok, false, 'empty server vault must not count as proof');
  assert.strictEqual(empty.empty, true);
  assert.strictEqual(NotesStore.isKeyVerified(), false);
  assert.strictEqual(NotesStore.state.keyVerified, false);

  const other = await NotesCrypto.deriveKey('other-password', salt, { version: 1 });
  const wrongPayload = await NotesCrypto.encryptObject(other.key, {
    type: 'note',
    title: 'not yours',
    content: '',
  });
  pullBody = {
    items: [{ ciphertext: JSON.stringify(wrongPayload), deleted: false }],
    total_undeleted: 1,
  };
  const wrong = await NotesStore.probeServerKey();
  assert.strictEqual(wrong.wrongKey, true);
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(NotesStore.isKeyVerified(), false, 'a mismatched server row must stay locked');

  const goodPayload = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, {
    type: 'note',
    title: 'Server note',
    content: '',
  });
  pullBody = {
    items: [{ ciphertext: JSON.stringify(goodPayload), deleted: false }],
    total_undeleted: 1,
  };
  const opened = await NotesStore.probeServerKey();
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(NotesStore.isKeyVerified(), true, 'a decrypted server row proves the key');

  NotesStore.state.keyVerified = false;
  assert.throws(
    () => NotesStore.upsert(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'nope' }),
    /correct vault password/,
  );
  NotesStore.state.dirty.add('pending-write');
  fetchCalls.length = 0;
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), false);
  assert.ok(
    !fetchCalls.some((call) => String(call.url).includes('/api/sync')),
    'an unverified key must not reach a sync write',
  );

  resetClient();
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  const kept = NotesStore.newUuid();
  NotesStore.upsert(kept, { ...NotesStore.defaultNote(), title: 'keep local' });
  await waitPersist(kept);
  const before = idb.size;
  NotesStore.lock();
  await NotesStore.unlock('wrong-password', salt, { kdfVersion: 1 });
  assert.strictEqual(NotesStore.state.kdfFastReject, false, 'explicit version still derives; the probe must reject');
  NotesStore.state.keyVerified = false;
  const stillThere = idb.get(kept);
  assert.ok(stillThere && stillThere.ciphertext, 'a failed unlock must not delete local ciphertext');
  assert.strictEqual(idb.size, before);
  const missed = await NotesStore.probeServerKey();
  assert.strictEqual(missed.ok, false);
  assert.strictEqual(NotesStore.isKeyVerified(), false);
  assert.ok(idb.get(kept).ciphertext, 'probe must not wipe the local vault');

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
