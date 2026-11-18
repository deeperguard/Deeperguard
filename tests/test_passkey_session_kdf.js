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


let apiCalls = 0;
global.fetch = async () => {
  apiCalls += 1;
  return { ok: true, status: 200, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesVaultSecrets = (() => {
  let pw = '';
  return {
    getVaultPassword: () => pw,
    setVaultPassword: (v) => { pw = String(v || ''); },
    clearSecrets: () => { pw = ''; },
    clearDevicePassword: () => {},
  };
})();

const salt = '74b797214bcbc094863155104fb361bb';
const password = 'passkey-session-password';
const copyOf = (key) => ({ raw: new Uint8Array(key.raw) });

(async () => {
  // The vault key the account really has: Argon2id (kdf 2) from the password.
  const derived = await NotesCrypto.deriveKey(password, salt, { kdfVersion: 2 });
  const accountKey = derived.key || derived;
  const accountKeyId = NotesCrypto.vaultKeyId(accountKey);

  // A copy of an earlier key (valid wrap, wrong key_id for the account) is refused.
  const older = { raw: new Uint8Array(32).fill(9) };
  await assert.rejects(
    NotesStore.unlockWithVaultKey(older, { kdfVersion: 2, salt, accountKeyId }),
    (err) => err.code === 'PASSKEY_COPY_STALE' && /older vault key/.test(err.message),
  );
  assert.strictEqual(NotesStore.isUnlocked(), false);
  assert.strictEqual(NotesStore.isKeyVerified(), false);
  // The account KDF version is required, never defaulted.
  await assert.rejects(NotesStore.unlockWithVaultKey(copyOf(accountKey), { salt, accountKeyId }), /KDF version/);
  assert.strictEqual(NotesStore.isUnlocked(), false);

  // 1. Passkey unlock takes the account's real KDF version; a password change derives from it.
  localStorage.setItem('notes_vault_kdf_version', '2');
  await NotesStore.unlockWithVaultKey(copyOf(accountKey), { kdfVersion: 2, salt, accountKeyId });
  assert.strictEqual(NotesStore.state.kdfVersion, 2);
  assert.strictEqual(NotesStore.isKeyVerified(), true);
  assert.strictEqual(NotesStore.isPasskeySession(), true);
  assert.strictEqual(await NotesStore.verifyVaultPassword(password), true, 'password derived with the session KDF matches the key');
  assert.strictEqual(await NotesStore.verifyVaultPassword('another-password-1'), false);

  // 2. No wrong hint: markKeyVerified keeps the stored server version and a pending upgrade.
  localStorage.setItem('notes_vault_kdf_upgrade_pending', '1');
  NotesStore.markKeyVerified();
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_version'), '2');
  assert.strictEqual(await NotesStore.retryPendingVaultKdfUpgrade(), false);
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_upgrade_pending'), '1');
  NotesStore.lock();
  assert.strictEqual(NotesStore.isPasskeySession(), false);

  // Control: the same state after a password unlock on a v1 hint does drop a stale pending flag.
  await NotesStore.unlock(password, salt, { kdfVersion: 1 });
  assert.strictEqual(NotesStore.isPasskeySession(), false);
  await NotesStore.retryPendingVaultKdfUpgrade();
  assert.strictEqual(localStorage.getItem('notes_vault_kdf_upgrade_pending'), null);
  NotesStore.lock();

  // 4. A v1 account in a passkey session: the lazy KDF upgrade needs the password, so it waits.
  localStorage.removeItem('notes_vault_kdf_migration_complete');
  const v1 = await NotesCrypto.deriveKey(password, salt, { kdfVersion: 1 });
  const v1Key = v1.key || v1;
  await NotesStore.unlockWithVaultKey(copyOf(v1Key), { kdfVersion: 1, salt, accountKeyId: NotesCrypto.vaultKeyId(v1Key) });
  NotesVaultSecrets.setVaultPassword(password);
  apiCalls = 0;
  assert.deepStrictEqual(await NotesStore.migrateVaultKdfIfNeeded(password, salt), { migrated: false });
  assert.strictEqual(apiCalls, 0);
  assert.strictEqual(NotesStore.state.kdfVersion, 1);
  NotesStore.lock();
  console.log('passkey session kdf: ok');
})().catch((err) => { console.error(err); process.exit(1); });
