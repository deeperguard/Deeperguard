/** Round 84: client-side auth security notice ack + dialog wiring. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');

assert.ok(storeJs.includes('notes_auth_security_ack_at'));
assert.ok(storeJs.includes('remoteAuthSecurityEvent'));
assert.ok(storeJs.includes('ackAuthSecurity'));
assert.ok(appJs.includes('checkRemoteAuthSecurityNotice'));
assert.ok(appJs.includes('auth-security-notice-ack'));
assert.ok(authJs.includes('ackAuthSecurity'));
assert.ok(authJs.includes('data.auth_security_at'));

console.log('test_round84_auth_security_notice.js ok');
