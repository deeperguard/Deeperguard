// Search audit regressions: query terms (quotes, whitespace, short numbers,
// diacritics), spreadsheet cells instead of JSON, the Files view on protected
// notes, highlight ranges that agree with the list, and the in-memory index
// noticing changes made under it.
const assert = require('assert');

// A minimal vault so search reads attachments the way the app does.
const vault = new Map();
global.NotesStore = {
  listAttachments(noteId) {
    const all = [...vault.values()];
    if (noteId == null) return all;
    return all.filter((att) => att.content.note_id === noteId);
  },
};

const Search = require('../app/static/js/search.js');
const {
  filterNotes,
  describeMatch,
  findMatches,
  highlightPlain,
  fileRowMatches,
  matchesNoteOrFileName,
  parseQueryTerms,
  textHasQuery,
  snippetAround,
  indexNote,
  indexNotes,
  clearMemoryIndex,
  memoryIndexActive,
  searchableBody,
} = Search;

function note(overrides) {
  return {
    uuid: overrides.uuid || 'n',
    content: {
      type: 'note',
      title: 'Untitled',
      content: '',
      tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

function ids(list) {
  return list.map((n) => n.uuid).sort();
}

const tagMap = new Map([
  ['tag-fin', { uuid: 'tag-fin', content: { title: 'Financiën' } }],
]);

// --- query parsing ---------------------------------------------------------
assert.deepStrictEqual(parseQueryTerms('invoice 136').map((t) => t.text), ['invoice', '136']);
assert.deepStrictEqual(parseQueryTerms('"invoice 136"').map((t) => t.text), ['invoice 136']);
assert.deepStrictEqual(parseQueryTerms('“invoice 136” due').map((t) => t.text), ['invoice 136', 'due']);
assert.deepStrictEqual(parseQueryTerms('  Invoice    136  ').map((t) => t.text), ['invoice', '136']);
assert.deepStrictEqual(parseQueryTerms('"unterminated phrase').map((t) => t.text), ['unterminated phrase']);
assert.deepStrictEqual(parseQueryTerms('""').map((t) => t.text), []);
assert.deepStrictEqual(parseQueryTerms('').map((t) => t.text), []);

// --- whitespace and order in multi-word queries ---------------------------
const invoiceNote = note({ uuid: 'inv', title: 'Invoice', content: 'Amount 136 due\nin May' });
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: 'invoice 136', tagMap })), ['inv'],
  'words may sit in different fields');
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: 'due   in', tagMap })), ['inv'],
  'extra spaces in the box do not matter');
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: '"due in"', tagMap })), ['inv'],
  'a quoted phrase matches across a line break');
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: 'may 136', tagMap })), ['inv'],
  'order does not matter for bare words');
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: '"136 may"', tagMap })), [],
  'a quoted phrase keeps its order');
assert.deepStrictEqual(ids(filterNotes([invoiceNote], { filter: 'all', query: 'invoice 137', tagMap })), [],
  'every word must be present');
assert.deepStrictEqual(ids(filterNotes([note({ uuid: 'long', title: 'Invoice 1360' })], { filter: 'all', query: '"invoice 136"', tagMap })), [],
  'a short number inside a phrase is still a whole token');

const crossField = describeMatch(invoiceNote, 'invoice 136', tagMap);
assert.ok(crossField, 'cross-field match is described');
assert.strictEqual(crossField.field, 'title');
const bodyPhrase = describeMatch(invoiceNote, '"136 due"', tagMap);
assert.strictEqual(bodyPhrase.field, 'body');
assert.match(bodyPhrase.snippet, /136 due/);

// --- numbers with separators, decimals, dates -----------------------------
const refNote = note({ uuid: 'ref', title: 'Dossier', content: 'Kenmerk 2026-0198, bedrag €136,50 op 15-10-2026' });
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '0198', tagMap })), ['ref']);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '2026-0198', tagMap })), ['ref']);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '136,50', tagMap })), ['ref']);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '136', tagMap })), ['ref']);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '15-10-2026', tagMap })), ['ref']);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '198', tagMap })), []);
assert.deepStrictEqual(ids(filterNotes([refNote], { filter: 'all', query: '2026', tagMap })), ['ref']);

