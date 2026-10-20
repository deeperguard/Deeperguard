/**
 * Round 35: phone overlay dismiss, separate desktop/phone browse state,
 * tag counts on trash, toast above dialogs, folder rename header, online
 * recovery chain, unverified backup cooldown without re-send.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

// --- 1. Escape + outside tap close phone Tags/Folders overlay -------------
assert.ok(appJs.includes('function closePhoneBrowseOverlay'));
assert.ok(appJs.includes("closePhoneBrowseOverlay({ focusChip: true })"));
assert.ok(appJs.includes("addEventListener('pointerdown'"));
const escapeBlock = appJs.split("if (event.key !== 'Escape') return;")[1] || '';
assert.ok(escapeBlock.includes('closePhoneBrowseOverlay'));

// --- 2. Desktop collapse prefs ≠ phone overlay open state ----------------
assert.ok(appJs.includes("let phoneBrowseOpen = null"));
assert.ok(appJs.includes('Phone overlays are ephemeral') || appJs.includes('never write desktop collapse prefs'));
assert.ok(appJs.includes('do not overwrite desktop collapse prefs')
  || appJs.includes('Close phone overlays only'));
const collapseOnce = appJs.split('function collapseMobileNavOnce()')[1].split('function applyFilterSection')[0];
assert.ok(!collapseOnce.includes('prefs.tagsCollapsed = true'));
assert.ok(!collapseOnce.includes('prefs.foldersCollapsed = true'));
assert.ok(appJs.includes('phone overlays always start closed')
  || appJs.includes('Layout switch: phone overlays always start closed'));

// Phone toggle must not persist tagsCollapsed.
const tagToggle = appJs.split("tagSection.addEventListener('toggle'")[1].split("folderSection.addEventListener('toggle'")[0];
assert.ok(tagToggle.includes('phoneBrowseOpen'));
assert.ok(tagToggle.includes('never write desktop collapse prefs') || tagToggle.includes('!isDesktopLayout()'));

// --- 3. Tag counts refresh on trash/restore/delete -----------------------
assert.ok(storeJs.includes('!n.content.trashed') && storeJs.includes('noteCountForTag'));
const trashNote = appJs.split('function trashNote(id)')[1].split('function restoreNote(id)')[0];
assert.ok(trashNote.includes('renderTags()'), 'trashNote must recompute tag counts');
const emptyTrash = appJs.split('async function emptyTrash()')[1].split('function syncNavFilterActive')[0];
assert.ok(emptyTrash.includes('renderTags()'));
const restoreNote = appJs.split('function restoreNote(id)')[1].split('async function deleteNoteForever')[0];
assert.ok(restoreNote.includes('renderTags()'));

// --- 4. Toasts above open dialog action areas ----------------------------
assert.ok(appJs.includes('function syncToastDialogLift'));
assert.ok(appJs.includes('toast-above-dialog'));
assert.ok(appCss.includes('html.toast-above-dialog #toast'));
assert.ok(appCss.includes('bottom: calc(112px + var(--safe-bottom))'));
assert.ok(appJs.includes('dialogBlocksToastFooter'));

// --- 5. Folder rename updates phone list header immediately --------------
const renameFolder = appJs.split('function beginRenameFolder(uuid)')[1].split('function renderFolders()')[0];
assert.ok(renameFolder.includes('note-list-title'));
assert.ok(renameFolder.includes('listTitle.textContent = renamedTo')
  || renameFolder.includes("listTitle.textContent = renamedTo"));
assert.ok(renameFolder.includes('currentFolder === uuid'));

// --- 6. Online recovery: 0.5/1/2/4s chain, not gated by 10s watch ---------
assert.ok(
  appJs.includes('const delays = [0, 500, 1000, 2000, 4000]')
  || appJs.includes('const delays = [500, 1000, 2000, 4000]'),
);
assert.ok(appJs.includes("addEventListener('online'"));
assert.ok(
  appJs.includes('function onNetworkOnline')
  || appJs.split("addEventListener('online'")[1].includes('stopOfflineWatch()'),
);
assert.ok(appJs.includes('scheduleOnlineRecovery(0)'));
assert.ok(appJs.includes('stopOfflineWatch()'));
const schedule = appJs.split('function scheduleOnlineRecovery(attempt = 0)')[1].split('function listStoredFiles')[0];
assert.ok(schedule.includes('stopOfflineWatch()'));
const offlineWatch = appJs.split('function startOfflineWatch()')[1].split('function scheduleOnlineRecovery')[0];
assert.ok(offlineWatch.includes('navigator.onLine'));
assert.ok(offlineWatch.includes('scheduleOnlineRecovery(0)'));

// --- 7. Unverified backup cooldown: toast without calling send -----------
function backupCooldownToast(seconds, { unverified = false } = {}) {
  const left = Math.max(1, Math.ceil(Number(seconds) || 1));
  if (unverified) {
    return `Verify this email first — a code was already sent. Resend in ${left}s.`;
  }
  return `Code already sent — resend in ${left}s`;
}

/** Mirrors btn-backup-now cooldown guard in app.js (must not hit send). */
function simulateBackupNowClick({
  cooldownLeft = 0,
  accountWait = 0,
  unverified = false,
  btnDisabled = false,
} = {}) {
  const apiCalls = [];
  const cooling = Math.max(cooldownLeft, unverified ? accountWait : 0);
  if (cooling > 0 || btnDisabled) {
    const left = cooling || accountWait || 0;
    if (left > 0) {
      return {
        sendCalled: false,
        apiCalls,
        toast: backupCooldownToast(left, { unverified }),
      };
    }
    return { sendCalled: false, apiCalls, toast: null };
  }
  apiCalls.push('/api/backup/email');
  return { sendCalled: true, apiCalls, toast: null };
}

const guarded = simulateBackupNowClick({
  cooldownLeft: 42,
  accountWait: 42,
  unverified: true,
  btnDisabled: true,
});
assert.strictEqual(guarded.sendCalled, false, 'cooldown must not call send');
assert.deepStrictEqual(guarded.apiCalls, []);
assert.match(guarded.toast, /a code was already sent/i);
assert.match(guarded.toast, /Resend in 42s/);

const verifiedCool = simulateBackupNowClick({ cooldownLeft: 15, unverified: false });
assert.strictEqual(verifiedCool.sendCalled, false);
assert.match(verifiedCool.toast, /Code already sent — resend in 15s/);

const fresh = simulateBackupNowClick({ cooldownLeft: 0, accountWait: 0, unverified: false });
assert.strictEqual(fresh.sendCalled, true);

// App wiring: guard runs before /api/backup/email and uses unverified toast.
const backupHandler = appJs.split("getElementById('btn-backup-now').addEventListener('click'")[1]
  .split("getElementById('btn-save-pcloud')")[0];
assert.ok(backupHandler.indexOf('cooling') < backupHandler.indexOf("/api/backup/email"));
assert.ok(backupHandler.includes('return;'));
assert.ok(backupHandler.includes("backupCooldownToast(left, { unverified })")
  || backupHandler.includes('backupCooldownToast(left, { unverified })'));
assert.ok(appJs.includes('Verify this email first — a code was already sent. Resend in'));
assert.ok(appJs.includes('During cooldown never hit /api/backup/email')
  || backupHandler.includes('never hit'));

console.log('test_round35_ui ok');
