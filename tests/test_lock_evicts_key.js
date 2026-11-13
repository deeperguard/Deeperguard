const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();

function memoryStorage() {
  return {
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
}

global.addEventListener = () => {};
global.window = global;
global.localStorage = memoryStorage();
global.sessionStorage = memoryStorage();
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
global.fetch = async () => ({
  ok: true,
  json: async () => ({ items: [], server_time: Date.now() / 1000 }),
});
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
require(path.join(jsRoot, 'vault-secrets.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';
  let derives = 0;
  const realDerive = NotesCrypto.deriveKey;
  NotesCrypto.deriveKey = (...args) => {
    derives += 1;
    return realDerive.apply(NotesCrypto, args);
  };
  NotesCrypto.workerEnabled = () => false;

  assert.strictEqual(NotesStore.adoptDerivedVaultKey, undefined, 'no key-adoption shortcut');

  await NotesStore.unlock('vault-password', salt, { kdfVersion: 2 });
  assert.ok(NotesStore.isUnlocked());
  assert.ok(derives >= 1, 'first unlock runs Argon2id');
  const keyRef = NotesStore.state.cryptoKey;
  const rawRef = keyRef.raw;
  assert.ok(rawRef.some((b) => b !== 0), 'key bytes are live while unlocked');

  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: 'Secret title' });
  clearTimeout(NotesStore.state.saveTimer);
  sessionStorage.setItem('notes_boot_password_enc', 'x');

  NotesStore.lock();
  assert.strictEqual(NotesStore.isUnlocked(), false);
  assert.strictEqual(NotesStore.state.cryptoKey, null);
  assert.strictEqual(NotesStore.state.altCryptoKey, null);
  assert.strictEqual(NotesStore.state.items.size, 0, 'no plaintext notes survive lock');
  assert.ok(rawRef.every((b) => b === 0), 'key bytes are zeroed on lock');
  assert.strictEqual(sessionStorage.getItem('notes_unlocked'), null);
  for (const k of Object.keys(sessionStorage.store)) {
    assert.ok(!k.startsWith('notes_boot_'), `boot stash ${k} must be gone`);
  }
  const blob = JSON.stringify([localStorage.store, sessionStorage.store]);
  assert.ok(!blob.includes('Secret title') && !blob.includes('vault-password'));

  // Same password and salt: no cached key may satisfy the unlock.
  const before = derives;
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 2 });
  assert.ok(derives > before, 'unlock after lock re-runs Argon2id');
  assert.notStrictEqual(NotesStore.state.cryptoKey, keyRef);
  assert.ok(NotesStore.state.cryptoKey.raw.some((b) => b !== 0));

  // A wrong password after lock yields a different key, never the old one.
  const goodHex = Buffer.from(NotesStore.state.cryptoKey.raw).toString('hex');
  NotesStore.lock();
  await NotesStore.unlock('wrong-password', salt, { kdfVersion: 2 });
  assert.notStrictEqual(Buffer.from(NotesStore.state.cryptoKey.raw).toString('hex'), goodHex);
  NotesStore.lock();
  console.log('lock evicts key: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
