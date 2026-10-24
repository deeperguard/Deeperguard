/**
 * Round 76: client posts salt/verifier only after legacy login (no password re-send).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srpJs = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

assert.ok(srpJs.includes('async function upgrade('));
assert.ok(srpJs.includes('async function maybeUpgradeLegacySrp('));
assert.ok(srpJs.includes("/api/auth/srp/upgrade"));
// Upgrade body must not re-post plaintext password.
const upgradeFn = srpJs.split('async function upgrade(')[1].split('async function makeVerifier')[0];
assert.ok(upgradeFn.includes('srp_salt'));
assert.ok(upgradeFn.includes('srp_verifier'));
assert.ok(!upgradeFn.includes('current_password'));
assert.ok(!/password\s*:/.test(upgradeFn), 'upgrade must not send password field');

assert.ok(appPy.includes('@app.post("/api/auth/srp/upgrade")'));
assert.ok(appPy.includes('srp_legacy_upgrade') || appPy.includes('log_auth_event'));
assert.ok(appPy.includes('already srp'));
assert.ok(appPy.includes('login required'));

console.log('test_round76_legacy_srp_upgrade ok');
