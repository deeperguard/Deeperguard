/**
 * Simulated page reload: sessionStorage KDF hints persist; in-memory lastDerivedKdf does not.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const storePath = path.join(jsRoot, 'store.js');

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
  async loadItems() {
    return [];
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

function loadNotesStore() {
  delete require.cache[require.resolve(storePath)];
  return require(storePath);
}

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';
  const password = 'vault-password-reload-test';

  const NotesStore1 = loadNotesStore();
  await NotesStore1.unlock(password, salt, { kdfVersion: 1 });
  assert.ok(NotesStore1.isUnlocked(), 'first unlock');
  const cached = sessionStorage.getItem('notes_kdf_cache');
  assert.ok(cached, 'kdf hint in sessionStorage');
  const parsed = JSON.parse(cached);
  assert.strictEqual(parsed.fp, undefined, 'no fp in sessionStorage');
  assert.strictEqual(parsed.version, 1);

  const saved = { ...sessionStorage.store };
  sessionStorage.store = { ...saved };

  const NotesStore2 = loadNotesStore();
  assert.ok(!NotesStore2.isUnlocked(), 'fresh module starts locked');
  await NotesStore2.unlock(password, salt, { kdfVersion: 1 });
  assert.ok(NotesStore2.isUnlocked(), 'unlock after simulated reload');

  console.log('ok unlock-after-reload');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
