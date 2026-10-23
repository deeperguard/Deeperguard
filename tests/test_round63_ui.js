const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const srp = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');
const totp = fs.readFileSync(path.join(root, 'app/static/js/totp-page.js'), 'utf8');
const authPages = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');
const cloud = fs.readFileSync(path.join(root, 'app/static/js/cloud-backup.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/static/sw.js'), 'utf8');

const repair = appJs.slice(
  appJs.indexOf('async function repairUnlockWithPassword'),
  appJs.indexOf('async function establishServerSessionAfterVaultUnlock'),
);
const vaultTry = repair.slice(
  repair.indexOf('if (window.NotesSrpAuth?.vaultRecovery)'),
  repair.indexOf('if (window.NotesSrpAuth?.passwordSignIn)'),
);
assert.ok(vaultTry.includes('isLoginRequiredError(err) || isTotpRequiredError(err)'));
assert.ok(!vaultTry.includes('sessionExpired: true'), 'vault-recovery must fall through to repair-login when session/TOTP is missing');
assert.ok(vaultTry.includes('wrongPassword: true'));
assert.ok(repair.includes("sessionStorage.setItem('notes_vault_recovery', '1')"));
assert.ok(repair.includes("sessionStorage.setItem('notes_srp_legacy_upgrade', '1')"));
assert.ok(repair.includes('stashBootPassword'));
assert.ok(repair.includes('if (data.totp_required)'));
const afterSignIn = repair.slice(repair.indexOf('if (data.totp_required)'));
assert.ok(afterSignIn.includes('await stashPendingAuthWrites(data)'));
assert.ok(afterSignIn.includes('NotesSrpAuth.vaultRecovery'));
assert.ok(
  afterSignIn.indexOf('totpRequired: true') < afterSignIn.indexOf('NotesSrpAuth.vaultRecovery'),
  'post-signin vault-recovery runs only when TOTP is not required',
);

const signIn = srp.slice(
  srp.indexOf('async function passwordSignIn'),
  srp.indexOf('async function register'),
);
assert.ok(signIn.includes("postJson('/api/auth/login'"));
assert.ok(signIn.includes('if (result?.totp_required) return result;'));
assert.ok(signIn.indexOf('if (result?.totp_required) return result;') < signIn.indexOf('maybeUpgradeLegacySrp'));
assert.ok(srp.includes('async function maybeUpgradeLegacySrp'));
assert.ok(srp.includes("postJson('/api/auth/srp/upgrade'"));
assert.ok(srp.includes("'/api/auth/vault-recovery/challenge'"));
assert.ok(srp.includes("'/api/auth/vault-recovery'"));

assert.ok(authPages.includes("sessionStorage.setItem('notes_srp_legacy_upgrade', '1')"));
assert.ok(authPages.includes("sessionStorage.removeItem('notes_srp_legacy_upgrade')"));

assert.ok(totp.includes('async function finishLegacySrpUpgradeIfNeeded'));
assert.ok(totp.includes('async function finishVaultRecoveryIfNeeded'));
assert.ok(totp.includes('NotesSrpAuth.upgrade'));
assert.ok(totp.includes('NotesSrpAuth.vaultRecovery'));
assert.ok(totp.includes("sessionStorage.getItem('notes_srp_legacy_upgrade') === '1'"));
assert.ok(totp.includes("sessionStorage.getItem('notes_vault_recovery') === '1'"));
const afterTotp = totp.slice(totp.indexOf("if (res.ok)"));
assert.ok(afterTotp.includes('await finishSrpKdfUpgradeIfNeeded()'));
assert.ok(afterTotp.includes('await finishLegacySrpUpgradeIfNeeded()'));
assert.ok(afterTotp.includes('await finishVaultRecoveryIfNeeded()'));
assert.ok(
  afterTotp.indexOf('await finishLegacySrpUpgradeIfNeeded()')
    < afterTotp.indexOf('await finishVaultRecoveryIfNeeded()'),
);

assert.ok(authPy.includes('def _csp_on_app_shell'));
assert.ok(authPy.includes('path.startswith(f"{entry}/")'));
assert.ok(authPy.includes('path == "/api/app-shell"'));
assert.ok(cloud.includes("return `${origin}/app`"));
assert.ok(cloud.includes("https://accounts.google.com/gsi/client"));
assert.ok(sw.includes("const APP_SHELL = '/app'"));

console.log('round63 ui ok');
