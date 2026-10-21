/**
 * Round 51: after sign-out the local vault is empty. A stale server
 * vault_kdf_version=2 must not block unlock of v1-era notes with the correct password.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
const serverRows = [];

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
global.fetch = async (url, options = {}) => {
  const pathUrl = String(url || '');
  if (pathUrl.includes('/api/sync/pull')) {
    return {
      ok: true,
      json: async () => ({
        items: serverRows,
        total_undeleted: serverRows.length,
        has_more: false,
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
  const salt = 'b2c3d4e5f60718293a4b5c6d7e8f90a1';
  const password = 'r19-correct-vault-password';

  // Create v1-era notes (as on older builds).
  await NotesStore.unlock(password, salt, { kdfVersion: 1 });
  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 1 };
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Fifteen notes stand-in' });
  await waitPersist(noteId);
  clearTimeout(NotesStore.state.saveTimer);
  const row = idb.get(noteId);
  serverRows.push({
    item_uuid: noteId,
    ciphertext: row.ciphertext,
    content_hash: row.content_hash || 'h1',
    deleted: false,
    updated_at: row.updated_at || 1,
    synced_at: 1,
  });

  // Sign-out wipes the device; server still reports a stale vault_kdf_version=2
  // (the Round 51 production failure mode for +r19).
  await NotesStore.clearDeviceData();
  NotesStore.lock();
  assert.strictEqual(idb.size, 0, 'device vault cleared');

  NotesStore.state.account = { email: 'r19@example.com', kdf_salt: salt, vault_kdf_version: 2 };
  localStorage.setItem('notes_vault_kdf_version', '2');
  localStorage.setItem('notes_kdf_salt', salt);
  NotesVaultSecrets.setVaultPassword(password);

  await NotesStore.unlock(password, salt);
  assert.strictEqual(NotesStore.state.kdfFastReject, false);
  assert.strictEqual(NotesStore.state.kdfVersion, 2, 'empty device follows the stale server hint first');
  // Node harness marks keyVerified on unlock; browsers stay unverified until decrypt.
  NotesStore.state.keyVerified = false;
  // Hint alone would pick Argon2; server probe must flip to v1.
  const probe = await NotesStore.probeServerKey();
  assert.ok(probe.ok, 'server probe must open v1 notes despite vault_kdf_version=2');
  assert.ok(probe.opened > 0);
  assert.strictEqual(NotesStore.state.kdfVersion, 1, 'verified unlock must settle on v1');
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_version'), '1', 'persist only after verify');

  // Vault ciphertext on the "server" was never rewritten.
  assert.strictEqual(serverRows[0].ciphertext, row.ciphertext);

  // Client guards from Round 50/51.
  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  assert.ok(appJs.includes('deferAutoUnlock'));
  assert.ok(appJs.includes('notes_post_login_unlock'));
  assert.ok(!appJs.includes('if (silent) rejectWrongUnlockPassword()'));

  console.log('test_round51_empty_device_unlock ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
