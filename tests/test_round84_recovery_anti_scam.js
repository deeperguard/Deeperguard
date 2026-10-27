/**
 * Round 84: recovery anti-scam copy (settings reveal + help doc).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const passkeyJs = fs.readFileSync(path.join(root, 'app/static/js/passkey-signin.js'), 'utf8');
const helpMd = fs.readFileSync(path.join(root, 'docs/HELP_RECOVERY.md'), 'utf8');
const adminApi = fs.readFileSync(path.join(root, 'app/admin_api.py'), 'utf8');

const ANTI_SCAM =
  'Deeperguard will never ask for your master password, recovery codes, or 2FA codes. ' +
  'Nobody outside your devices can restore your account. The only recovery path is the one shown in this app.';

assert.ok(passkeyJs.includes('RECOVERY_ANTI_SCAM'));
assert.ok(passkeyJs.includes('never ask for your master password, recovery codes, or 2FA codes'));
assert.ok(passkeyJs.includes('The only recovery path is the one shown in this app'));
assert.ok(passkeyJs.includes('antiScam.className = \'settings-hint\''));
assert.ok(helpMd.includes(ANTI_SCAM));
assert.ok(adminApi.includes('/help/recovery'));
assert.ok(adminApi.includes('HELP_RECOVERY.md'));

console.log('test_round84_recovery_anti_scam ok');
