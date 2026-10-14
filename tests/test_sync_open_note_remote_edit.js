// Regression: a note open in the editor never showed edits pulled from another
// device, and the next keystroke or the flush on lock wrote the stale editor
// buffer back over them. The editor must reload when it has nothing unsaved,
// and keep both texts (conflict copy) when it does.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');

const { NotesStore } = h;
const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
global.NotesSearch = require(path.join(jsRoot, 'search.js'));
global.CSS = { escape: (s) => s };

// Lift the editor save/reconcile logic out of app.js and run it against the
// real store with a minimal editor stub.
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
function slice(startMarker, endMarker) {
  const start = appJs.indexOf(startMarker);
  const end = appJs.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `app.js markers: ${startMarker} … ${endMarker}`);
  return appJs.slice(start, end);
}
const baselineSrc = slice('let editorBaseline = null;', 'let toastTimer = null;');
const flushSrc = slice('function flushSave() {', 'function scheduleSave() {');
const calls = [];
const ui = {
  title: { value: '', title: '' },
  body: { value: '' },
  editorType: { value: 'plain' },
  saveStatus: { textContent: '', classList: { remove() {}, add() {} } },
  noteList: { querySelector: () => null },
};
const editor = new Function('scope', `
  const { ui, NotesStore, NotesSearch, calls } = scope;
  let currentId = null;
  let saveDebounce = null;
  let ingestBusy = false;
  const unlockedNotes = new Set();
  const updateNoteMeta = () => calls.push('meta');
  const maybeOfferWritingTip = () => {};
  const resetNoteUndoStack = () => calls.push('undo-reset');
  const applyEditorMode = () => {};
  const renderHistory = () => {};
  const updateActionButtons = () => {};
  ${baselineSrc}
  ${flushSrc}
  return {
    flushSave,
    reconcileOpenNoteWithStore,
    captureEditorBaseline,
    open(id) {
      currentId = id;
      const note = NotesStore.get(id);
      ui.title.value = NotesSearch.effectiveNoteTitle(note);
      ui.body.value = note.content.content || '';
      captureEditorBaseline(note, false);
    },
    close() { currentId = null; editorBaseline = null; },
    baseline() { return editorBaseline; },
  };
`)({ ui, NotesStore, NotesSearch: global.NotesSearch, calls });

(async () => {
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  const ingested = [];
  NotesStore.setNoteIngestedCallback((uuid, meta) => ingested.push({ uuid, meta }));

  // --- 1. Idle editor: a pulled edit replaces the editor text ---------------
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Shopping', title_manual: true, content: 'milk' });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  editor.open(noteId);
  assert.strictEqual(ui.body.value, 'milk');

  const phoneEdit = { ...NotesStore.get(noteId).content, content: 'milk\neggs' };
  h.server.pullPages = [{
    items: [await h.encryptedRow(noteId, phoneEdit, Date.now() / 1000 + 1, 2001)],
    has_more: false,
    total_undeleted: 1,
    cursor: 2002,
  }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.get(noteId).content.content, 'milk\neggs', 'store took the phone edit');
  const meta = ingested.find((e) => e.uuid === noteId)?.meta;
  assert.ok(meta, 'ingest callback fired for the open note');
  assert.strictEqual(meta.bodyChanged, true, 'callback reports a text change');
  assert.strictEqual(meta.previousContent?.content, 'milk', 'callback carries the pre-pull text');

  // What app.js does on that callback:
  assert.strictEqual(editor.reconcileOpenNoteWithStore(noteId), 'reloaded');
  assert.strictEqual(ui.body.value, 'milk\neggs', 'editor shows the remote text');

  // A later keystroke-free flush (e.g. lockVault) must not write anything.
  h.resetServer();
  editor.flushSave();
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false, 'idle flush after a remote edit is a no-op');
  assert.strictEqual(NotesStore.get(noteId).content.content, 'milk\neggs');

  // --- 2. Stale buffer without reconcile: flushSave itself must refuse -------
  const laptopEdit = { ...NotesStore.get(noteId).content, content: 'milk\neggs\nbread' };
  h.server.pullPages = [{
    items: [await h.encryptedRow(noteId, laptopEdit, Date.now() / 1000 + 2, 2003)],
    has_more: false,
    total_undeleted: 1,
    cursor: 2004,
  }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.get(noteId).content.content, 'milk\neggs\nbread');
  // Editor still holds 'milk\neggs' (nobody called reconcile), the vault locks:
  editor.flushSave();
  assert.strictEqual(NotesStore.get(noteId).content.content, 'milk\neggs\nbread', 'stale buffer is not written back on lock');
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false, 'nothing queued for push');
  assert.strictEqual(ui.body.value, 'milk\neggs\nbread', 'editor reloaded instead');

  // --- 3. Unsaved typing: both versions survive as separate notes -----------
  ui.body.value = 'milk\neggs\nbread\nbutter (typed here)';
  const tabletEdit = { ...NotesStore.get(noteId).content, content: 'milk\neggs\nbread\ncheese (typed on tablet)' };
  h.server.pullPages = [{
    items: [await h.encryptedRow(noteId, tabletEdit, Date.now() / 1000 + 3, 2005)],
    has_more: false,
    total_undeleted: 1,
    cursor: 2006,
  }];
  await NotesStore.sync({ quiet: true });
  const notesBefore = NotesStore.listNotes().length;
  assert.strictEqual(editor.reconcileOpenNoteWithStore(noteId), 'conflict');
  editor.flushSave();
  const notes = NotesStore.listNotes();
  assert.strictEqual(notes.length, notesBefore + 1, 'a conflict copy was created');
  const copy = notes.find((n) => n.content.conflict_of === noteId);
  assert.ok(copy, 'copy points at the original');
  assert.strictEqual(copy.content.title, 'Shopping (conflict copy)');
  assert.strictEqual(copy.content.content, 'milk\neggs\nbread\ncheese (typed on tablet)', 'copy holds the remote text');
  assert.strictEqual(NotesStore.get(noteId).content.content, 'milk\neggs\nbread\nbutter (typed here)', 'editor text stays the live note');
  assert.ok(NotesStore.state.dirty.has(noteId) && NotesStore.state.dirty.has(copy.uuid), 'both go to the server');
  h.stopPushTimer();

  // Same-text pulls (e.g. our own push echoed back) do not create copies.
  await NotesStore.pushDirty({ quiet: true });
  h.server.pullPages = [{
    items: [await h.encryptedRow(noteId, NotesStore.get(noteId).content, Date.now() / 1000 + 4, 2007)],
    has_more: false,
    total_undeleted: 2,
    cursor: 2008,
  }];
  ingested.length = 0;
  await NotesStore.sync({ quiet: true });
  const echo = ingested.find((e) => e.uuid === noteId)?.meta;
  assert.ok(!echo || echo.bodyChanged === false, 'identical text is not reported as a change');
  assert.strictEqual(NotesStore.listNotes().length, notesBefore + 1, 'no extra copies');

  // keepConflictCopy never duplicates attachments or identical text.
  assert.strictEqual(NotesStore.keepConflictCopy(noteId, NotesStore.get(noteId).content), null);
  const withAtt = { ...NotesStore.get(noteId).content, content: 'other', attachments: ['att-1'], ocr_text: 'scan' };
  const copyId = NotesStore.keepConflictCopy(noteId, withAtt, { source: 'test' });
  assert.deepStrictEqual(NotesStore.get(copyId).content.attachments, []);
  assert.strictEqual(NotesStore.get(copyId).content.ocr_text, undefined);
  h.stopPushTimer();

  console.log('test_sync_open_note_remote_edit.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
