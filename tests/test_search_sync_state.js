// Search state across sync events: a file deleted on another device leaves
// the note's search text, a conflict copy is searchable, the index is dropped
// on lock and rebuilt after unlock, and a first pull of many scans does not
// normalise every scan again for every pulled row.
const assert = require('assert');

global.NotesSearch = require('../app/static/js/search.js');
const h = require('./sync_harness');

const { NotesStore, NotesSearch } = h.NotesStore ? { NotesStore: h.NotesStore, NotesSearch: global.NotesSearch } : {};

function hits(query) {
  const tagMap = new Map(NotesStore.listTags().map((tag) => [tag.uuid, tag]));
  return NotesSearch.filterNotes(NotesStore.listNotes(), { query, filter: 'all', tagMap }).map((n) => n.uuid);
}

function attachmentContent(noteId, index, ocr) {
  return {
    type: 'attachment',
    note_id: noteId,
    filename: `scan-${index}.pdf`,
    mime: 'application/pdf',
    size: 1000,
    ocr_text: ocr,
    ocr_method: 'tesseract',
    ocr_index: NotesStore.OCR_INDEX,
    created_at: new Date(1700000000000 + index * 1000).toISOString(),
  };
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // --- a remote attachment delete leaves the note's search text -------------
  const noteId = NotesStore.newUuid();
  const attId = NotesStore.newUuid();
  const noteRow = await h.encryptedRow(noteId, { ...NotesStore.defaultNote(), title: 'Polis', content: '' }, 10, 1001);
  const attRow = await h.encryptedRow(attId, attachmentContent(noteId, 1, 'polisnummer 4419 verzekering'), 11, 1002);
  h.server.pullPages = [{ items: [noteRow, attRow], has_more: false, total_undeleted: 2, cursor: 1002 }];
  await NotesStore.sync({ quiet: true });
  await NotesStore.finishUnlockMaintenance();
  assert.deepStrictEqual(hits('4419'), [noteId], 'scan text arrives with the file');
  assert.match(String(NotesStore.get(noteId).content.ocr_text || ''), /4419/);
  assert.strictEqual(NotesStore.listVisibleAttachments().length, 1);

  h.resetServer();
  const tombstone = await h.encryptedRow(attId, { ...attachmentContent(noteId, 1, 'polisnummer 4419 verzekering'), deleted: true }, 20, 1003, { deleted: true });
  h.server.pullPages = [{ items: [tombstone], has_more: false, total_undeleted: 1, cursor: 1003 }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.get(attId), undefined, 'the file is gone locally');
  assert.deepStrictEqual(hits('4419'), [], 'its scan text no longer finds the note');
  assert.strictEqual(String(NotesStore.get(noteId).content.ocr_text || ''), '', 'the copied scan text on the note is cleared');
  assert.strictEqual(String(NotesStore.get(noteId).content.attachment_names || ''), '', 'and so is the filename list');
  assert.strictEqual(NotesStore.listVisibleAttachments().length, 0, 'Files view agrees');

  // --- a conflict copy is an ordinary, searchable note ----------------------
  const copyId = NotesStore.keepConflictCopy(noteId, { ...NotesStore.get(noteId).content, title: 'Polis', content: 'their 7731 wording' }, { source: 'test' });
  assert.ok(copyId, 'a conflict copy was made');
  assert.deepStrictEqual(hits('7731'), [copyId]);
  assert.deepStrictEqual(hits('"conflict copy"'), [copyId]);

  // --- lock drops the index; unlock maintenance rebuilds it -----------------
  await h.tick();
  assert.strictEqual(NotesSearch.memoryIndexActive(), true);
  NotesStore.lock();
  assert.strictEqual(NotesSearch.memoryIndexActive(), false, 'nothing searchable stays in memory after lock');
  assert.deepStrictEqual(NotesStore.listNotes(), []);

  // --- a first pull of many scans stays linear in the number of scans ------
  await h.unlockFresh();
  h.resetServer();
  const many = [];
  let synced = 2000;
  const N = 150;
  for (let i = 0; i < N; i += 1) {
    const nid = NotesStore.newUuid();
    const aid = NotesStore.newUuid();
    many.push(await h.encryptedRow(nid, { ...NotesStore.defaultNote(), title: `Scan ${i}`, content: '' }, 100 + i, synced++));
    many.push(await h.encryptedRow(aid, attachmentContent(nid, i, `document ${i} ${'tekst '.repeat(20 + (i % 7))}nummer ${5000 + i}`), 100 + i, synced++));
  }
  h.server.pullPages = [{ items: many, has_more: false, total_undeleted: many.length, cursor: synced }];
  const before = NotesStore.searchDiagnostics().ocrIdentityComputed;
  await NotesStore.sync({ quiet: true });
  await NotesStore.finishUnlockMaintenance();
  const computed = NotesStore.searchDiagnostics().ocrIdentityComputed - before;
  assert.ok(computed <= N * 2, `scan text is normalised about once per file, not once per file per pulled row (${computed} for ${N} files)`);
  assert.strictEqual(NotesStore.listAttachments().length, N);
  assert.strictEqual(hits('5042').length, 1, 'every pulled scan is searchable');
  assert.strictEqual(NotesSearch.memoryIndexActive(), true, 'the index is rebuilt after unlock');

  console.log('ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
