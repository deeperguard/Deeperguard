const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'app/static/js/app.js'), 'utf8');

const signOutBlock = appJs.slice(
  appJs.indexOf('const SIGN_OUT_WARNING'),
  appJs.indexOf('async function clearLocalVaultAndLeave'),
);

assert.ok(signOutBlock.includes('function unsyncedLocalItemCount('));
assert.ok(signOutBlock.includes('function confirmSignOutDirtyGate('));
assert.ok(signOutBlock.includes('function confirmUserSignOut('));
assert.ok(signOutBlock.includes('extraLabel: \'Sync now\''));
assert.ok(signOutBlock.includes('confirmLabel: \'Sign out anyway\''));
assert.ok(signOutBlock.includes('extraLabel: \'Sign out and lose unsynced notes\''));
assert.ok(signOutBlock.includes('confirmLabel: \'Delete unsynced notes and sign out\''));
assert.ok(signOutBlock.includes('not finished syncing'));
assert.ok(signOutBlock.includes('not guaranteed on the server'));

const requestSignOutFn = appJs.slice(
  appJs.indexOf('async function requestSignOut()'),
  appJs.indexOf("document.getElementById('unlock-signout').addEventListener"),
);
assert.ok(requestSignOutFn.includes('confirmUserSignOut()'));
assert.ok(!requestSignOutFn.includes('confirmAction(SIGN_OUT_WARNING'));

const denyFn = appJs.slice(
  appJs.indexOf('async function denyPendingDevice('),
  appJs.indexOf('async function revokeSignedInDevice('),
);
assert.ok(denyFn.includes('confirmUserSignOut({'));
assert.ok(!denyFn.includes('SIGN_OUT_WARNING'));

const revokeFn = appJs.slice(
  appJs.indexOf('async function revokeSignedInDevice('),
  appJs.indexOf('window.__notesRefreshAccountPasskeySignin'),
);
assert.ok(revokeFn.includes('confirmUserSignOut({'));

console.log('test_sign_out_dirty_sync.js: ok');
