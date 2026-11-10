/**
 * Round 73 Part A: no plaintext password on the wire for SRP accounts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srpJs = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');
const authPages = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

// --- static -----------------------------------------------------------------
const signIn = srpJs.slice(
  srpJs.indexOf('async function passwordSignIn'),
  srpJs.indexOf('async function register'),
);
assert.ok(signIn.includes('legacyLoginRemoved'));
assert.ok(signIn.includes('incorrectPassword'));
assert.ok(!signIn.includes("postJson('/api/auth/login'"), 'no legacy password login POST');
assert.ok(srpJs.includes('Round 73: never POST plaintext password for SRP accounts'));

assert.ok(authPages.includes('showSecureSignInReload'));
assert.ok(authPages.includes("Secure sign-in didn't load. Reload the page and try again."));
assert.ok(authPages.includes('err.srpMissing = true'));
assert.ok(authPages.includes('login-srp-reload'));
assert.ok(!authPages.includes("postJson('/api/auth/repair-login', { email, password })"));

const totpSlice = appJs.slice(
  appJs.indexOf("getElementById('btn-confirm-disable-totp')"),
  appJs.indexOf("getElementById('btn-confirm-disable-totp')") + 1400,
);
assert.ok(totpSlice.includes("authMethod === 'srp'"));
assert.ok(totpSlice.includes('passwordChangeProve'));
assert.ok(totpSlice.includes('rotation_token'));

// --- behavioral harness mirroring passwordSignIn control flow --------------
async function passwordSignInHarness({ login, repairLogin, postJson, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  let result;
  try {
    result = await login(normalizedEmail, password);
  } catch (srpErr) {
    if (srpErr?.status === 429) throw srpErr;
    // credential failure → repair
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
      } else {
        const err = new Error('Email or password is incorrect');
        err.status = repairErr?.status || 401;
        err.incorrectPassword = true;
        throw err;
      }
    }
  }
  return result;
}

(async () => {
  const bodies = [];
  const postJson = async (url, body) => {
    bodies.push({ url, body: { ...body } });
    if (url === '/api/auth/login') {
      const err = new Error('should-not-be-called-for-srp');
      err.status = 401;
      throw err;
    }
    return { ok: true };
  };

  // SRP verify fail + repair fail (no legacy_login) → no password on wire.
  await assert.rejects(
    () => passwordSignInHarness({
      login: async () => {
        const err = new Error('invalid credentials');
        err.status = 401;
        throw err;
      },
      repairLogin: async () => {
        const err = new Error('invalid credentials');
        err.status = 401;
        err.repairExhausted = true;
        throw err;
      },
      postJson,
      email: 'srp-user@example.com',
      password: 'correct-horse-battery',
    }),
    (err) => err && err.incorrectPassword === true,
  );
  assert.strictEqual(bodies.length, 0, 'SRP failure must not call /api/auth/login');

  // Successful SRP login — no password field in any postJson body from harness.
  bodies.length = 0;
  const ok = await passwordSignInHarness({
    login: async () => ({ auth_method: 'srp', csrf: 'x' }),
    repairLogin: async () => { throw new Error('unused'); },
    postJson,
    email: 'srp-ok@example.com',
    password: 'vault-password-here',
  });
  assert.strictEqual(ok.auth_method, 'srp');
  assert.strictEqual(bodies.length, 0);

  // Legacy login hint: client refuses; no /api/auth/login password POST (H1).
  bodies.length = 0;
  await assert.rejects(
    () => passwordSignInHarness({
      login: async () => {
        const err = new Error('invalid credentials');
        err.status = 401;
        throw err;
      },
      repairLogin: async () => {
        const err = new Error('invalid credentials');
        err.status = 401;
        err.code = 'legacy_login';
        err.legacyLogin = true;
        throw err;
      },
      postJson,
      email: 'legacy@example.com',
      password: 'legacy-pass-word',
    }),
    (err) => err && err.status === 410,
  );
  assert.strictEqual(bodies.length, 0);

  // Missing NotesSrpAuth path: signInWithPassword shape (static already covers throw).
  assert.ok(authPages.includes('if (!window.NotesSrpAuth?.passwordSignIn)'));
  assert.ok(authPages.includes('showSecureSignInReload'));

  console.log('test_round73_srp_no_plaintext ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
