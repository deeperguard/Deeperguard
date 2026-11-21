/**
 * A cancelled or superseded NotesStore.unlock must never write key state, must
 * terminate the crypto worker instead of falling back to a main-thread
 * derivation, and a late result must not touch a newer, successful unlock.
 */
const assert = require('assert');
const path = require('path');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');

function memStorage() {
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
global.localStorage = memStorage();
global.sessionStorage = memStorage();
global.NotesIDB = {
  async loadItems() {
    return [];
  },
  async getMeta() {
    return null;
  },
  async putMeta() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

const realCrypto = require(path.join(jsRoot, 'crypto.js'));

// Worker derivations stay pending until the test settles them, like a slow
// Argon2id run. terminateWorker rejects them, as crypto.js does.
const pending = [];
let terminated = 0;
let mainThreadDerives = 0;
global.NotesCrypto = {
  ...realCrypto,
  workerEnabled: () => true,
  deriveKeyInWorker(password) {
    return new Promise((resolve, reject) => {
      pending.push({ password, resolve, reject });
    });
  },
  async deriveKey() {
    mainThreadDerives += 1;
    return { key: { raw: new Uint8Array(32).fill(9) }, encoding: 'raw', version: 2 };
  },
  terminateWorker() {
    terminated += 1;
    pending.splice(0).forEach((job) => job.reject(new Error('crypto worker terminated')));
  },
};

const NotesStore = require(path.join(jsRoot, 'store.js'));

const keyFor = (fill) => ({ key: { raw: new Uint8Array(32).fill(fill) }, encoding: 'raw', version: 2 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const outcome = (promise) => promise.then(() => ({ ok: true }), (err) => ({ ok: false, err }));

(async () => {
  const salt = '74b797214bcbc094863155104fb361bb';

  // 1. Cancel while deriving: rejects with UNLOCK_CANCELLED, worker terminated,
  //    no main-thread fallback, vault stays locked.
  const first = outcome(NotesStore.unlock('pw-one', salt, { kdfVersion: 2 }));
  await tick();
  assert.strictEqual(pending.length, 1, 'first attempt is deriving in the worker');
  assert.strictEqual(NotesStore.cancelUnlock(), true, 'a deriving attempt can be cancelled');
  const r1 = await first;
  assert.ok(!r1.ok && r1.err.code === 'UNLOCK_CANCELLED', 'cancelled unlock rejects');
  assert.strictEqual(terminated, 1, 'worker terminated on cancel');
  assert.strictEqual(mainThreadDerives, 0, 'no main-thread derivation after cancel');
  assert.strictEqual(NotesStore.isUnlocked(), false, 'vault stays locked');
  assert.strictEqual(NotesStore.cancelUnlock(), false, 'nothing left to cancel');

  // 2. A late result of an abandoned attempt does not touch a newer unlock.
  //    Simulate a worker that answers even after terminate (no reject).
  global.NotesCrypto.terminateWorker = () => {
    terminated += 1;
  };
  const stale = outcome(NotesStore.unlock('pw-stale', salt, { kdfVersion: 2 }));
  await tick();
  const staleJob = pending.shift();
  const fresh = outcome(NotesStore.unlock('pw-fresh', salt, { kdfVersion: 2 }));
  await tick();
  const freshJob = pending.shift();
  assert.strictEqual(freshJob.password, 'pw-fresh');
  freshJob.resolve(keyFor(2));
  assert.ok((await fresh).ok, 'second attempt succeeds');
  assert.ok(NotesStore.isUnlocked());
  const epoch = NotesStore.state.lockEpoch;
  staleJob.resolve(keyFor(1));
  const rs = await stale;
  assert.ok(!rs.ok && rs.err.code === 'UNLOCK_CANCELLED', 'superseded attempt rejects');
  assert.ok(NotesStore.isUnlocked(), 'vault still unlocked after the late result');
  assert.strictEqual(NotesStore.state.cryptoKey.raw[0], 2, 'key of the newer attempt kept');
  assert.strictEqual(NotesStore.state.lockEpoch, epoch, 'late result did not lock the vault');

  // 3. lock() during a derivation cancels it: the vault does not open later.
  NotesStore.lock();
  const locked = outcome(NotesStore.unlock('pw-three', salt, { kdfVersion: 2 }));
  await tick();
  const lockedJob = pending.shift();
  NotesStore.lock();
  lockedJob.resolve(keyFor(3));
  const rl = await locked;
  assert.ok(!rl.ok && rl.err.code === 'UNLOCK_CANCELLED');
  assert.strictEqual(NotesStore.isUnlocked(), false, 'lock wins over a pending derivation');

  // 4. A finished unlock can no longer be cancelled.
  const done = NotesStore.unlock('pw-four', salt, { kdfVersion: 2 });
  await tick();
  pending.shift().resolve(keyFor(4));
  await done;
  assert.strictEqual(NotesStore.cancelUnlock(), false);
  assert.strictEqual(NotesStore.state.cryptoKey.raw[0], 4);

  console.log('unlock cancel tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
