/**
 * Round 50 client guards: silent boot unlock, Google key save must not lock,
 * merge keeps local on equal timestamps.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const vaultSecretsJs = fs.readFileSync(path.join(root, 'app/static/js/vault-secrets.js'), 'utf8');
const dbPy = fs.readFileSync(path.join(root, 'app/db.py'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');
const req = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');

assert.ok(appJs.includes('verifyAndUnlock(autoUnlockPassword, { silent: true })'));
assert.ok(appJs.includes('abortUnlockAttempt(err, { silent })'));
assert.ok(appJs.includes('deferAutoUnlock'));
assert.ok(appJs.includes('mayProveEmptyVaultOnSilentBoot'));
assert.ok(appJs.includes('proveEmptyVaultWithAccountPassword'));
assert.ok(appJs.includes('settingsKeySaveDepth'));
assert.ok(appJs.includes('Clear local Drive tokens only'));
assert.ok(vaultSecretsJs.includes('Drop any leftover derived-key stash'));
assert.ok(storeJs.includes('localTs >= incomingTs'));
assert.ok(dbPy.includes('touch_password_changed'));
assert.ok(appPy.includes('touch_password_changed=False'));
assert.ok(/Pillow==12\.3\.0/.test(req));
assert.ok(/pyOpenSSL==26\.4\.0/.test(req));
assert.ok(/cryptography==50\.0\.1/.test(req));

console.log('test_round50_client ok');
