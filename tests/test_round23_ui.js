const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

// 1. Drawer view rows keep a small icon and a 44px row. Desktop icon size stays in the wide layout.
const icon = css.split('body.nav-drawer-open .filter-icon')[1].split('}')[0];
assert.ok(icon.includes('width: 20px !important'));
assert.ok(icon.includes('height: 20px !important'));
assert.ok(icon.includes('flex: 0 0 20px !important'));
const row = css.split('body.nav-drawer-open .filter {')[1].split('}')[0];
assert.ok(row.includes('height: 44px'));
assert.ok(row.includes('max-height: 44px'));
assert.ok(row.includes('border-radius: 8px'));
assert.ok(row.includes('font-size: 16px'));
const views = css.split('body.nav-drawer-open .filter-section > summary.section-label')[1].split('}')[0];
assert.ok(views.includes('min-height: 44px !important'));
assert.ok(views.includes('font-size: 16px'));
assert.ok(appJs.includes('panel.style.paddingTop'));
assert.ok(css.includes('.filter-icon {\n    width: 16px;\n    height: 16px;'));
assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

// 2. Lock, sign-out, and a successful unlock clear the password field.
assert.ok(appJs.includes('function clearUnlockPasswordField()'));
assert.ok(appJs.includes('unlockPassword.value = \'\''));
const lockFn = appJs.slice(appJs.indexOf('async function lockVault('), appJs.indexOf('function rememberOpen('));
assert.ok(lockFn.includes('clearUnlockPasswordField()'));
const showUnlock = appJs.slice(appJs.indexOf('function showUnlock('), appJs.indexOf('function updateSecureContextHint('));
assert.ok(showUnlock.includes('clearUnlockPasswordField()'));
const finished = appJs.slice(appJs.indexOf('async function finishUnlocked('), appJs.indexOf('async function finishUnlocked(') + 400);
assert.ok(finished.includes('clearUnlockPasswordField()'));
const leave = appJs.slice(appJs.indexOf('async function clearLocalVaultAndLeave('), appJs.indexOf('async function clearLocalVaultAndLeave(') + 200);
assert.ok(leave.includes('clearUnlockPasswordField()'));

// 3. The first login-required push or pull raises the not-syncing banner.
assert.ok(storeJs.includes("emitSync('session-expired', 'Not syncing — sign in again')"));
assert.ok(storeJs.includes("phase !== 'session-expired'"));
const indicator = appJs.slice(appJs.indexOf('function setSyncIndicator('), appJs.indexOf('function setSyncIndicator(') + 280);
assert.ok(indicator.includes("state === 'session-expired'"));
assert.ok(indicator.includes('showExpiredSessionBanner()'));
const syncAt = appJs.lastIndexOf("if (err?.code === 'VAULT_LOCKED')");
const syncCatch = appJs.slice(syncAt, syncAt + 500);
assert.ok(syncCatch.includes('if (isLoginRequiredError(err))'));
assert.ok(syncCatch.includes('showExpiredSessionBanner()'));

console.log('round 23 ui ok');
