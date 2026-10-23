/**
 * Round 70: silent post-login unlock must not redirect on a brief /api/account 401.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

// --- Source contracts ---
assert.ok(appJs.includes('function isPostLoginBootUnlock'));
assert.ok(appJs.includes('function shouldRedirectOnUnlockSessionExpired'));
assert.ok(appJs.includes('async function loadAccountWithPostLoginRetry'));
assert.ok(appJs.includes('POST_LOGIN_ACCOUNT_RETRY_MS'));
assert.ok(appJs.includes('post-login-session-pending'));
assert.ok(appJs.includes('retryOnLoginRequired'));
assert.ok(appJs.includes('NotesPostLoginUnlock'));
assert.ok(
  /bootstrapServerSession\(cached,\s*\{\s*retryOnLoginRequired/.test(appJs)
    || appJs.includes('retryOnLoginRequired: !!(silent && isPostLoginBootUnlock())'),
);

const abortFn = appJs.slice(
  appJs.indexOf('function abortUnlockAttempt'),
  appJs.indexOf('function abortUnlockAttempt') + 1200,
);
assert.ok(abortFn.includes('shouldRedirectOnUnlockSessionExpired'));
assert.ok(abortFn.includes('redirectToExpiredLogin'));
assert.ok(
  abortFn.indexOf('shouldRedirectOnUnlockSessionExpired')
    < abortFn.indexOf('redirectToExpiredLogin'),
  'post-login guard must run before redirect',
);

// --- Extract helpers into a sandbox (production bodies, test harness) ---
function makeStorage() {
  const store = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { Object.keys(store).forEach((k) => delete store[k]); },
  };
}

const sessionStorage = makeStorage();
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Error,
  sessionStorage,
  window: {},
};
sandbox.window = sandbox;
sandbox.global = sandbox;

// Slice the Round 70 helper block from app.js and eval with a stub isLoginRequiredError.
const helperStart = appJs.indexOf('const POST_LOGIN_ACCOUNT_RETRY_MS = 400;');
const helperEnd = appJs.indexOf('function abortUnlockAttempt', helperStart);
assert.ok(helperStart > 0 && helperEnd > helperStart);
const helperSrc = appJs.slice(helperStart, helperEnd)
  + `
  function isLoginRequiredError(err) {
    if (!err) return false;
    if (err.code === 'SESSION_EXPIRED') return true;
    const status = Number(err.status);
    if (status !== 401 && status !== 403) return false;
    return /login required|sign in required/i.test(String(err.message || ''));
  }
  `;
vm.runInNewContext(
  `${helperSrc}\nthis.NotesPostLoginUnlock = window.NotesPostLoginUnlock;`,
  sandbox,
);

const api = sandbox.NotesPostLoginUnlock;
assert.ok(api);
assert.strictEqual(api.POST_LOGIN_ACCOUNT_RETRY_MS, 400);

// Decision: non-silent always redirects
sessionStorage.clear();
assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: false }), true);
sessionStorage.setItem('notes_post_login_unlock', '1');
assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: false }), true, 'non-silent still redirects');

// Decision: silent + post-login does not redirect
assert.strictEqual(api.isPostLoginBootUnlock(), true);
assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: true }), false);

// Decision: silent without post-login flags still redirects (idle silent paths)
sessionStorage.clear();
assert.strictEqual(api.isPostLoginBootUnlock(), false);
assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: true }), true);
sessionStorage.setItem('notes_allow_boot_unlock', '1');
assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: true }), false);

(async () => {
  // Case 1: silent post-login, 401 then success — unlocks (returns data), no redirect decision true
  sessionStorage.clear();
  sessionStorage.setItem('notes_post_login_unlock', '1');
  let calls = 0;
  let ensured = 0;
  const sleeps = [];
  const ok = await api.loadAccountWithPostLoginRetry(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('login required');
      err.status = 401;
      throw err;
    }
    return { email: 'tester@example.com', csrf: 'c1' };
  }, {
    enabled: true,
    delayMs: 50,
    sleep: async (ms) => { sleeps.push(ms); },
    ensureSession: async () => { ensured += 1; return true; },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(ensured, 1);
  assert.deepStrictEqual(sleeps, [50]);
  assert.strictEqual(ok.email, 'tester@example.com');
  assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: true }), false);

  // Case 2: silent post-login, 401 twice — still throws; redirect suppressed
  sessionStorage.clear();
  sessionStorage.setItem('notes_allow_boot_unlock', '1');
  calls = 0;
  await assert.rejects(
    () => api.loadAccountWithPostLoginRetry(async () => {
      calls += 1;
      const err = new Error('login required');
      err.status = 401;
      throw err;
    }, {
      enabled: true,
      delayMs: 10,
      sleep: async () => {},
      ensureSession: async () => false,
    }),
    (err) => err && err.status === 401 && /login required/i.test(err.message),
  );
  assert.strictEqual(calls, 2, 'exactly one retry');
  assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: true }), false,
    'typed unlock fallthrough — no redirect');

  // Case 3: non-silent path — redirect still required (regression guard)
  sessionStorage.clear();
  sessionStorage.setItem('notes_post_login_unlock', '1');
  assert.strictEqual(api.shouldRedirectOnUnlockSessionExpired({ silent: false }), true);
  // And retry helper must not swallow errors when disabled (typed unlock path)
  calls = 0;
  await assert.rejects(
    () => api.loadAccountWithPostLoginRetry(async () => {
      calls += 1;
      const err = new Error('login required');
      err.status = 401;
      throw err;
    }, { enabled: false, delayMs: 10, sleep: async () => {} }),
    (err) => err && err.status === 401,
  );
  assert.strictEqual(calls, 1, 'no retry when not post-login silent path');

  // abortUnlockAttempt source: non-silent still calls redirectToExpiredLogin
  assert.ok(abortFn.includes('redirectToExpiredLogin()'));
  assert.ok(abortFn.includes("logLockReason('session-expired'"));

  // Incognito/fresh-profile e2e needs a live browser + credentials — covered here
  // by the 401→success / 401→401 decision tests against the production helpers.

  console.log('test_round70_post_login_unlock ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
