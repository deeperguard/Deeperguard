/**
 * Register hang UX: 6s/20s timers, late success, stale attempt wins once, exists strict, turnstile retry.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const authPagesCode = fs.readFileSync(path.join(jsRoot, 'auth-pages.js'), 'utf8');

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

  const sb4 = buildSandbox();
  runAuthPages(sb4);
  const generic = new Error('Could not complete sign-up. If you already have an account, sign in instead.');
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError(generic), false);
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError({ code: 'account_exists' }), true);
  assert.strictEqual(sb4.__notesRegisterHangTest.isRegisterExistsError({ status: 409 }), true);
  sb4.NotesSrpAuth.register = async () => { throw generic; };
  sb4.location.href = '';
  await sb4.__notesRegisterHangTest.runRegisterAttempt();
  assert.ok(!sb4.location.href.includes('/login'), 'generic failure stays on register');
  sb4.__notesRegisterHangTest.routeRegisterExistsToLogin('user@example.com');
  assert.strictEqual(sb4.sessionStorage.getItem('notes_login_prefill_email'), 'user@example.com');
  assert.ok(sb4.location.href.includes('register-exists'));
  assert.ok(!sb4.location.href.includes('email='));

  const sb5 = buildSandbox('nl');
  runAuthPages(sb5);
  assert.strictEqual(sb5.__notesRegisterHangTest.tCopy('retry'), 'Opnieuw');

  assert.ok(authPagesCode.includes('register-hang-live'));
  const srp = fs.readFileSync(path.join(jsRoot, 'srp-auth.js'), 'utf8');
  assert.ok(srp.includes('timeoutMs: 180000'));

  console.log('test_register_signup_hang.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
