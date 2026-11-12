/**
 * Features room: deletion / revoke sync honesty — pending vs confirmed gone copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const securityHtml = fs.readFileSync(path.join(root, 'app/templates/security.html'), 'utf8');
const honestyJs = fs.readFileSync(
  path.join(root, 'app/static/js/deletion-sync-honesty.js'),
  'utf8',
);

assert.ok(appHtml.includes('js/deletion-sync-honesty.js'));
assert.ok(appJs.includes('NotesDeletionSyncHonesty'));
assert.ok(!appJs.includes('Other devices drop them on next sync'));
assert.ok(!appJs.includes('Other devices drop it on their next sync'));
assert.ok(!appJs.includes('It will stop working for anyone who still has it'));
assert.ok(!appJs.includes('stops working now'));
assert.ok(securityHtml.includes('never shown as confirmed gone'));

const sandbox = { window: {} };
sandbox.window = sandbox;
vm.runInNewContext(honestyJs, sandbox);
const H = sandbox.window.NotesDeletionSyncHonesty;
assert.ok(H);

const singleConfirm = H.permanentDeleteConfirmMessage({ count: 1 });
assert.ok(singleConfirm.includes('confirmed gone on this device'));
assert.ok(singleConfirm.includes('pending until sync uploads'));
assert.ok(singleConfirm.includes('not treat an offline'));
assert.ok(!singleConfirm.match(/drop them on next sync/i));
assert.ok(singleConfirm.includes('Not removed:'));
assert.ok(singleConfirm.includes('Existing backups'));
assert.ok(!singleConfirm.includes('Secure Send'));
const sharedConfirm = H.permanentDeleteConfirmMessage({ count: 1, sharedLinks: 1 });
assert.ok(sharedConfirm.includes('A Secure Send link made from this note'));
assert.ok(H.permanentDeleteConfirmMessage({ count: 2, sharedLinks: 2 }).includes('2 Secure Send links'));
assert.ok(appJs.includes("setAttribute('aria-describedby', 'confirm-message')"));
assert.ok(appJs.includes('activeSecureSendLinkCount([id])'));
assert.ok(singleConfirm.includes('encrypted marker'));
assert.ok(!singleConfirm.match(/permanently erased|gone everywhere|no copies remain/i));

const bulkConfirm = H.permanentDeleteConfirmMessage({ count: 3 });
assert.ok(bulkConfirm.includes('These 3 notes'));

const toastOne = H.permanentDeleteToastMessage({ count: 1 });
assert.ok(toastOne.includes('Confirmed gone on this device'));
assert.ok(toastOne.includes('Still pending'));

const revokeConfirm = H.secureSendRevokeConfirmMessage();
assert.ok(revokeConfirm.includes('pending until they fetch again'));
assert.ok(revokeConfirm.includes('cannot confirm'));

const revokeToast = H.secureSendRevokeToastMessage();
assert.ok(revokeToast.includes('pending'));

const emptyTrashFn = appJs.split('async function emptyTrash()')[1].split('function syncNavFilterActive')[0];
assert.ok(emptyTrashFn.includes('NotesDeletionSyncHonesty.permanentDeleteConfirmMessage'));

const delForeverFn = appJs.split('async function deleteNoteForever(id)')[1].split('function deleteFromList(id)')[0];
assert.ok(delForeverFn.includes('NotesDeletionSyncHonesty.permanentDeleteConfirmMessage'));
assert.ok(delForeverFn.includes('NotesDeletionSyncHonesty.permanentDeleteToastMessage'));

console.log('test_moltbook_deletion_sync_honesty ok');