// --- Dutch diacritics and case ----------------------------------------------
const dutch = note({ uuid: 'nl', title: 'Coördinatie', content: 'Eén café, geïnformeerd. ÉÉN keer.', tags: ['tag-fin'] });
assert.deepStrictEqual(ids(filterNotes([dutch], { filter: 'all', query: 'coordinatie', tagMap })), ['nl']);
assert.deepStrictEqual(ids(filterNotes([dutch], { filter: 'all', query: 'een cafe', tagMap })), ['nl']);
assert.deepStrictEqual(ids(filterNotes([dutch], { filter: 'all', query: 'GEÏNFORMEERD', tagMap })), ['nl']);
assert.deepStrictEqual(ids(filterNotes([dutch], { filter: 'all', query: 'financien', tagMap })), ['nl'], 'tag title folds too');
assert.strictEqual(describeMatch(dutch, 'financien', tagMap).field, 'tag');
assert.deepStrictEqual(findMatches('Eén café', 'een'), [{ start: 0, end: 3 }], 'highlight offsets stay aligned with the original text');
assert.deepStrictEqual(findMatches('Eén café', 'cafe'), [{ start: 4, end: 8 }]);

// --- spreadsheet notes search cells, not JSON ------------------------------
const sheetJson = '{"activeSheet":"Budget","sheets":[{"name":"Budget","rows":[{"index":0,"cells":[{"value":"Huur","index":0},{"value":1360,"index":1}]},{"index":1,"cells":[{"value":"Gas 136","index":0}]}]}]}';
const sheet = note({ uuid: 'sheet', title: '', content: sheetJson });
assert.strictEqual(searchableBody(sheet).includes('activeSheet'), false);
assert.deepStrictEqual(ids(filterNotes([sheet], { filter: 'all', query: 'activeSheet', tagMap })), [], 'JSON keys are not content');
assert.deepStrictEqual(ids(filterNotes([sheet], { filter: 'all', query: 'cells', tagMap })), []);
assert.deepStrictEqual(ids(filterNotes([sheet], { filter: 'all', query: 'index', tagMap })), []);
assert.deepStrictEqual(ids(filterNotes([sheet], { filter: 'all', query: 'huur', tagMap })), ['sheet']);
assert.deepStrictEqual(ids(filterNotes([sheet], { filter: 'all', query: '136', tagMap })), ['sheet']);
const sheetInfo = describeMatch(sheet, 'gas', tagMap);
assert.strictEqual(sheetInfo.field, 'body');
assert.doesNotMatch(sheetInfo.snippet, /[{}"]/, 'snippet shows cell text, not JSON');
const bigRows = Array.from({ length: 400 }, (_, i) => `{"index":${i},"cells":[{"value":"regel ${i} ${'x'.repeat(40)}","index":0}]}`);
const bigSheet = note({ uuid: 'big', title: '', content: `{"activeSheet":"S","sheets":[{"name":"S","rows":[${bigRows.join(',')},{"index":400,"cells":[{"value":"naaldhooiberg","index":0}]}]}]}` });
assert.ok(bigSheet.content.content.length > 8192);
indexNote(bigSheet, tagMap);
assert.deepStrictEqual(ids(filterNotes([bigSheet], { filter: 'all', query: 'naaldhooiberg', tagMap })), ['big'], 'a late cell is still found');

// --- Files view: protected parents -----------------------------------------
const lockedParent = note({ uuid: 'lp', title: 'Kluis', locked: true });
const lockedFile = { uuid: 'lf', content: { type: 'attachment', note_id: 'lp', filename: 'paspoort-136.pdf', mime: 'application/pdf', ocr_text: 'geheim 4419' } };
assert.strictEqual(fileRowMatches(lockedFile, lockedParent, '4419'), false, 'a locked note does not leak scan text through Files');
assert.strictEqual(fileRowMatches(lockedFile, lockedParent, '136'), false, 'nor its filename');
assert.strictEqual(fileRowMatches(lockedFile, lockedParent, 'kluis'), true, 'title still finds it');
const readOnlyParent = note({ uuid: 'rp', title: 'Docs', prevent_edit: true });
const readOnlyFile = { uuid: 'rf', content: { type: 'attachment', note_id: 'rp', filename: 'contract.pdf', mime: 'application/pdf', ocr_text: 'clausule 77' } };
assert.strictEqual(fileRowMatches(readOnlyFile, readOnlyParent, 'clausule'), false, 'read-only scan text needs the Protected switch');
assert.strictEqual(fileRowMatches(readOnlyFile, readOnlyParent, 'clausule', { includeProtected: true }), true);
assert.strictEqual(fileRowMatches(readOnlyFile, readOnlyParent, 'contract'), true, 'filename stays searchable, as in the note list');
const renamed = { uuid: 'rn', content: { type: 'attachment', note_id: 'n', filename: 'scan.pdf', original_filename: 'Factuur-2026-0198.pdf', mime: 'application/pdf' } };
assert.strictEqual(fileRowMatches(renamed, note({ uuid: 'n', title: 'Note' }), '0198'), true, 'original filename counts in Files too');
assert.strictEqual(fileRowMatches(
  { content: { filename: 'invoice.pdf', mime: 'application/pdf', ocr_text: 'total 136 due' } },
  note({ title: 'Parent' }),
  'parent 136',
), true, 'words may be split between title and scan');

// --- highlight ranges agree with the list ----------------------------------
assert.deepStrictEqual(findMatches('Invoice 1360 and 136', '136'), [{ start: 17, end: 20 }], 'short numbers highlight whole tokens only');
assert.deepStrictEqual(findMatches('Invoice 1360 and 136', '136', { literal: true }), [{ start: 8, end: 11 }, { start: 17, end: 20 }], 'the editor find stays literal');
assert.deepStrictEqual(findMatches('invoice total 136', 'invoice 136'), [{ start: 0, end: 7 }, { start: 14, end: 17 }], 'each bare word is highlighted');
assert.deepStrictEqual(findMatches('invoice\n 136', '"invoice 136"'), [{ start: 0, end: 12 }], 'a phrase spans whitespace');
assert.deepStrictEqual(findMatches('a "quoted" word', '"quoted"', { literal: true }), [{ start: 2, end: 10 }]);
const marked = highlightPlain('136 and 1360', '136');
assert.strictEqual((marked.match(/<mark/g) || []).length, 1);
assert.match(highlightPlain('Eén café', 'een'), /<mark class="search-hit">Eén<\/mark>/);
assert.strictEqual(textHasQuery('invoice 1360', '136'), false);
assert.strictEqual(textHasQuery('invoice 136', 'invoice 136'), true);
assert.strictEqual(snippetAround('x'.repeat(200) + ' totaal 136 ' + 'y'.repeat(200), 'totaal 136').includes('totaal 136'), true);

// --- in-memory index notices changes made under it --------------------------
clearMemoryIndex();
vault.clear();
const scanNote = note({ uuid: 'scan', title: 'Polis', content: '', attachments: ['att-1'] });
vault.set('att-1', { uuid: 'att-1', content: { type: 'attachment', note_id: 'scan', filename: 'polis.pdf', ocr_text: 'polisnummer 4419' } });
indexNotes([scanNote], tagMap);
assert.strictEqual(memoryIndexActive(), true);
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: '4419', tagMap })), ['scan']);

