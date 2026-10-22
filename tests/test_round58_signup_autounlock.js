/**
 * Round 58: post-signup / empty-vault silent auto-unlock must prove the
 * password instead of deferring to the unlock screen.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
const authJs = fs.readFileSync(path.join(jsRoot, 'auth-pages.js'), 'utf8');

assert.ok(appJs.includes('function mayProveEmptyVaultOnSilentBoot'));
assert.ok(appJs.includes("sessionStorage.getItem('notes_post_login_unlock') === '1'"));
assert.ok(appJs.includes("sessionStorage.getItem('notes_just_registered') === '1'"));
assert.ok(
  appJs.includes('if (silent && !mayProveEmptyVaultOnSilentBoot()) deferAutoUnlock()'),
  'empty-vault silent path must prove when post-login/register flags are set',
);

const emptyAt = appJs.indexOf("if (!(freshProof?.via === 'decrypt' && Number(freshProof.opened) > 0))");
assert.ok(emptyAt > 0);
const emptyBranch = appJs.slice(emptyAt, emptyAt + 500);
assert.ok(emptyBranch.includes('mayProveEmptyVaultOnSilentBoot'));
assert.ok(emptyBranch.includes('proveEmptyVaultWithAccountPassword'));

const viaEmptyAt = appJs.indexOf("if (proof?.via === 'empty')");
assert.ok(viaEmptyAt > 0);
const viaEmptyBranch = appJs.slice(viaEmptyAt, viaEmptyAt + 280);
assert.ok(viaEmptyBranch.includes('mayProveEmptyVaultOnSilentBoot'));
assert.ok(viaEmptyBranch.includes('proveEmptyVaultWithAccountPassword'));

// Register still stashes boot password + derived key + just_registered before /app.
const registerSlice = authJs.slice(authJs.indexOf('if (registerForm)'), authJs.indexOf('sign-out-create'));
assert.ok(registerSlice.includes('stashLoginSession'));
assert.ok(registerSlice.includes('notes_just_registered'));
assert.ok(registerSlice.includes('stashBootDerivedKey'));
assert.ok(registerSlice.includes('cf_turnstile_response'));
assert.ok(authJs.includes("sessionStorage.setItem('notes_post_login_unlock', '1')"));

// Flag helper mirrors sessionStorage (same predicate as app.js).
const store = {};
const sessionStorage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  setItem(key, value) {
    store[key] = String(value);
  },
  removeItem(key) {
    delete store[key];
  },
};
function mayProveEmptyVaultOnSilentBoot() {
  try {
    return sessionStorage.getItem('notes_post_login_unlock') === '1'
      || sessionStorage.getItem('notes_just_registered') === '1';
  } catch (err) {
    return false;
  }
}
assert.strictEqual(mayProveEmptyVaultOnSilentBoot(), false);
sessionStorage.setItem('notes_just_registered', '1');
assert.strictEqual(mayProveEmptyVaultOnSilentBoot(), true);
sessionStorage.removeItem('notes_just_registered');
assert.strictEqual(mayProveEmptyVaultOnSilentBoot(), false);
sessionStorage.setItem('notes_post_login_unlock', '1');
assert.strictEqual(mayProveEmptyVaultOnSilentBoot(), true);

console.log('test_round58_signup_autounlock ok');
