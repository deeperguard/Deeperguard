/**
 * Round 34: empty New-note drafts must discard after create → wait → switch,
 * even if they already got a sync rev. Ever-had-user-content notes stay.
 * Unverified backup cooldown must not re-claim "We sent a code".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NotesSearch = require('../app/static/js/search.js');
const {
  noteIsEmptyStub,
  noteHasBeenSaved,
  noteMayHardDiscard,
} = NotesSearch;

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

function note(content, extra = {}) {
  return {
    uuid: extra.uuid || 'n1',
    rev: extra.rev != null ? extra.rev : 0,
    content: { type: 'note', tags: [], attachments: [], revisions: [], ...content },
  };
}

// --- Live sequence A2a: create empty → (sync rev) → switch must discard -----
const emptyLocal = note({ title: '', content: '' }, { rev: 0 });
assert.strictEqual(noteIsEmptyStub(emptyLocal), true);
assert.strictEqual(noteHasBeenSaved(emptyLocal), false);
assert.strictEqual(noteMayHardDiscard(emptyLocal), true);

// After push/sync the shell has rev>0 but still no user content.
const emptySynced = note({ title: '', content: '' }, { rev: 7 });
assert.strictEqual(noteHasBeenSaved(emptySynced), false, 'rev alone is not ever-saved');
assert.strictEqual(noteMayHardDiscard(emptySynced), true, 'synced empty shell is discardable');

// Empty revision snapshots (autosave of blank→blank) do not count.
const emptyRevs = note({
  title: '   ',
  content: '\n  ',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: '', content: '' }],
}, { rev: 3 });
assert.strictEqual(noteHasBeenSaved(emptyRevs), false);
assert.strictEqual(noteMayHardDiscard(emptyRevs), true);

// Tag-only draft is kept (live A2b-c PASS).
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '', tags: ['t1'] })), false);
assert.strictEqual(noteHasBeenSaved(note({ title: '', content: '', tags: ['t1'] })), true);

// Folder-seeded draft is kept.
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '', folder_id: 'f1' })), false);

// Round 32: ever had body, then cleared → NEVER discard.
const savedThenCleared = note({
  title: '   ',
  content: '   \n  ',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: '', content: 'hello body' }],
}, { rev: 4 });
assert.strictEqual(noteIsEmptyStub(savedThenCleared), true);
assert.strictEqual(noteHasBeenSaved(savedThenCleared), true);
assert.strictEqual(noteMayHardDiscard(savedThenCleared), false);

// Title-only history also protects.
assert.strictEqual(noteMayHardDiscard(note({
  title: '',
  content: '',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: 'Named', content: '' }],
}, { rev: 2 })), false);

// --- App wiring: create skips dirty; discard uses forgetLocal / remove -----
assert.ok(appJs.includes('skipDirty: !seeded'));
assert.ok(storeJs.includes('function forgetLocal'));
assert.ok(storeJs.includes('forgetLocal,'));
assert.ok(appJs.includes('NotesStore.forgetLocal'));
assert.ok(appJs.includes('discardEmptyDraftNote(previousId)'));
assert.ok(searchJs.includes('snapshotHasUserContent') || searchJs.includes('function noteHasBeenSaved'));

// flushSave discard goes through discardEmptyDraftNote (tombstone or forget).
const flush = appJs.split('function flushSave()')[1].split('function scheduleSave()')[0];
assert.ok(flush.includes('discardEmptyDraftNote(currentId)'));

// Simulate create → 3s idle → open other note: discard probe with rev must pass.
function simulateLiveSwitch(draft) {
  assert.ok(noteMayHardDiscard(draft), 'live switch would keep Untitled');
  return true;
}
simulateLiveSwitch(note({ title: '', content: '' }, { rev: 1 }));
simulateLiveSwitch(note({
  title: '',
  content: '',
  revisions: [{ at: '2026-10-20T08:00:00.000Z', title: '', content: '' }],
}, { rev: 9 }));

// --- Backup unverified cooldown toast ---------------------------------------
assert.ok(appJs.includes('Verify this email first — a code was already sent. Resend in'));
assert.ok(appJs.includes('backupVerifyCodePending'));
assert.ok(appJs.includes('backupCooldownToast'));
// Guard must run before /api/backup/email.
const backupHandler = appJs.split("getElementById('btn-backup-now').addEventListener('click'")[1]
  .split("getElementById('btn-save-pcloud')")[0];
assert.ok(backupHandler.indexOf('cooling') < backupHandler.indexOf("/api/backup/email"));
assert.ok(backupHandler.includes('never hit') || backupHandler.includes('During cooldown'));
assert.ok(backupHandler.includes('/too many/i'));

console.log('test_round34_empty_draft ok');