// OCR text replaced in place (as the store does when another device finishes indexing).
vault.get('att-1').content.ocr_text = 'polisnummer 5520';
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: '5520', tagMap })), ['scan'], 'new scan text is searchable without a reindex');
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: '4419', tagMap })), [], 'old scan text is gone');

// Attachment tombstoned: the row no longer lists it.
vault.delete('att-1');
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: '5520', tagMap })), []);
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: 'polis.pdf', tagMap })), []);

// A file that becomes visible again (its duplicate winner was deleted) is searchable.
vault.set('att-2', { uuid: 'att-2', content: { type: 'attachment', note_id: 'scan', filename: 'kopie.pdf', ocr_text: 'kopie 6631' } });
assert.deepStrictEqual(ids(filterNotes([scanNote], { filter: 'all', query: '6631', tagMap })), ['scan']);

// Tag renamed: the new title is searchable, the old one is not.
const tagged = note({ uuid: 'tagged', title: 'Memo', tags: ['tag-fin'] });
indexNote(tagged, tagMap);
assert.deepStrictEqual(ids(filterNotes([tagged], { filter: 'all', query: 'financien', tagMap })), ['tagged']);
const renamedTags = new Map([['tag-fin', { uuid: 'tag-fin', content: { title: 'Belasting' } }]]);
assert.deepStrictEqual(ids(filterNotes([tagged], { filter: 'all', query: 'belasting', tagMap: renamedTags })), ['tagged']);
assert.deepStrictEqual(ids(filterNotes([tagged], { filter: 'all', query: 'financien', tagMap: renamedTags })), []);

