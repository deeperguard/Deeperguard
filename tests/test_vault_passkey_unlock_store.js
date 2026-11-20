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
let pullRows = [];
let pullTotal = 0;
let seenVerifiedDuringPull = [];
let writesDuringPull = [];
let writeDuringPull = true;
let networkDown = false;
// In-memory stand-in for vault-secrets.js: a password left in memory must never be used by a passkey session.
let secretPassword = '';
global.NotesVaultSecrets = {
  getVaultPassword: () => secretPassword,
  setVaultPassword: (pw) => { secretPassword = String(pw || ''); },
  getAccountPassword: () => '',
  setAccountPassword: () => {},
  clearSecrets: () => { secretPassword = ''; },
  clearDevicePassword: () => {},
};
global.fetch = async (url, options = {}) => {
  if (networkDown) throw new TypeError('Failed to fetch');
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
  if (pathUrl.includes('/api/sync/pull')) {
    seenVerifiedDuringPull.push(NotesStore.isKeyVerified());
    if (writeDuringPull) try {
      NotesStore.upsert(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'too early' });
      writesDuringPull.push('allowed');
    } catch (err) {
      writesDuringPull.push('blocked');
    }
    return {
      ok: true,
      json: async () => ({ items: pullRows, total_undeleted: pullTotal, has_more: false, server_time: Date.now() / 1000 }),
    };
  }
  return { ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
global.NotesStore = NotesStore;

async function waitPersist(uuid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const row = idb.get(uuid);
    if (row && row.ciphertext) return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`persist timeout for ${uuid}`);
}


function reset() {
  NotesStore.lock();
  idb.clear();
  fetchCalls.length = 0;
  localStorage.store = {};
  sessionStorage.store = {};
  pullRows = [];
  pullTotal = 0;
  seenVerifiedDuringPull = [];
  writesDuringPull = [];
  writeDuringPull = true;
  networkDown = false;
  NotesStore.state.account = null;
}

// A vault with one note under `password`; returns its key and the ciphertext row the server would hold.
async function makeVault(password, salt) {
  reset();
  await NotesStore.unlock(password, salt, { kdfVersion: 1 });
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: 'Existing note' });
  const row = await waitPersist(id);
  clearTimeout(NotesStore.state.saveTimer);
  const key = NotesStore.vaultKeyCopy();
  const keyId = NotesCrypto.vaultKeyId(key);
  const serverRow = { item_uuid: id, ciphertext: row.ciphertext, deleted: 0, synced_at: 1, updated_at: 1 };
  reset();
  return { key, keyId, serverRow };
}

