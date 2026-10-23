/**
 * Round 71 Part A/B: mint device id on SRP postJson; device list UI;
 * online recovery force-sync on attempt 0; Feature C approval stays client-side.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const srpJs = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');
const authPagesJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const freshnessJs = fs.readFileSync(path.join(root, 'app/static/js/freshness.js'), 'utf8');

// --- A1: ensureDeviceId mints + postJson sends X-Device-Id -----------------
assert.ok(srpJs.includes('function ensureDeviceId'));
assert.ok(srpJs.includes('ensureDeviceId,'));
assert.ok(srpJs.includes('crypto.randomUUID') || srpJs.includes('getRandomValues'));
assert.ok(!/Math\.random\(\)/.test(srpJs.split('function ensureDeviceId')[1].split('async function postJson')[0]));
assert.ok(authPagesJs.includes('NotesSrpAuth.ensureDeviceId'));

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const fetchCalls = [];
const sandbox = {
  window: {},
  globalThis: {},
  localStorage,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  crypto: {
    randomUUID: () => 'f61e9a2b-1111-2222-3333-444455556666',
    getRandomValues: (buf) => {
      for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 17 + 3) & 0xff;
      return buf;
    },
    subtle: {
      digest: async () => new Uint8Array(32).buffer,
    },
  },
  TextEncoder,
  fetch: async (url, opts) => {
    fetchCalls.push({ url, headers: { ...(opts.headers || {}) } });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        srp_salt: 'a'.repeat(64),
        B: 'b'.repeat(512),
        srp_kdf_version: 2,
        M2: 'c'.repeat(64),
        csrf: 'csrf',
        kdf_salt: 'd'.repeat(24),
        email: 'fresh@example.com',
      }),
    };
  },
  console,
  NobleArgon2: {
    argon2idAsync: async () => new Uint8Array(32),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(srpJs, sandbox);
assert.ok(sandbox.NotesSrpAuth);
assert.ok(typeof sandbox.NotesSrpAuth.ensureDeviceId === 'function');
store.clear();
const minted = sandbox.NotesSrpAuth.ensureDeviceId();
assert.ok(minted);
assert.strictEqual(localStorage.getItem('notes_device_id'), minted);
assert.strictEqual(sandbox.NotesSrpAuth.ensureDeviceId(), minted, 'reuse stored id');

fetchCalls.length = 0;
store.clear();
Promise.resolve(sandbox.NotesSrpAuth.login('fresh@example.com', 'password-ok-long'))
  .catch(() => {})
  .then(() => {
    assert.ok(fetchCalls.length >= 1, 'challenge fetch');
    const challengeHeaders = fetchCalls[0].headers;
    assert.ok(challengeHeaders['X-Device-Id'], 'fresh login must send X-Device-Id');
    assert.ok(/^[A-Za-z0-9._-]{8,80}$/.test(challengeHeaders['X-Device-Id']));

    // --- A3: device list suffix + Inactive ------------------------------------
    assert.ok(appJs.includes('formatDeviceRowName'));
    assert.ok(appJs.includes('device_id_suffix'));
    assert.ok(appJs.includes('Last seen'));
    assert.ok(appJs.includes("'Inactive'") || appJs.includes('"Inactive"'));
    assert.ok(appJs.includes('device-row-inactive') || appJs.includes('device-inactive'));

    // Feature C approval is client-side (vault_head / startVerified), not server sessions.
    assert.ok(freshnessJs.includes('canApproveDevice: !!state.startVerified'));
    assert.ok(freshnessJs.includes('Only a verified device can approve a new device'));
    assert.ok(!freshnessJs.includes('last_seen_at'));
    assert.ok(!freshnessJs.includes('/api/sessions'));

    console.log('test_round71_signin_device_id ok');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