// Body replaced in place by a remote edit of the open note.
const live = note({ uuid: 'live', title: 'Draft', content: 'first wording' });
indexNote(live, tagMap);
live.content.content = 'second wording';
assert.deepStrictEqual(ids(filterNotes([live], { filter: 'all', query: 'second', tagMap })), ['live']);
assert.deepStrictEqual(ids(filterNotes([live], { filter: 'all', query: 'first', tagMap })), []);

// Locked later: the body leaves search even though the index was built unlocked.
live.content.locked = true;
assert.deepStrictEqual(ids(filterNotes([live], { filter: 'all', query: 'second', tagMap, searchOptions: { includeProtected: true } })), []);
assert.deepStrictEqual(ids(filterNotes([live], { filter: 'all', query: 'draft', tagMap, searchOptions: { includeProtected: true } })), ['live']);

// A conflict copy is an ordinary note: searchable by its suffix and its text.
const conflict = note({ uuid: 'cc', title: 'Draft (conflict copy)', title_manual: true, content: 'their wording', conflict_of: 'live' });
assert.deepStrictEqual(ids(filterNotes([conflict], { filter: 'all', query: 'conflict copy', tagMap })), ['cc']);
assert.deepStrictEqual(ids(filterNotes([conflict], { filter: 'all', query: 'their wording', tagMap })), ['cc']);

// Lock drops the index.
clearMemoryIndex();
assert.strictEqual(memoryIndexActive(), false);

// --- titles-only and protected paths use the same term rules ----------------
const titled = note({ uuid: 't', title: 'Jaaropgave 2025 KLM', content: 'body 136' });
assert.deepStrictEqual(ids(filterNotes([titled], { filter: 'all', query: 'klm 2025', tagMap, searchOptions: { titlesOnly: true } })), ['t']);
assert.deepStrictEqual(ids(filterNotes([titled], { filter: 'all', query: 'klm 136', tagMap, searchOptions: { titlesOnly: true } })), [], 'titles only never reads the body');
assert.deepStrictEqual(ids(filterNotes([titled], { filter: 'all', query: 'klm 136', tagMap })), ['t']);
assert.strictEqual(matchesNoteOrFileName(titled, '"2025 klm"', { includeFileNames: false }), true);
assert.strictEqual(matchesNoteOrFileName(titled, '"klm 2025"', { includeFileNames: false }), false);

// --- large-vault fallback is reported, not silent ---------------------------
const bomb = note({ uuid: 'bomb', title: 'Boom', content: 'x' });
Object.defineProperty(bomb.content, 'content', { get() { throw new RangeError('Invalid string length'); } });
const warn = console.warn;
console.warn = () => {};
const degraded = filterNotes([bomb, titled], { filter: 'all', query: 'boom', tagMap });
console.warn = warn;
assert.deepStrictEqual(ids(degraded), ['bomb']);
assert.strictEqual(degraded.titlesOnlyFallback, true, 'callers can tell the user that body and scan hits were skipped');
const healthy = filterNotes([titled], { filter: 'all', query: 'klm', tagMap });
assert.strictEqual(healthy.titlesOnlyFallback, undefined);

console.log('ok');
