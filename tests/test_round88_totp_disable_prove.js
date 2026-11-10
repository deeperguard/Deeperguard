/**
 * Security Phase 1 UX: SRP prove before 2FA disable handles 401 with toast + focus.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

const totpUxStart = appJs.indexOf('function accountTotpApiErrorMessage');
const totpUxEnd = appJs.indexOf("getElementById('btn-confirm-disable-totp')") + 2200;
const slice = appJs.slice(totpUxStart, totpUxEnd);

assert.ok(slice.includes('srpTotpPasswordProve'));
assert.ok(slice.includes('Password is incorrect.'));
assert.ok(slice.includes('accountTotpProveErrorMessage'));
assert.ok(slice.includes('passwordEl?.focus()'));
assert.ok(slice.includes("btn.textContent = 'Checking…'"));
assert.ok(slice.includes("That code didn't work. Check your authenticator and try again."));
assert.ok(slice.includes('Too many attempts. Try again in a few minutes.'));

async function handleDisableProve({ prove, toastCalls, focusCalls }) {
  const passwordEl = { focus: () => focusCalls.push('password') };
  try {
    await prove();
  } catch (proveErr) {
    const message = proveErr?.status === 401 ? 'Password is incorrect.' : (proveErr?.message || '');
    toastCalls.push(message);
    if (proveErr?.status === 401) passwordEl.focus();
    return 'handled';
  }
  return 'ok';
}

(async () => {
  const toasts = [];
  const focuses = [];
  const out = await handleDisableProve({
    prove: async () => {
      const err = new Error('invalid credentials');
      err.status = 401;
      throw err;
    },
    toastCalls: toasts,
    focusCalls: focuses,
  });
  assert.strictEqual(out, 'handled');
  assert.deepStrictEqual(toasts, ['Password is incorrect.']);
  assert.deepStrictEqual(focuses, ['password']);

  console.log('test_round88_totp_disable_prove.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