const copyOf = (key) => ({ raw: new Uint8Array(key.raw) });

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';
  const vault = await makeVault('vault-password', salt);
  const other = await makeVault('a-newer-password', salt);

  // (c) existing notes decrypt before any write is allowed; kdfVersion is the account's value.
  pullRows = [vault.serverRow];
  pullTotal = 1;
  localStorage.setItem('notes_vault_kdf_upgrade_pending', '1');
  localStorage.setItem('notes_vault_kdf_version', '1');
  let res = await NotesStore.unlockWithVaultKey(copyOf(vault.key), {
    wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 2, salt,
  });
  assert.strictEqual(res.via, 'decrypt');
  assert.deepStrictEqual(seenVerifiedDuringPull, [false], 'nothing is verified while the server rows are still being checked');
  assert.deepStrictEqual(writesDuringPull, ['blocked'], 'a write before the key decrypted real data is refused');
  assert.strictEqual(NotesStore.isKeyVerified(), true);
  assert.strictEqual(NotesStore.state.kdfVersion, 2, 'kdfVersion is the account value, never the default 1');
  assert.strictEqual(NotesStore.state.keySource, 'passkey');

  // 2: no wrong KDF hint, pending upgrade kept, no vault-kdf call, no password-derived retry.
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_version'), '1', 'a passkey unlock does not rewrite the local KDF hint');
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_upgrade_pending'), '1');
  assert.strictEqual(await NotesStore.retryPendingVaultKdfUpgrade(), false);
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_upgrade_pending'), '1', 'a pending upgrade survives a passkey session');
  assert.deepStrictEqual((await NotesStore.migrateVaultKdfIfNeeded('', salt)), { migrated: false });
  assert.ok(!fetchCalls.some((c) => c.url.includes('vault-kdf')), 'no KDF upgrade request from a passkey session');

  // A later password unlock is a password session again.
  NotesStore.lock();
  assert.strictEqual(NotesStore.state.keySource, 'password');
  await NotesStore.unlock('vault-password', salt, { kdfVersion: 1 });
  assert.strictEqual(NotesStore.state.keySource, 'password');

  // 3: the key id must match the account's current key id, and a wrap of an earlier key is refused.
  reset();
  pullRows = [vault.serverRow];
  pullTotal = 1;
  await assert.rejects(
    NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: other.keyId, kdfVersion: 2, salt }),
    (err) => err.code === 'VAULT_KEY_STALE' && /master password/.test(err.message),
  );
  assert.strictEqual(NotesStore.isUnlocked(), false);
  assert.ok(!fetchCalls.some((c) => c.url.includes('/api/sync/pull')), 'refused before any server read');

  // (a/b) a valid but old key against notes encrypted under the new key: refused, never writable.
  reset();
  pullRows = [other.serverRow];
  pullTotal = 1;
  await assert.rejects(
    NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 1, salt }),
    (err) => err.code === 'VAULT_KEY_STALE',
  );
  assert.strictEqual(NotesStore.isUnlocked(), false);
  assert.strictEqual(NotesStore.isKeyVerified(), false);
  assert.strictEqual(NotesStore.state.cryptoKey, null, 'the refused key is dropped, so nothing can be written with it');

  // Empty vault: the documented proof (current key id, no notes on the server) verifies it.
  reset();
  res = await NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 2, salt });
  assert.strictEqual(res.via, 'empty');
  assert.strictEqual(NotesStore.isKeyVerified(), true);

  // Notes exist but the pull only shows tombstones: no proof, refused.
  reset();
  pullRows = [{ ...vault.serverRow, deleted: 1 }];
  pullTotal = 2;
  await assert.rejects(
    NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 2, salt }),
    (err) => err.code === 'PROBE_NO_SAMPLE',
  );
  assert.strictEqual(NotesStore.isUnlocked(), false);

  // probeServerKey: a passkey session never derives the other KDF's key from a password that
  // happens to be in memory. Here that password (v1) would open the notes, the passkey key not.
  reset();
  pullRows = [vault.serverRow];
  pullTotal = 1;
  secretPassword = 'vault-password';
  sessionStorage.setItem('notes_salt', salt);
  await assert.rejects(
    NotesStore.unlockWithVaultKey(copyOf(other.key), { wrapKeyId: other.keyId, accountKeyId: other.keyId, kdfVersion: 2, salt }),
    (err) => err.code === 'VAULT_KEY_STALE',
  );
  assert.strictEqual(NotesStore.isUnlocked(), false, 'no password-derived key replaced the refused passkey key');
  assert.strictEqual(NotesStore.isKeyVerified(), false);

  // Sync: rows that do not decrypt after a passkey unlock do not start the password KDF retry.
  reset();
  res = await NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 2, salt });
  assert.strictEqual(res.via, 'empty');
  writeDuringPull = false;
  pullRows = [other.serverRow];
  pullTotal = 1;
  secretPassword = 'a-newer-password';
  sessionStorage.setItem('notes_salt', salt);
  await assert.rejects(NotesStore.sync({ quiet: true }), (err) => err.code === 'DECRYPT_PARTIAL');
  assert.strictEqual(NotesStore.state.keySource, 'passkey', 'sync did not switch to a password-derived key');
  assert.strictEqual(NotesCrypto.vaultKeyId(NotesStore.state.cryptoKey), vault.keyId);
  assert.strictEqual(NotesStore.state.kdfVersion, 2);
  assert.strictEqual(NotesStore.listNotes().length, 0, 'the unreadable row stays unread');
  assert.ok(!fetchCalls.some((c) => c.url.includes('vault-kdf')));

  // Offline: the server check cannot run, so the passkey unlock is refused and the vault stays
  // locked (no offline passkey unlock: the copy is never kept on the device).
  reset();
  networkDown = true;
  await assert.rejects(
    NotesStore.unlockWithVaultKey(copyOf(vault.key), { wrapKeyId: vault.keyId, accountKeyId: vault.keyId, kdfVersion: 2, salt }),
    (err) => err.offline === true,
  );
  assert.strictEqual(NotesStore.isUnlocked(), false);
  assert.strictEqual(NotesStore.isKeyVerified(), false);
  assert.strictEqual(localStorage.getItem('notes_offline_unlock_verified'), null);

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
