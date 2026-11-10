/**
 * Security Phase 1 UX: real account-totp-auth.js disable prove behavior.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const modPath = path.join(root, 'app/static/js/account-totp-auth.js');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const srpJs = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');

assert.ok(fs.existsSync(modPath));
assert.ok(!srpJs.includes('function resync'));
assert.ok(!srpJs.includes('/api/auth/srp/resync'));
assert.ok(appJs.includes('NotesAccountTotpAuth'));
assert.ok(appJs.includes('srpTotpDisableRotationToken'));

const vmContext = { globalThis: {} };
vmContext.window = vmContext.globalThis;
vm.runInContext(fs.readFileSync(modPath, 'utf8'), vm.createContext(vmContext));
const NotesAccountTotpAuth = vmContext.globalThis.NotesAccountTotpAuth;

assert.strictEqual(
  NotesAccountTotpAuth.accountTotpProveErrorMessage({ status: 401, message: 'x' }),
  'Password is incorrect.',
);

(async () => {
  const btn = { disabled: false, textContent: 'Confirm' };
  try {
    await NotesAccountTotpAuth.srpTotpPasswordProve('u@e2e.invalid', 'pw', {
      button: btn,
      passwordChangeProve: async () => {
        const err = new Error('invalid credentials');
        err.status = 401;
        throw err;
      },
    });
    assert.fail('expected prove throw');
  } catch (err) {
    assert.strictEqual(err.status, 401);
  }
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Confirm');

  const toasts = [];
  const focusIds = [];
  const r401 = await NotesAccountTotpAuth.srpTotpDisableRotationToken({
    email: 'u@e2e.invalid',
    password: 'pw',
    button: btn,
    passwordChangeProve: async () => {
      const err = new Error('invalid credentials');
      err.status = 401;
      throw err;
    },
    onToast: (msg) => toasts.push(msg),
    onFocusPassword: () => focusIds.push('password'),
  });
  assert.strictEqual(r401.ok, false);
  assert.strictEqual(r401.reason, 'prove_error');
  assert.deepStrictEqual(toasts, ['Password is incorrect.']);
  assert.deepStrictEqual(focusIds, ['password']);
  assert.strictEqual(btn.textContent, 'Confirm');

  toasts.length = 0;
  focusIds.length = 0;
  const rEmpty = await NotesAccountTotpAuth.srpTotpDisableRotationToken({
    email: 'u@e2e.invalid',
    password: 'pw',
    passwordChangeProve: async () => ({ rotation_token: '   ' }),
    onToast: (msg) => toasts.push(msg),
    onFocusPassword: () => focusIds.push('password'),
  });
  assert.strictEqual(rEmpty.ok, false);
  assert.strictEqual(rEmpty.reason, 'empty_token');
  assert.deepStrictEqual(toasts, ['Could not verify your password — try again.']);
  assert.deepStrictEqual(focusIds, ['password']);

  const rOk = await NotesAccountTotpAuth.srpTotpDisableRotationToken({
    email: 'u@e2e.invalid',
    password: 'pw',
    passwordChangeProve: async () => ({ rotation_token: 'rot-abc' }),
  });
  assert.strictEqual(rOk.ok, true);
  assert.strictEqual(rOk.rotation_token, 'rot-abc');

  console.log('test_round88_totp_disable_prove.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
