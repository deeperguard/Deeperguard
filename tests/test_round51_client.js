const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const req = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');

assert.ok(appJs.includes('deferAutoUnlock'));
assert.ok(appJs.includes('notes_post_login_unlock'));
assert.ok(authJs.includes("sessionStorage.setItem('notes_post_login_unlock'"));
assert.ok(storeJs.includes('Retry the other'));
assert.ok(storeJs.includes('Do not persist vault_kdf_version until ciphertext proves'));
assert.ok(!appJs.includes('if (silent) rejectWrongUnlockPassword()'));
// Round 50 deps kept.
assert.ok(/Pillow==12\.3\.0/.test(req));
assert.ok(/pyOpenSSL==26\.4\.0/.test(req));

console.log('test_round51_client ok');
