const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(
  path.join(__dirname, '../app/static/js/app.js'),
  'utf8',
);

const alertStart = appJs.indexOf('function showSessionExpiredAlert()');
const alertEnd = appJs.indexOf('async function ensureServerSession(options = {})');
assert.ok(alertStart >= 0 && alertEnd > alertStart);
const alertFn = appJs.slice(alertStart, alertEnd);

assert.match(alertFn, /isUnlockScreenVisible\(\)/);
assert.match(alertFn, /showUnlockSessionHint\(\)/);
assert.ok(
  alertFn.indexOf('isUnlockScreenVisible()') < alertFn.indexOf('sessionExpiredAlertShown = true'),
  'unlock screen guard must run before showing the modal',
);

const syncLockedStart = appJs.indexOf('async function syncWhileVaultLocked(');
const syncLockedEnd = appJs.indexOf('function runBackgroundSync()');
const syncLockedFn = appJs.slice(syncLockedStart, syncLockedEnd);
assert.match(syncLockedFn, /ensureServerSession\(\{ prompt: false \}\)/);
assert.match(syncLockedFn, /emitSync\('pending', 'Sign in to sync'\)/);

const toastStart = appJs.indexOf('function toast(message, isError = false)');
const toastEnd = appJs.indexOf('const totpUi = {');
assert.ok(toastStart >= 0 && toastEnd > toastStart);
const toastFn = appJs.slice(toastStart, toastEnd);
assert.match(toastFn, /shouldShowLockScreenToast/);
assert.match(toastFn, /isUnlockScreenVisible\(\)/);
assert.match(appJs, /body\.classList\.contains\('locked'\) \|\| isUnlockScreenVisible\(\)/);

console.log('test_session_repair.js: ok');
