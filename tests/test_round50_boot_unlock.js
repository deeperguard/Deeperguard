/**
 * Round 50: v1-era vault + post-login boot unlock regression.
 * Simulates an older account whose notes were created with vault KDF v1,
 * after an SRP verifier upgrade path that must still unlock with the raw password.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();

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
  async iterateItems(fn) {
    for (const row of idb.values()) {
      if (fn(row) === false) break;
    }
  },
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
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const password = 'v1-era-account-password';

  // Create notes the way an older build did (vault KDF v1 / SHA-256).
  await NotesStore.unlock(password, salt, { kdfVersion: 1 });
  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 1 };
  localStorage.setItem('notes_vault_kdf_version', '1');
  localStorage.setItem('notes_kdf_salt', salt);
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Legacy note' });
  await waitPersist(noteId);
  clearTimeout(NotesStore.state.saveTimer);
  NotesStore.lock();

  // Stash boot password the way login does (must clear any leftover BOOT_KDF).
  sessionStorage.setItem('notes_boot_kdf', JSON.stringify({
    iv: 'AAAA',
    data: 'BBBB',
    salt: 'wrong-salt',
    version: 2,
    encoding: 'argon2id',
  }));
  await NotesVaultSecrets.stashBootPassword(password);
  assert.strictEqual(sessionStorage.getItem('notes_boot_kdf'), null, 'stale BOOT_KDF cleared');

  await NotesVaultSecrets.consumeBootPassword();
  const bootPass = NotesVaultSecrets.getVaultPassword();
  assert.strictEqual(bootPass, password);

  // Server still reports vault_kdf_version=1 after SRP upgrade (independent).
  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 1 };
  await NotesStore.unlock(bootPass, salt);
  assert.strictEqual(NotesStore.state.kdfFastReject, false);
  assert.strictEqual(NotesStore.state.kdfVersion, 1);
  const opened = await NotesStore.loadLocal();
  assert.ok(opened.opened > 0, 'v1-era notes must open with the raw login password');
  assert.strictEqual(NotesStore.get(noteId).content.title, 'Legacy note');

  console.log('test_round50_boot_unlock ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
