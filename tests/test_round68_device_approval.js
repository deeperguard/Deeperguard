/**
 * Round 68 Feature C: out-of-band device approval anchors.
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
vm.runInContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'qrcode-generator.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(jsRoot, 'freshness.js'), 'utf8'), sandbox);

const NotesFreshness = sandbox.NotesFreshness;
const NotesCrypto = sandbox.NotesCrypto;
assert.ok(NotesFreshness);
assert.ok(NotesCrypto);
assert.strictEqual(typeof sandbox.qrcode, 'function');

function reset() {
  NotesFreshness.clearMemory();
  NotesFreshness.clearWarnings();
  meta.clear();
  sandbox.localStorage.removeItem('notes_freshness_test');
}

function tipHex(n) {
  return crypto.createHash('sha256').update(String(n)).digest('hex');
}

(async () => {
  const salt = Buffer.from('salt-device-approval-68').toString('base64');
  const { key } = await NotesCrypto.deriveKey('vault-password', salt, { kdfVersion: 1 });

  // --- encode / decode round trip (QR + code) ---
  reset();
  const tip = tipHex('anchor-roundtrip');
  const encoded = NotesFreshness.encodeAnchorPayload({ counter: 7, tip, ts: 1700000000123 });
  assert.strictEqual(encoded.version, 1);
  assert.ok(encoded.qr.startsWith('DGVA1:7:'));
  assert.ok(encoded.code.length > 20);
  assert.ok(!/password|key|plaintext|secret/i.test(JSON.stringify(encoded)));
  assert.ok(['v', 'counter', 'tip', 'ts'].every((f) => encoded.fields.includes(f)));

  const fromQr = NotesFreshness.decodeAnchorPayload(encoded.qr);
  assert.strictEqual(fromQr.ok, true);
  assert.strictEqual(fromQr.anchor.counter, 7);
  assert.strictEqual(fromQr.anchor.tip, tip);
  assert.strictEqual(fromQr.anchor.ts, 1700000000123);

  const fromCode = NotesFreshness.decodeAnchorPayload(encoded.code);
  assert.strictEqual(fromCode.ok, true);
  assert.strictEqual(fromCode.anchor.counter, 7);
  assert.strictEqual(fromCode.anchor.tip, tip);
  assert.strictEqual(fromCode.anchor.ts, 1700000000123);

  // --- checksum rejection ---
  const chars = encoded.code.replace(/-/g, '').split('');
  chars[10] = chars[10] === 'A' ? 'B' : 'A';
  const flipped = chars.join('').replace(/(.{4})/g, '$1-').replace(/-$/, '');
  const badChecksum = NotesFreshness.decodeAnchorPayload(flipped);
  assert.strictEqual(badChecksum.ok, false);
  assert.strictEqual(badChecksum.error, 'checksum');

  // --- unknown version rejection ---
  const badVer = NotesFreshness.decodeAnchorPayload(`DGVA9:1:${tip}:123`);
  assert.strictEqual(badVer.ok, false);
  assert.strictEqual(badVer.error, 'version');

  // --- verification: equal pass ---
  reset();
  NotesFreshness.state.head = {
    counter: 3,
    tip,
    prev_tip: tipHex('prev'),
    prev_counter: 2,
  };
  const equalPayload = NotesFreshness.encodeAnchorPayload({ counter: 3, tip, ts: 1 });
  const equalRes = NotesFreshness.verifyAnchor(equalPayload.code);
  assert.strictEqual(equalRes.ok, true);
  assert.strictEqual(equalRes.matched, 'equal');
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, true);

  // --- verification: higher local + chain link pass ---
  reset();
  const tipA = tipHex('chain-a');
  const tipB = tipHex('chain-b');
  NotesFreshness.state.head = {
    counter: 5,
    tip: tipB,
    prev_tip: tipA,
    prev_counter: 4,
  };
  NotesFreshness.state.headsSeen = [
    { counter: 5, tip: tipB, prev_tip: tipA },
    { counter: 4, tip: tipA, prev_tip: '' },
  ];
  const aheadPayload = NotesFreshness.encodeAnchorPayload({ counter: 4, tip: tipA, ts: 2 });
  const ahead = NotesFreshness.verifyAnchor(aheadPayload.qr);
  assert.strictEqual(ahead.ok, true);
  assert.strictEqual(ahead.matched, 'ahead');

  // --- verification: higher local unlinked → ask fresh code ---
  reset();
  NotesFreshness.state.head = {
    counter: 9,
    tip: tipHex('local-ahead'),
    prev_tip: tipHex('other'),
    prev_counter: 8,
  };
  NotesFreshness.state.headsSeen = [];
  const stale = NotesFreshness.verifyAnchor(
    NotesFreshness.encodeAnchorPayload({ counter: 3, tip: tipHex('unrelated'), ts: 3 }).code,
  );
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.needFresh, true);
  assert.ok(/fresh approval code/i.test(stale.message));
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);

  // --- verification: lower local fails (rollback warning) ---
  reset();
  NotesFreshness.state.head = {
    counter: 2,
    tip: tipHex('old'),
    prev_tip: '',
    prev_counter: 0,
  };
  const lower = NotesFreshness.verifyAnchor(
    NotesFreshness.encodeAnchorPayload({ counter: 8, tip: tipHex('trusted'), ts: 4 }).qr,
  );
  assert.strictEqual(lower.ok, false);
  assert.strictEqual(lower.rollback, true);
  assert.ok(/older version of your vault/i.test(lower.message));
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);
  // Local head must not be overwritten
  assert.strictEqual(NotesFreshness.state.head.counter, 2);

  // --- verification: equal counter, different tip fails ---
  reset();
  NotesFreshness.state.head = {
    counter: 4,
    tip: tipHex('fork-local'),
    prev_tip: '',
    prev_counter: 0,
  };
  const fork = NotesFreshness.verifyAnchor(
    NotesFreshness.encodeAnchorPayload({ counter: 4, tip: tipHex('fork-other'), ts: 5 }).code,
  );
  assert.strictEqual(fork.ok, false);
  assert.strictEqual(fork.rollback, true);
  assert.ok(/older version of your vault/i.test(fork.message));

  // --- e2e: server replays older genuine head to new device ---
  reset();
  const itemsNew = new Map();
  itemsNew.set('n1', { content: { type: 'note', __fv: 1, __fid: 'n1' }, deleted: false });
  const tipOld = await NotesFreshness.computeTip(NotesFreshness.versionsMapFromItems(itemsNew));
  const boot = await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head',
    counter: 1,
    tip: tipOld,
    prev_tip: '',
    prev_counter: 0,
  }, itemsNew);
  assert.strictEqual(boot.unverified, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().showUnverifiedLabel, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startLabel, 'Unverified start');
  // Without anchor stays unverified
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);
  // With anchor from a trusted device at higher counter → rollback warning, not verified
  const trustedTip = tipHex('trusted-head');
  const withAnchor = NotesFreshness.verifyAnchor(
    NotesFreshness.encodeAnchorPayload({ counter: 5, tip: trustedTip, ts: 6 }).qr,
  );
  assert.strictEqual(withAnchor.ok, false);
  assert.strictEqual(withAnchor.rollback, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);

  // --- vault changes between QR show and scan (local ahead, linked) ---
  reset();
  const tip0 = tipHex('qr-show');
  const tip1 = tipHex('after-edit');
  NotesFreshness.state.startVerified = true;
  NotesFreshness.state.head = {
    counter: 2,
    tip: tip0,
    prev_tip: '',
    prev_counter: 0,
  };
  const shown = NotesFreshness.buildApprovalPayload();
  // Local device advanced after QR was shown
  NotesFreshness.state.head = {
    counter: 3,
    tip: tip1,
    prev_tip: tip0,
    prev_counter: 2,
  };
  NotesFreshness.state.headsSeen = [
    { counter: 3, tip: tip1, prev_tip: tip0 },
    { counter: 2, tip: tip0, prev_tip: '' },
  ];
  NotesFreshness.state.startVerified = false;
  NotesFreshness.state.startStatus = 'unverified';
  const afterMove = NotesFreshness.verifyAnchor(shown.qr);
  assert.strictEqual(afterMove.ok, true, 'linked ahead of shown QR still verifies');
  assert.strictEqual(afterMove.matched, 'ahead');

  // --- skip label persists across reload; re-run from Settings ---
  reset();
  NotesFreshness.setCryptoKey(key);
  await NotesFreshness.evaluateRemoteHead({
    type: 'vault_head',
    counter: 1,
    tip: tipHex('skip-persist'),
    prev_tip: '',
    prev_counter: 0,
  }, new Map());
  NotesFreshness.skipStartVerification();
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startSkipped, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().needsStartConfirm, false);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().showUnverifiedLabel, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startLabel, 'Unverified start');
  await NotesFreshness.persistNow(key);
  NotesFreshness.clearMemory();
  await NotesFreshness.load(key);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startSkipped, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, false);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startLabel, 'Unverified start');
  NotesFreshness.reopenStartVerification();
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startSkipped, false);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().needsStartConfirm, true);

  // --- only verified device can approve; payload has no secrets ---
  reset();
  NotesFreshness.state.head = { counter: 1, tip: tipHex('x'), prev_tip: '', prev_counter: 0 };
  NotesFreshness.state.startVerified = false;
  assert.throws(() => NotesFreshness.buildApprovalPayload(), /verified device/i);
  NotesFreshness.state.startVerified = true;
  const approval = NotesFreshness.buildApprovalPayload();
  const blob = JSON.stringify(approval);
  assert.ok(!/password|cryptoKey|plaintext|secret|argon/i.test(blob));
  assert.ok(approval.qr.includes(approval.tip));
  assert.ok(typeof sandbox.qrcode === 'function');
  const dataUrl = NotesFreshness.renderApprovalQrDataUrl(approval);
  assert.ok(dataUrl.startsWith('data:image/'));

  // --- backup anchor ---
  reset();
  const bak = NotesFreshness.anchorFromBackup({
    type: 'vault_head',
    counter: 11,
    tip: tipHex('backup'),
    prev_tip: '',
    prev_counter: 0,
    updated_at: '2026-03-15T12:00:00.000Z',
  }, '2026-03-15');
  assert.strictEqual(bak.ok, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startStatus, 'anchored_backup');
  assert.ok(/Anchored to backup from 2026-03-15/.test(NotesFreshness.getPublicSnapshot().startLabel));

  // --- grandfather existing Feature A devices as verified ---
  reset();
  NotesFreshness.setCryptoKey(key);
  // Simulate pre-Feature-C ciphertext (no startVerified field)
  const legacyPayload = await NotesCrypto.encryptObject(key, {
    hwm: { n: { v: 1, hash: 'h' } },
    head: { counter: 2, tip: tipHex('legacy'), prev_tip: '', prev_counter: 0 },
    headsSeen: [],
  });
  await sandbox.NotesIDB.putMeta(NotesFreshness.META_KEY, { payload: legacyPayload, updated_at: 1 });
  await NotesFreshness.load(key);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().canApproveDevice, true);

  // --- Feature A rollback message must not regress ---
  reset();
  NotesFreshness.noteAccepted('n', { type: 'note', __fv: 5, __fid: 'n' }, 'h5');
  const rb = NotesFreshness.checkIncoming('n', { type: 'note', __fv: 2, __fid: 'n' }, 'h2');
  assert.strictEqual(rb.reject, true);
  assert.strictEqual(rb.warning.message, 'The server returned an older version of this item.');

  // --- locally authored first head is verified (first device of an account) ---
  reset();
  await NotesFreshness.commitLocalHead(new Map([
    ['a', { content: { type: 'note', __fv: 1, __fid: 'a' }, deleted: false }],
  ]));
  assert.strictEqual(NotesFreshness.getPublicSnapshot().startVerified, true);
  assert.strictEqual(NotesFreshness.getPublicSnapshot().canApproveDevice, true);

  // --- UI / verify contracts ---
  const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
  assert.ok(appHtml.includes('Approve a new device'));
  assert.ok(appHtml.includes('btn-approve-new-device'));
  assert.ok(appHtml.includes('device-start-banner'));
  assert.ok(appHtml.includes('Confirm this device is up to date'));
  assert.ok(appHtml.includes("asset_script('js/vendor/qrcode-generator.js')"));
  assert.ok(appHtml.includes('btn-device-start-skip'));
  assert.ok(appHtml.includes('Unverified start'));
  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  assert.ok(appJs.includes('buildApprovalPayload'));
  assert.ok(appJs.includes('skipStartVerification'));
  assert.ok(appJs.includes('startDeviceStartQrScan'));
  assert.ok(appJs.includes('getUserMedia'), 'camera only after Scan QR tap');
  const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
  assert.ok(verify.includes('Device approval'));
  assert.ok(verify.includes('out-of-band'));
  assert.ok(/Pre-bootstrap history[\s\S]*trusted/.test(verify));
  const storeJs = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');
  assert.ok(storeJs.includes('anchorFromBackup'));
  // MUST NOT REGRESS Feature A demo string
  assert.ok(appJs.includes('confirmIntentionalFreshnessReset') || storeJs.includes('resetFreshness'));
  assert.ok(fs.readFileSync(path.join(jsRoot, 'freshness.js'), 'utf8')
    .includes('The server returned an older version of this item.'));

  console.log('test_round68_device_approval ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
