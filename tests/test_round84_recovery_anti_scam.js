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
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const deploySh = fs.readFileSync(path.join(root, 'deploy/deploy-deeperguard.sh'), 'utf8');

assert.ok(passkeyJs.includes('RECOVERY_ANTI_SCAM'));
assert.ok(passkeyJs.includes('never ask for your master password, recovery codes, or 2FA codes'));
assert.ok(passkeyJs.includes('The only recovery path is the one shown in this app'));
assert.ok(passkeyJs.includes('antiScam.className = \'settings-hint\''));
assert.ok(adminApi.includes('/help/recovery'));
assert.ok(adminApi.includes('HELP_RECOVERY.md'));
assert.ok(
  appHtml.includes(
    '<a href="/help/recovery" target="_blank" rel="noopener noreferrer">Recovery help</a>'
  )
);
assert.ok(deploySh.includes('TAR_PATHS=(app deploy docs tests'));
assert.ok(
  helpMd.includes(
    'Deeperguard support will never ask for your password, recovery codes, or 2FA codes.'
  )
);
assert.ok(
  helpMd.includes(
    'Deeperguard cannot reset your vault password or decrypt your notes for you.'
  )
);
assert.ok(helpMd.includes('Settings → Import backup'));
assert.ok(!helpMd.includes('notes@'));

console.log('test_round84_recovery_anti_scam ok');
