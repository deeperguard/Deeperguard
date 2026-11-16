// Search over decrypted notes stays in memory: a word found only in a scan's
// OCR text is reported as a scan hit, nothing readable lands in any storage or
// on the network, the index is gone after lock, and 1000 notes search fast.
const assert = require('assert');

global.NotesSearch = require('../app/static/js/search.js');
const h = require('./sync_harness');

const { NotesStore } = h;
const { NotesSearch } = global;
const SECRET = 'zebrafish7731';
const BUDGET_MS = 1500;

function tagMapNow() {
  return new Map(NotesStore.listTags().map((tag) => [tag.uuid, tag]));
}

function search(query) {
  return NotesSearch.filterNotes(NotesStore.listNotes(), { query, filter: 'all', tagMap: tagMapNow() });
}

function everythingStored() {
  return JSON.stringify([
    [...h.idb.values()],
    [...h.meta.entries()],
    global.localStorage.store,
    global.sessionStorage.store,
  ]).toLowerCase();
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  const rows = [];
  let synced = 3000;
  const N = 1000;
  let scanNoteId = '';
  for (let i = 0; i < N; i += 1) {
    const nid = NotesStore.newUuid();
    rows.push(await h.encryptedRow(nid, {
      ...NotesStore.defaultNote(),
      title: `Notitie ${i}`,
      content: `Vergadering ${i} met ${'lorem ipsum dolor sit amet '.repeat(30)}`,
    }, 100 + i, synced++));
    if (i % 10 === 0) {
      const aid = NotesStore.newUuid();
      const ocr = i === 500 ? `polis ${SECRET} verzekering` : `scan ${i} ${'tekst '.repeat(40)}`;
      if (i === 500) scanNoteId = nid;
      rows.push(await h.encryptedRow(aid, {
        type: 'attachment',
        note_id: nid,
        filename: `scan-${i}.pdf`,
        mime: 'application/pdf',
        size: 1000,
        ocr_text: ocr,
        ocr_method: 'tesseract',
        ocr_index: NotesStore.OCR_INDEX,
        created_at: new Date(1700000000000 + i * 1000).toISOString(),
      }, 100 + i, synced++));
    }
  }
  h.server.pullPages = [{ items: rows, has_more: false, total_undeleted: rows.length, cursor: synced }];
  await NotesStore.sync({ quiet: true });
  await NotesStore.finishUnlockMaintenance();
  assert.strictEqual(NotesStore.listNotes().length, N);

  // A word only in a scan's OCR text finds that note and says it is a scan hit.
  const tagMap = tagMapNow();
  const t0 = performance.now();
  const first = search(SECRET);
  const firstMs = performance.now() - t0;
  assert.deepStrictEqual(first.map((n) => n.uuid), [scanNoteId]);
  const info = NotesSearch.describeMatch(first[0], SECRET, tagMap);
  assert.strictEqual(info.field, 'ocr');
  assert.strictEqual(info.label, 'Scanned document');
  assert.ok(info.snippet.includes(SECRET));

  // Typing: repeated queries over 1000 notes stay inside the budget.
  const queries = ['v', 've', 'verg', 'vergadering 4', 'lorem ipsum', SECRET, 'notitie 999', 'nothing-matches-this'];
  const t1 = performance.now();
  for (const q of queries) search(q);
  const perQuery = (performance.now() - t1) / queries.length;
  console.log(`search 1000 notes: first ${firstMs.toFixed(1)} ms, avg ${perQuery.toFixed(1)} ms per query`);
  assert.ok(firstMs < BUDGET_MS, `first search ${firstMs} ms`);
  assert.ok(perQuery < BUDGET_MS / 4, `average search ${perQuery} ms`);
  assert.strictEqual(search('nothing-matches-this').length, 0);

  // No search term, index or OCR text on the network, and nothing readable stored.
  const sent = JSON.stringify(h.fetchCalls.map((c) => [c.url, c.method, c.body])).toLowerCase();
  assert.ok(!sent.includes(SECRET), 'search term / OCR text never goes to the server');
  assert.ok(!sent.includes('vergadering 4'), 'typed queries never go to the server');
  const stored = everythingStored();
  assert.ok(!stored.includes(SECRET), 'no storage holds plain OCR text');
  assert.ok(!stored.includes('lorem ipsum'), 'no storage holds plain note text');
  assert.ok(!stored.includes('vergadering'), 'no storage holds a plain search index');

  // Lock: the index is gone, and searching finds nothing.
  assert.ok(NotesSearch.memoryIndexNoteCount() > 0);
  NotesStore.lock();
  assert.strictEqual(NotesSearch.memoryIndexActive(), false);
  assert.strictEqual(NotesSearch.memoryIndexNoteCount(), 0);
  assert.strictEqual(search(SECRET).length, 0);
  const afterLock = everythingStored();
  assert.ok(!afterLock.includes(SECRET) && !afterLock.includes('lorem ipsum'), 'storage stays unreadable after lock');

  console.log('ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
