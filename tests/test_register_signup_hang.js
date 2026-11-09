/**
 * Register hang UX: timers, retry lock, late success, soft-fail anti-enum, Turnstile retry.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const authPagesCode = fs.readFileSync(path.join(jsRoot, 'auth-pages.js'), 'utf8');

const REGISTER_SOFT_FAIL_MESSAGE =
  'Could not complete sign-up. If you already have an account, sign in instead.';

function makeStorage() {
  const store = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

function buildSandbox(lang = 'en') {
  const elements = new Map();
  const makeEl = (tag, attrs = {}) => ({
    tagName: tag.toUpperCase(),
    hidden: false,
    disabled: false,
    textContent: '',
    value: attrs.value || '',
    checked: !!attrs.checked,
    validity: { valid: true },
    addEventListener() {},
    setAttribute() {},
  });
  const getEl = (id) => {
    if (!elements.has(id)) {
      if (id === 'register-form') {
        elements.set(id, {
          addEventListener() {},
          querySelector: () => null,
          querySelectorAll: () => [],
        });
      } else if (id === 'register-retry') {
        const el = {
          hidden: true,
          disabled: false,
          textContent: '',
          _clicks: [],
          addEventListener(type, fn) { if (type === 'click') this._clicks.push(fn); },
          click() {
            const ev = { preventDefault() {} };
            for (const fn of this._clicks) fn(ev);
          },
        };
        elements.set(id, el);
      } else if (id === 'register-soft-fail-signin') {
        elements.set(id, { hidden: true, textContent: '' });
      } else if (id === 'register-soft-fail-signin-link') {
        elements.set(id, {
          hidden: false,
          textContent: '',
          href: '/login',
          _clicks: [],
          addEventListener(type, fn) { if (type === 'click') this._clicks.push(fn); },
          click() {
            const ev = { preventDefault() {} };
            for (const fn of this._clicks) fn(ev);
          },
        });
      } else {
        elements.set(id, makeEl('input', (id.includes('terms') || id.includes('recover')) ? { checked: true } : {}));
      }
    }
    return elements.get(id);
  };
  getEl('register-email').value = 't@example.com';
  getEl('register-password').value = 'longpassword12';
  getEl('register-password2').value = 'longpassword12';
  getEl('register-terms').checked = true;
  getEl('register-recover-ack').checked = true;
  const location = { href: '', replace: () => {}, pathname: '/register', search: '' };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    document: {
      documentElement: { lang },
      getElementById: (id) => (id === 'login-form' ? null : getEl(id)),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: null,
    location,
    history: { replaceState() {} },
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    NotesSrpAuth: { register: async () => ({ kdf_salt: 'x', vault_kdf_version: 2 }) },
    stashLoginSession: async () => {},
    afterAuthUrl: (p) => p,
    getEl,
    __notesRegisterTiming: { slowMs: 80, hangMs: 250 },
  };
  sandbox.window = sandbox;
  return sandbox;
}

function runAuthPages(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(authPagesCode, sandbox);
}

function softFailError() {
  const err = new Error(REGISTER_SOFT_FAIL_MESSAGE);
  err.status = 400;
  return err;
}

(async () => {
  const sb1 = buildSandbox();
  sb1.NotesSrpAuth.register = async () => {
    await new Promise((r) => setTimeout(r, 120));
    return { kdf_salt: 'abcd', vault_kdf_version: 2 };
  };
  runAuthPages(sb1);
  await sb1.__notesRegisterHangTest.runRegisterAttempt();
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(sb1.getEl('register-hang-live').hidden, true, 'slow success: no hang');

  const sb2 = buildSandbox();
  let resolved;
  const late = new Promise((r) => { resolved = r; });
  sb2.NotesSrpAuth.register = () => late.then(() => ({ kdf_salt: 's', vault_kdf_version: 2 }));
  let replaced = false;
  sb2.location.replace = () => { replaced = true; };
  runAuthPages(sb2);
  const promise = sb2.__notesRegisterHangTest.runRegisterAttempt();
  await new Promise((r) => setTimeout(r, 350));
  assert.strictEqual(sb2.getEl('register-hang-live').hidden, false, 'long wait shows hang');
  resolved();
  await promise;
  assert.strictEqual(sb2.getEl('register-hang-live').hidden, true);
  assert.strictEqual(replaced, true);

  const sb3 = buildSandbox();
  let calls = 0;
  sb3.NotesSrpAuth.register = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((r) => setTimeout(r, 400));
      return { kdf_salt: 'late', vault_kdf_version: 2 };
    }
    throw new Error('second attempt failed');
  };
  let replaceCount = 0;
  sb3.location.replace = () => { replaceCount += 1; };
  runAuthPages(sb3);
  const first = sb3.__notesRegisterHangTest.runRegisterAttempt();
  await new Promise((r) => setTimeout(r, 50));
  const second = sb3.__notesRegisterHangTest.runRegisterAttempt({ allowWhileInFlight: true });
  await first;
  await second;
  assert.strictEqual(replaceCount, 1, 'stale attempt success still finishes once');

  const sbRetry = buildSandbox();
  let registerCalls = 0;
  sbRetry.NotesSrpAuth.register = () => {
    registerCalls += 1;
    return new Promise((r) => setTimeout(() => r({ kdf_salt: 'x', vault_kdf_version: 2 }), 8000));
  };
  runAuthPages(sbRetry);
  void sbRetry.__notesRegisterHangTest.runRegisterAttempt();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!sbRetry.getEl('register-retry').hidden, 'hang shows retry');
  sbRetry.getEl('register-retry').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(registerCalls, 2, 'retry click starts second register');

  const sb4 = buildSandbox();
  runAuthPages(sb4);
  const generic = softFailError();
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError(generic), false);
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterSoftFailError(generic), true);
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError({ code: 'account_exists' }), true);
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError({ status: 409 }), true);
  sb4.NotesSrpAuth.register = async () => { throw generic; };
  sb4.location.href = '';
  await sb4.__notesRegisterHangTest.runRegisterAttempt();
  assert.ok(!sb4.location.href.includes('/login'), 'first soft-fail: no redirect');
  assert.strictEqual(sb4.getEl('register-soft-fail-signin').hidden, true, 'first try: no sign-in link');
  sb4.NotesSrpAuth.register = async () => { throw softFailError(); };
  await sb4.__notesRegisterHangTest.runRegisterAttempt({ fromRetry: true });
  assert.ok(!sb4.location.href.includes('/login'), 'retry soft-fail: no auto redirect');
  assert.strictEqual(sb4.getEl('register-soft-fail-signin').hidden, false);
  assert.ok(sb4.getEl('register-soft-fail-signin-link').textContent.includes('Sign in'));
  sb4.getEl('register-soft-fail-signin-link').click();
  assert.strictEqual(sb4.sessionStorage.getItem('notes_login_prefill_email'), 't@example.com');
  assert.ok(sb4.location.href.includes('register-exists'));

  const sb4nl = buildSandbox('nl');
  runAuthPages(sb4nl);
  sb4nl.NotesSrpAuth.register = async () => { throw softFailError(); };
  await sb4nl.__notesRegisterHangTest.runRegisterAttempt({ fromRetry: true });
  assert.ok(sb4nl.getEl('register-soft-fail-signin-link').textContent.includes('Inloggen'));

  const sb5 = buildSandbox('nl');
  runAuthPages(sb5);
  assert.strictEqual(sb5.__notesRegisterHangTest.tCopy('retry'), 'Opnieuw');

  const sb6 = buildSandbox();
  const turnstileInput = { value: 'stale-token' };
  let resetArg;
  sb6.document.querySelector = (sel) => {
    if (sel === '.cf-turnstile') return { tagName: 'DIV', id: 'cf-chl-widget-test' };
    if (sel === 'input[name="cf-turnstile-response"]') return turnstileInput;
    return null;
  };
  sb6.turnstile = {
    reset: (id) => {
      resetArg = id;
      turnstileInput.value = '';
      setTimeout(() => { turnstileInput.value = 'fresh-token'; }, 50);
    },
  };
  runAuthPages(sb6);
  assert.strictEqual(turnstileInput.value, 'stale-token');
  const tokenWait = sb6.__notesRegisterHangTest.awaitFreshTurnstileToken();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sb6.getEl('register-submit').textContent, 'Security check…');
  const tokenOk = await tokenWait;
  assert.strictEqual(resetArg, 'cf-chl-widget-test');
  assert.strictEqual(tokenOk, true);
  assert.strictEqual(turnstileInput.value, 'fresh-token');

  const sb7 = buildSandbox();
  sb7.document.querySelector = (sel) => {
    if (sel === '.cf-turnstile') return { tagName: 'DIV', id: 'w2' };
    return null;
  };
  runAuthPages(sb7);
  const missingTurnstile = await sb7.__notesRegisterHangTest.awaitFreshTurnstileToken();
  assert.strictEqual(missingTurnstile, false);
  assert.strictEqual(sb7.getEl('register-submit').disabled, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sb7.getEl('register-error').textContent, 'Please try again.');
  assert.ok(authPagesCode.includes('Date.now() + 60000'));

  assert.ok(authPagesCode.includes('register-hang-live'));
  const srp = fs.readFileSync(path.join(jsRoot, 'srp-auth.js'), 'utf8');
  assert.ok(srp.includes('timeoutMs: 180000'));

  console.log('test_register_signup_hang.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
