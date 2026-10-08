const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');

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
const NotesStore = require(path.join(jsRoot, 'store.js'));

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  const cached = sessionStorage.getItem('notes_kdf_cache');
  assert.ok(cached, 'KDF hint cache should exist after unlock');
  const parsed = JSON.parse(cached);
  assert.strictEqual(parsed.raw, undefined, 'derived key bytes must not be stored');
  assert.strictEqual(parsed.fp, undefined, 'password fingerprint must not be stored in sessionStorage');

  sessionStorage.setItem(
    'notes_kdf_cache',
    JSON.stringify({
      salt,
      version: 1,
      encoding: '',
      fp: 'deadbeef',
      raw: btoa('legacy-derived-key-bytes-should-be-ignored'),
    }),
  );
  NotesStore.lock();
  assert.strictEqual(sessionStorage.getItem('notes_kdf_cache'), null, 'lock clears KDF hints');
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  const after = JSON.parse(sessionStorage.getItem('notes_kdf_cache'));
  assert.strictEqual(after.raw, undefined, 'rewritten cache must not resurrect raw bytes');

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
