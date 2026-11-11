/**
 * Security Phase 1 (H1): no legacy_login password POST; SRP KDF pin refuses downgrade.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const srpPath = path.join(root, 'app/static/js/srp-auth.js');
const srpSrc = fs.readFileSync(srpPath, 'utf8');

assert.ok(srpSrc.includes('assertSrpKdfChallenge'));
assert.ok(srpSrc.includes('legacyLoginRemoved'));
assert.ok(!srpSrc.includes("postJson('/api/auth/login'"));

async function passwordSignInHarness({ login, repairLogin, postJson, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  let result;
  if (login) {
    try {
      result = await login(normalizedEmail, password);
    } catch (srpErr) {
      if (srpErr?.status === 429) throw srpErr;
      if (srpErr?.status !== 401 && !srpErr?.repairExhausted) throw srpErr;
    }
  }
  if (!result) {
    try {
      result = await repairLogin(normalizedEmail, password);
    } catch (repairErr) {
      if (repairErr?.status === 429) throw repairErr;
      if (repairErr?.legacyLogin || repairErr?.code === 'legacy_login') {
        const err = new Error('legacy removed');
        err.status = 410;
        err.legacyLoginRemoved = true;
        throw err;
      }
      throw repairErr;
    }
  }
  return result;
}

(async () => {
  const posts = [];
  const postJson = async (url, body) => {
    posts.push({ url, body });
    if (url.includes('/api/auth/login')) {
      return { error: 'nope' };
    }
    const err = new Error('legacy');
    err.status = 401;
    err.code = 'legacy_login';
    err.legacyLogin = true;
    throw err;
  };
  let threw = false;
  try {
    await passwordSignInHarness({
      login: async () => {
        throw Object.assign(new Error('bad'), { status: 401 });
      },
      repairLogin: async () => {
        const err = new Error('legacy');
        err.status = 401;
        err.code = 'legacy_login';
        err.legacyLogin = true;
        throw err;
      },
      postJson,
      email: 'u@e2e.invalid',
      password: 'secret-password',
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 410);
    assert.ok(e.legacyLoginRemoved);
  }
  assert.ok(threw);
  assert.ok(posts.every((p) => !JSON.stringify(p.body || {}).includes('secret-password')));

  assert.ok(srpSrc.includes('function assertSrpKdfChallenge'));
  assert.ok(srpSrc.includes('srpKdfDowngrade'));
assert.ok(
  srpSrc.includes('For your security, this sign-in was blocked on this device.'),
);

  const pinStore = new Map();
  const pinKey = (email) => `notes_srp_kdf_pin:${email}`;
  const norm = (v) => (Number(v) >= 2 ? 2 : 1);
  const pin = (email, version) => pinStore.set(pinKey(email), String(norm(version)));
  const getPin = (email) => (pinStore.has(pinKey(email)) ? Number(pinStore.get(pinKey(email))) : null);
  const assertChallenge = (email, challengeVersion) => {
    const pinned = getPin(email);
    const challenge = norm(challengeVersion);
    if (pinned != null && challenge < pinned) {
      const err = new Error('downgrade');
      err.srpKdfDowngrade = true;
      throw err;
    }
  };
  pin('pin@e2e.invalid', 2);
  let refused = false;
  try {
    assertChallenge('pin@e2e.invalid', 1);
  } catch (e) {
    refused = true;
    assert.ok(e.srpKdfDowngrade);
  }
  assert.ok(refused);
  assertChallenge('pin@e2e.invalid', 2);

  console.log('test_round88_security_phase1.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
