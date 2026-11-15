/**
 * Round 63 Feature A: sync freshness — rollback, freeze, fork, migration.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');

function makeStorage() {
  const store = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

const meta = new Map();
const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Array,
  Object,
  Map,
  Set,
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  Error,
  clearTimeout,
  setTimeout,
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  location: { search: '' },
  crypto: {
    subtle: {
      digest: async (algo, data) => {
        assert.strictEqual(algo, 'SHA-256');
        return crypto.createHash('sha256').update(Buffer.from(data)).digest();
      },
    },
    getRandomValues(buf) {
      const bytes = crypto.randomBytes(buf.length);
      buf.set(bytes);
      return buf;
    },
  },
  NotesIDB: {
    async getMeta(key) { return meta.has(key) ? meta.get(key) : null; },
    async putMeta(key, value) { meta.set(key, value); },
  },
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'), sandbox);
vm.runInContext(
  fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-argon2.js'), 'utf8') + ';this.NobleArgon2=NobleArgon2;',
  sandbox,
);
vm.runInContext(fs.readFileSync(path.join(jsRoot, 'crypto.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(jsRoot, 'freshness.js'), 'utf8'), sandbox);

const NotesFreshness = sandbox.NotesFreshness;
const NotesCrypto = sandbox.NotesCrypto;
assert.ok(NotesFreshness);
assert.ok(NotesCrypto);

function reset() {
  NotesFreshness.clearMemory();
  NotesFreshness.clearWarnings();
  meta.clear();
  sandbox.localStorage.removeItem('notes_freshness_test');
}

(async () => {
  const salt = Buffer.from('salt-freshness-63').toString('base64');
  const { key } = await NotesCrypto.deriveKey('vault-password', salt, { kdfVersion: 1 });

  // --- migration of unversioned items ---
  reset();
  const migrated = NotesFreshness.annotateDecrypted('note-a', { type: 'note', title: 'Hi', content: 'body' });
  assert.strictEqual(migrated.__fv, 0);
  assert.strictEqual(migrated.__fid, 'note-a');
  const stamped = NotesFreshness.stampForUpsert('note-a', migrated, { bump: true });
  assert.strictEqual(stamped.__fv, 1, 'first real edit after migration bumps 0 → 1');

  // --- rollback rejected ---
  reset();
  NotesFreshness.noteAccepted('note-a', { type: 'note', __fv: 3, __fid: 'note-a' }, 'hash-v3');
  const rollback = NotesFreshness.checkIncoming(
    'note-a',
    { type: 'note', __fv: 1, __fid: 'note-a', title: 'old' },
    'hash-v1',
  );
  assert.strictEqual(rollback.reject, true);
  assert.ok(/older version/i.test(rollback.warning.message));
  assert.strictEqual(NotesFreshness.getHwm('note-a').v, 3, 'HWM unchanged after reject');

  // --- version bump before push: drop stale ciphertext hash (agenda pack edits) ---
  reset();
  NotesFreshness.noteAccepted('pack-a', { type: 'agenda_pack', __fv: 1, __fid: 'pack-a' }, 'cipher-v1');
  NotesFreshness.noteAccepted('pack-a', { type: 'agenda_pack', __fv: 2, __fid: 'pack-a' }, '');
  assert.strictEqual(NotesFreshness.getHwm('pack-a').v, 2);
  assert.strictEqual(NotesFreshness.getHwm('pack-a').hash, '');
  const echo = NotesFreshness.checkIncoming(
    'pack-a',
    { type: 'agenda_pack', __fv: 2, __fid: 'pack-a' },
    'cipher-v2-after-push',
  );
  assert.strictEqual(echo.reject, false, 'no false fork on first known hash for bumped version');

  // --- same version different hash → item fork ---
  reset();
  NotesFreshness.noteAccepted('note-a', { type: 'note', __fv: 2, __fid: 'note-a' }, 'hash-a');
  const itemFork = NotesFreshness.checkIncoming(
    'note-a',
    { type: 'note', __fv: 2, __fid: 'note-a', title: 'other' },
    'hash-b',
  );
  assert.strictEqual(itemFork.reject, true);
  assert.ok(/fork/i.test(itemFork.warning.message));

  // --- aggregation: 1000 forks in one round → exactly one fork warning (count 1000) ---
  reset();
  const origWarn = sandbox.console;
  const consoleLines = [];
  sandbox.console = { ...console, warn: (...args) => consoleLines.push(args) };
  let emits = 0;
  const offEmit = NotesFreshness.onChange(() => { emits += 1; });
  for (let i = 0; i < 1000; i += 1) {
    NotesFreshness.noteAccepted(`f-${i}`, { type: 'note', __fv: 2, __fid: `f-${i}` }, `hash-a-${i}`);
  }
  emits = 0;
  NotesFreshness.beginRound();
  for (let i = 0; i < 1000; i += 1) {
    const r = NotesFreshness.checkIncoming(`f-${i}`, { type: 'note', __fv: 2, __fid: `f-${i}` }, `hash-b-${i}`);
    assert.strictEqual(r.reject, true, 'every fork item is still rejected');
    assert.strictEqual(r.ok, false);
  }
  NotesFreshness.endRound();
  offEmit();
  sandbox.console = origWarn;
  let snap = NotesFreshness.getPublicSnapshot();
  let forks = NotesFreshness.state.warnings.filter((w) => w.type === NotesFreshness.WARN_TYPES.fork);
  assert.strictEqual(forks.length, 1, 'one fork warning per round');
  assert.strictEqual(forks[0].detail.count, 1000);
  assert.strictEqual(forks[0].message, '1000 items: the server returned a different copy at the same version (possible fork).');
  assert.strictEqual(forks[0].detail.uuids.length, 1000, 'item ids kept for diagnosis');
  assert.strictEqual(forks[0].detail.uuids[999], 'f-999');
  assert.strictEqual(snap.warnings[0], forks[0], 'bundled warning surfaces on top');
  assert.strictEqual(emits, 1, 'UI notified once, at the end of the round');
  assert.strictEqual(consoleLines.length, 1, 'ids logged once to console');
  assert.ok(/fork: 1000 item/.test(consoleLines[0][0]));
  assert.ok(!JSON.stringify(forks[0]).includes('hash-b'), 'no content hashes or content in the warning');

  // --- a single real fork in a round still gives a visible warning with count 1 ---
  reset();
  NotesFreshness.noteAccepted('solo', { type: 'note', __fv: 4, __fid: 'solo' }, 'hash-a');
  NotesFreshness.beginRound();
  const solo = NotesFreshness.checkIncoming('solo', { type: 'note', __fv: 4, __fid: 'solo' }, 'hash-b');
  NotesFreshness.endRound();
  assert.strictEqual(solo.reject, true);
  snap = NotesFreshness.getPublicSnapshot();
  assert.strictEqual(snap.warningCount, 1);
  assert.strictEqual(snap.warnings[0].type, 'fork');
  assert.strictEqual(snap.warnings[0].detail.count, 1);
  assert.strictEqual(snap.warnings[0].message, '1 item: the server returned a different copy at the same version (possible fork).');

  // --- interleaved forks and rollbacks: counted and shown separately ---
  reset();
  for (let i = 0; i < 10; i += 1) {
    NotesFreshness.noteAccepted(`m-${i}`, { type: 'note', __fv: 5, __fid: `m-${i}` }, `hash-a-${i}`);
  }
  NotesFreshness.beginRound();
  for (let i = 0; i < 10; i += 1) {
    // even → fork (same version, other hash), odd → rollback (older version)
    const content = { type: 'note', __fv: i % 2 === 0 ? 5 : 3, __fid: `m-${i}` };
    const r = NotesFreshness.checkIncoming(`m-${i}`, content, `hash-b-${i}`);
    assert.strictEqual(r.reject, true);
    if (i === 4) {
      // Unrelated warning in the middle of the round must not split the bundles.
      NotesFreshness.pushWarning(NotesFreshness.WARN_TYPES.integrity, 'corrupted', { uuid: 'x' });
    }
  }
  NotesFreshness.endRound();
  let all = NotesFreshness.state.warnings;
  forks = all.filter((w) => w.type === 'fork');
  let rollbacks = all.filter((w) => w.type === 'rollback');
  assert.strictEqual(forks.length, 1, 'one fork warning despite interleaving');
  assert.strictEqual(rollbacks.length, 1, 'one rollback warning despite interleaving');
  assert.strictEqual(forks[0].detail.count, 5);
  assert.strictEqual(rollbacks[0].detail.count, 5);
  assert.deepStrictEqual([...forks[0].detail.uuids], ['m-0', 'm-2', 'm-4', 'm-6', 'm-8']);
  assert.deepStrictEqual([...rollbacks[0].detail.uuids], ['m-1', 'm-3', 'm-5', 'm-7', 'm-9']);
  assert.strictEqual(rollbacks[0].message, '5 items: the server returned an older version.');
  assert.strictEqual(all.length, 3);

  // --- two rounds are not merged; nested begin/end stays one round ---
  NotesFreshness.beginRound();
  NotesFreshness.beginRound(); // nested (e.g. sync → pull retry)
  NotesFreshness.checkIncoming('m-0', { type: 'note', __fv: 5, __fid: 'm-0' }, 'hash-c');
  NotesFreshness.endRound();
  NotesFreshness.checkIncoming('m-2', { type: 'note', __fv: 5, __fid: 'm-2' }, 'hash-c');
  NotesFreshness.endRound();
  all = NotesFreshness.state.warnings;
  forks = all.filter((w) => w.type === 'fork');
  assert.strictEqual(forks.length, 2, 'second round gets its own fork warning');
  assert.strictEqual(forks[0].detail.count, 2, 'nested round counted as one round');
  assert.strictEqual(forks[1].detail.count, 5, 'previous round count unchanged');
  rollbacks = all.filter((w) => w.type === 'rollback');
  assert.strictEqual(rollbacks.length, 1);

  // --- clearWarnings mid-round does not lose the fork ---
  reset();
  NotesFreshness.noteAccepted('c-1', { type: 'note', __fv: 1, __fid: 'c-1' }, 'hash-a');
  NotesFreshness.beginRound();
  NotesFreshness.checkIncoming('c-1', { type: 'note', __fv: 1, __fid: 'c-1' }, 'hash-b');
  NotesFreshness.clearWarnings();
  NotesFreshness.endRound();
  assert.strictEqual(NotesFreshness.state.warnings.filter((w) => w.type === 'fork').length, 1);

  // --- outside a round each fork stays its own visible warning ---
  reset();
  NotesFreshness.noteAccepted('o-1', { type: 'note', __fv: 1, __fid: 'o-1' }, 'hash-a');
  const loose = NotesFreshness.checkIncoming('o-1', { type: 'note', __fv: 1, __fid: 'o-1' }, 'hash-b');
  assert.strictEqual(loose.reject, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().warnings[0].detail.count, 1);

  // --- bind mismatch ---
  reset();
  const bind = NotesFreshness.checkIncoming(
    'note-a',
    { type: 'note', __fv: 1, __fid: 'note-OTHER' },
    'h',
  );
  assert.strictEqual(bind.reject, true);

  // --- deletes do not alarm ---
  reset();
  NotesFreshness.noteAccepted('note-a', { type: 'note', __fv: 2, __fid: 'note-a' }, 'h');
  const del = NotesFreshness.checkIncoming('note-a', null, '', { isDelete: true });
  assert.strictEqual(del.reject, false);
  NotesFreshness.noteAccepted('note-a', null, '', { deleted: true });
  assert.strictEqual(NotesFreshness.getHwm('note-a'), null);

  // --- byte-flip / integrity: missing content object ---
  reset();
  const bad = NotesFreshness.checkIncoming('note-a', null, 'x');
  assert.strictEqual(bad.reject, true);
  assert.ok(/corrupted|integrity/i.test(bad.warning.message));

  // Real AES-GCM byte-flip must fail decrypt (not displayable).
  const enc = await NotesCrypto.encryptObject(key, { type: 'note', title: 'ok', __fv: 1, __fid: 'n1' });
  const flipped = { ...enc, data: enc.data.slice(0, -4) + (enc.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  await assert.rejects(() => NotesCrypto.decryptObject(key, flipped));

  // --- new device adopts first head as Unverified start (Feature C) ---
  reset();
  const items = new Map();
  items.set('n1', { content: { type: 'note', __fv: 1, __fid: 'n1' }, deleted: false });
  const tip1 = await NotesFreshness.computeTip(NotesFreshness.versionsMapFromItems(items));
  const first = await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head',
    counter: 1,
    tip: tip1,
    prev_tip: '',
    prev_counter: 0,
  }, items);
  assert.strictEqual(first.bootstrap, true);
  assert.strictEqual(first.unverified, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().counter, 1);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().showUnverifiedLabel, true);

  // --- freeze: older unknown head ---
  const freeze = await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head',
    counter: 0,
    tip: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    prev_tip: '',
    prev_counter: 0,
  }, items);
  assert.strictEqual(freeze.ok, false);
  assert.ok(/freeze|older vault head/i.test(freeze.warning.message));

  // --- legitimate concurrency (same parent) → no fork warning ---
  reset();
  NotesFreshness.clearWarnings();
  const mapA = new Map();
  mapA.set('a', { content: { type: 'note', __fv: 1, __fid: 'a' }, deleted: false });
  mapA.set('b', { content: { type: 'note', __fv: 0, __fid: 'b' }, deleted: false });
  const tipParent = await NotesFreshness.computeTip({ a: 0, b: 0 });
  const tipA = await NotesFreshness.computeTip({ a: 1, b: 0 });
  const tipB = await NotesFreshness.computeTip({ a: 0, b: 1 });
  await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head', counter: 1, tip: tipA, prev_tip: tipParent, prev_counter: 0,
  }, mapA);
  // Simulate local head at tipA; remote sibling tipB same counter / same parent.
  NotesFreshness.state.head = {
    counter: 1, tip: tipA, prev_tip: tipParent, prev_counter: 0,
  };
  const merged = new Map();
  merged.set('a', { content: { type: 'note', __fv: 1, __fid: 'a' }, deleted: false });
  merged.set('b', { content: { type: 'note', __fv: 1, __fid: 'b' }, deleted: false });
  const concurrent = await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head', counter: 1, tip: tipB, prev_tip: tipParent, prev_counter: 0,
  }, merged);
  assert.strictEqual(concurrent.ok, true);
  assert.strictEqual(concurrent.concurrent, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().warningCount, 0, 'no false fork on concurrency');

  // --- malicious fork: same counter, unrelated parents ---
  reset();
  NotesFreshness.state.head = {
    counter: 5,
    tip: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    prev_tip: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    prev_counter: 4,
  };
  const fork = await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head',
    counter: 5,
    tip: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    prev_tip: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    prev_counter: 4,
  }, new Map());
  assert.strictEqual(fork.ok, false);
  assert.ok(/fork/i.test(fork.warning.message));

  // --- intentional restore resets HWM ---
  reset();
  NotesFreshness.setCryptoKey(key);
  NotesFreshness.noteAccepted('note-a', { type: 'note', __fv: 4, __fid: 'note-a' }, 'h');
  await NotesFreshness.persistNow(key);
  await NotesFreshness.resetAfterIntentionalRestore(key);
  assert.strictEqual(NotesFreshness.getHwm('note-a'), null);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().counter, 0);

  // --- encrypted persist round-trip ---
  reset();
  NotesFreshness.setCryptoKey(key);
  NotesFreshness.noteAccepted('x', { type: 'note', __fv: 2, __fid: 'x' }, 'hx');
  await NotesFreshness.commitLocalHead(new Map([
    ['x', { content: { type: 'note', __fv: 2, __fid: 'x' }, deleted: false }],
  ]));
  await NotesFreshness.persistNow(key);
  const row = meta.get(NotesFreshness.META_KEY);
  assert.ok(row && row.payload && row.payload.iv, 'freshness meta is ciphertext envelope');
  assert.ok(!JSON.stringify(row).includes('"hwm"'), 'no plaintext HWM in meta row');
  NotesFreshness.clearMemory();
  await NotesFreshness.load(key);
  assert.strictEqual(NotesFreshness.getHwm('x').v, 2);

  // --- test hook gated ---
  reset();
  assert.throws(() => NotesFreshness.testInjectRollbackScenario('n', 9));
  sandbox.localStorage.setItem('notes_freshness_test', '1');
  const injected = NotesFreshness.testInjectRollbackScenario('n', 9);
  assert.strictEqual(injected.v, 9);

  // --- normal accept newer version ---
  reset();
  NotesFreshness.noteAccepted('n', { type: 'note', __fv: 1, __fid: 'n' }, 'h1');
  const ok = NotesFreshness.checkIncoming('n', { type: 'note', __fv: 2, __fid: 'n' }, 'h2');
  assert.strictEqual(ok.reject, false);
  NotesFreshness.noteAccepted('n', { type: 'note', __fv: 2, __fid: 'n' }, 'h2');
  assert.strictEqual(NotesFreshness.getHwm('n').v, 2);

  // --- UI / verify contracts ---
  const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
  assert.ok(appHtml.includes("asset_script('js/freshness.js')"));
  assert.ok(appHtml.includes('vault-freshness-panel'));
  assert.ok(appHtml.includes('btn-compare-vault-head'));
  const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
  assert.ok(verify.includes('data-claim-version="2"'));
  assert.ok(verify.includes('Sync freshness'));
  assert.ok(verify.includes('Unverified start'));
  assert.ok(verify.includes('No new server-visible fields'));
  assert.ok(verify.includes('Pre-bootstrap history'));
  assert.ok(verify.includes('out-of-band'));
  const storeJs = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');
  assert.ok(storeJs.includes('NotesFreshness.checkIncoming'));
  assert.ok(storeJs.includes('refreshVaultHead'));
  assert.ok(storeJs.includes('resetFreshness'));
  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  assert.ok(appJs.includes('confirmIntentionalFreshnessReset'));
  assert.ok(appJs.includes('wireFreshnessWarnings'));

  console.log('test_sync_freshness ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
