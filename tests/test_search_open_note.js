// Opening a note from search results while the query is active: the needle
// resolves without recursing, the attachment that contains the query leads
// the inline preview, and its row says how many highlights it holds.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');

const vault = new Map();
global.NotesStore = {
  listAttachments(noteId) {
    const all = [...vault.values()];
    if (noteId == null) return all;
    return all.filter((att) => att.content.note_id === noteId);
  },
  get(id) {
    return vault.get(id) || null;
  },
};
const Search = require(path.join(jsRoot, 'search.js'));

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startMarker}`);
  return source.slice(start, end);
}

// The real app.js helpers that decide which text a document is highlighted
// for, evaluated against a DOM stub with text in the sidebar search box.
function loadNeedleHelpers({ search = '', find = '', findBarHidden = true } = {}) {
  const elements = {
    search: { value: search },
    'find-input': { value: find },
    'find-bar': { hidden: findBarHidden },
  };
  const sandbox = {
    document: { getElementById: (id) => elements[id] || null },
    ui: { search: elements.search },
    NotesStore: global.NotesStore,
    NotesSearch: Search,
    currentId: null,
  };
  const code = [
    'let docHitNoteDismissedFor = "";',
    slice(appJs, 'function currentSearchQuery()', 'function attachmentSearchBoxes('),
    slice(appJs, 'function findBarOpen()', 'function isNotePreviewVisible()'),
    slice(appJs, 'function activeDocHitNeedle()', 'function clearDocHitNavigation('),
    'this.exported = { activeFindNeedle, activeDocHitNeedle, docHitNoteSuppressed, attachmentSearchText,',
    '  dismiss(q) { docHitNoteDismissedFor = q; } };',
  ].join('\n');
  vm.runInNewContext(code, sandbox, { filename: 'app-needle-helpers.js' });
  return sandbox.exported;
}

const noteId = 'note-dossier';
const coverId = 'att-cover';
const invoiceId = 'att-invoice';
const INVOICE_TEXT = 'FACTURA SIMPLIFICADA\nLe ha atendido Irene Rodriguez\nContacto: Irene Rodriguez\nRodriguez y asociados';
const COVER_TEXT = 'Begeleidende brief\nZie bijlage';
vault.set(coverId, {
  uuid: coverId,
  content: { type: 'attachment', note_id: noteId, filename: 'Brief.pdf', ocr_text: COVER_TEXT },
});
vault.set(invoiceId, {
  uuid: invoiceId,
  content: { type: 'attachment', note_id: noteId, filename: 'Factuur.pdf', ocr_text: INVOICE_TEXT },
});
vault.set(noteId, {
  uuid: noteId,
  content: {
    type: 'note',
    title: 'Dossier wasmachine',
    content: '',
    attachments: [coverId, invoiceId],
    ocr_text: `${COVER_TEXT}\n\n${INVOICE_TEXT}`,
  },
});

// 1. With text in the search box the needle must come back, not overflow.
{
  const helpers = loadNeedleHelpers({ search: 'Rodriguez' });
  assert.strictEqual(helpers.activeFindNeedle(), 'Rodriguez', 'sidebar query is the document needle');
  assert.strictEqual(helpers.activeDocHitNeedle(), 'Rodriguez');
  assert.ok(!helpers.docHitNoteSuppressed());
  helpers.dismiss('Rodriguez');
  assert.strictEqual(helpers.activeFindNeedle(), '', 'a dismissed banner hides highlights for that query');
  assert.ok(!helpers.docHitNoteSuppressed(), 'nothing to suppress once the needle is empty');
  const again = loadNeedleHelpers({ search: 'Factura' });
  assert.strictEqual(again.activeFindNeedle(), 'Factura', 'a new query shows highlights again');
  const findBar = loadNeedleHelpers({ search: 'Rodriguez', find: 'Factura', findBarHidden: false });
  assert.strictEqual(findBar.activeFindNeedle(), 'Factura', 'an open find bar wins over the sidebar');
  const none = loadNeedleHelpers({});
  assert.strictEqual(none.activeFindNeedle(), '');
}

// 2. The file that contains the query leads the inline preview.
{
  const listed = NotesStore.listAttachments(noteId);
  assert.deepStrictEqual(listed.map((a) => a.uuid), [coverId, invoiceId], 'stored order puts the cover first');
  const ordered = Search.orderAttachmentsForQuery(listed, 'Rodriguez');
  assert.deepStrictEqual(ordered.map((a) => a.uuid), [invoiceId, coverId], 'the matched file opens first');
  assert.deepStrictEqual(
    Search.orderAttachmentsForQuery(listed, '').map((a) => a.uuid),
    [coverId, invoiceId],
    'no query keeps the stored order',
  );
  assert.deepStrictEqual(
    Search.orderAttachmentsForQuery(listed, 'wasmachine').map((a) => a.uuid),
    [coverId, invoiceId],
    'a query that only hits the title keeps the stored order',
  );
  assert.deepStrictEqual(
    Search.orderAttachmentsForQuery(listed, 'brief').map((a) => a.uuid),
    [coverId, invoiceId],
    'a filename hit keeps that file in front',
  );
  assert.deepStrictEqual(
    Search.orderAttachmentsForQuery(listed, 'factuur').map((a) => a.uuid),
    [invoiceId, coverId],
    'a filename hit on the second file brings it forward',
  );
  assert.ok(!Object.is(ordered, listed), 'ordering returns a copy');
}

// 3. Per-file hit counts and the badge text, kept apart from the note count.
{
  assert.strictEqual(Search.attachmentHitCount(vault.get(invoiceId), 'Rodriguez'), 3);
  assert.strictEqual(Search.attachmentHitCount(vault.get(coverId), 'Rodriguez'), 0);
  assert.strictEqual(Search.attachmentHitCount(vault.get(invoiceId), 'rodríguez'), 3, 'diacritics fold');
  assert.strictEqual(Search.attachmentHitCount(vault.get(invoiceId), '"irene rodriguez"'), 2, 'phrase');
  assert.strictEqual(Search.attachmentHitCount(vault.get(invoiceId), ''), 0);
  assert.strictEqual(Search.attachmentHighlightLabel(3), '3 highlights in this file');
  assert.strictEqual(Search.attachmentHighlightLabel(1), '1 highlight in this file');
  assert.strictEqual(Search.attachmentHighlightLabel(0), '', 'no badge without hits');
  assert.strictEqual(Search.listCountLabel(1), '1 note', 'the list header still counts notes');
  assert.ok(Search.attachmentMatchesQuery(vault.get(invoiceId), 'Rodriguez'));
  assert.ok(Search.attachmentMatchesQuery(vault.get(coverId), 'brief'), 'filename counts as a match');
  assert.ok(!Search.attachmentMatchesQuery(vault.get(coverId), 'Rodriguez'));
}

// 4. A file is highlighted from its own text; the note's merged copy must not
//    lend a sibling's hits to the file on screen.
{
  const helpers = loadNeedleHelpers({ search: 'Rodriguez' });
  assert.strictEqual(helpers.attachmentSearchText(coverId), COVER_TEXT);
  assert.strictEqual(helpers.attachmentSearchText(invoiceId), INVOICE_TEXT);
  assert.strictEqual(Search.findMatches(helpers.attachmentSearchText(coverId), 'Rodriguez').length, 0);
  assert.strictEqual(Search.findMatches(helpers.attachmentSearchText(invoiceId), 'Rodriguez').length, 3);
  // Legacy: a lone file without its own text still falls back to the note copy.
  const legacyNote = 'note-legacy';
  const legacyAtt = 'att-legacy';
  vault.set(legacyAtt, { uuid: legacyAtt, content: { type: 'attachment', note_id: legacyNote, filename: 'Scan.jpg' } });
  vault.set(legacyNote, { uuid: legacyNote, content: { type: 'note', attachments: [legacyAtt], ocr_text: 'Rodriguez scan' } });
  assert.strictEqual(helpers.attachmentSearchText(legacyAtt), 'Rodriguez scan');
  // But not when a sibling on the same note has its own text to answer for.
  const siblingAtt = 'att-sibling';
  vault.set(siblingAtt, { uuid: siblingAtt, content: { type: 'attachment', note_id: legacyNote, filename: 'Other.pdf', ocr_text: 'Rodriguez scan' } });
  assert.strictEqual(helpers.attachmentSearchText(legacyAtt), '');
}

// 5. The render paths wire the helpers in (source-level, like the owner test).
{
  const renderFn = slice(appJs, 'function renderAttachments(', 'function ocrSnippet(');
  assert.ok(renderFn.includes('NotesSearch.attachmentHitCount('), 'attachment rows count hits per file');
  assert.ok(renderFn.includes('attachment-hit-badge'), 'attachment rows show the hit badge');
  assert.ok(renderFn.includes('is-search-hit'), 'matched rows are marked');
  const inlineFn = slice(appJs, 'function renderDocInline(', 'function scheduleSearchHitRepaint(');
  assert.ok(inlineFn.includes('NotesSearch.orderAttachmentsForQuery('), 'inline preview opens on the matched file');
  assert.ok(inlineFn.includes('listed.findIndex('), 'gallery index refers to the stored order');
  const needleFn = slice(appJs, 'function activeFindNeedle()', 'function attachmentSearchText(')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!needleFn.includes('docHitNoteSuppressed()'), 'activeFindNeedle must not call back into the needle resolver');
}

console.log('test_search_open_note.js: ok');
