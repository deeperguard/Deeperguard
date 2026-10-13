const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();

global.addEventListener = () => {};
global.window = global;
global.localStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.sessionStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.NotesIDB = {
  async putItem(row) {
    idb.set(row.uuid, JSON.parse(JSON.stringify(row)));
  },
  async deleteItem(uuid) {
    idb.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async iterateItems(onRow) {
    for (const row of idb.values()) onRow(row);
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async putBlob() {},
  async getBlob() {
    return '';
  },
  async deleteBlob() {},
  async getMeta() {
    return null;
  },
  async putMeta() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) });
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
const NotesSearch = require(path.join(jsRoot, 'search.js'));

const INVOICE_NAME = '2026-0198 Factuur Joyce.pdf';
const INVOICE_OCR = 'Pro & Kids Coaching Hakemulder\nLeeghwaterstraat 25 2811DT Reeuwijk\n136';

function renderedAttachmentNames(noteId) {
  // Same filter renderAttachments uses: the open note, not the search hit.
  return NotesStore.listAttachments(noteId)
    .filter((item) => item.content?.note_id === noteId)
    .map((item) => item.content.filename);
}

function hitsFor(query) {
  const notes = NotesStore.listNotes();
  NotesSearch.indexNotes(notes, new Map());
  return NotesSearch.filterNotes(notes, {
    query,
    filter: 'all',
    tagMap: new Map(),
  }).map((note) => note.uuid);
}

(async () => {
  await NotesStore.unlock('vault-password', 'salt-render-owner');

  const ownerId = NotesStore.newUuid();
  const otherId = NotesStore.newUuid();
  const owner = NotesStore.defaultNote();
  owner.title = '2026-0198 Factuur Joyce';
  owner.content = '';
  NotesStore.upsert(ownerId, owner);
  const other = NotesStore.defaultNote();
  other.title = 'Bevestiging registratie Schutten invest';
  other.content = 'Registration confirmed for the investment account.';
  NotesStore.upsert(otherId, other);

  // Same scanned invoice, but the stored rows do not share a hash and their
  // sizes are not equal (both still display as 118 KB). The copy's OCR is the
  // same text with a trailing period, so a filename/size compare bails out.
  const ownerAtt = NotesStore.newUuid();
  const otherAtt = NotesStore.newUuid();
  const base = {
    type: 'attachment',
    filename: INVOICE_NAME,
    original_filename: INVOICE_NAME,
    mime: 'application/pdf',
    ocr_method: 'pdftext',
    ocr_index: NotesStore.OCR_INDEX,
  };
  NotesStore.upsert(ownerAtt, {
    ...base,
    note_id: ownerId,
    size: 120832,
    content_sha256: 'hash-owner-render',
    ocr_text: INVOICE_OCR,
    created_at: '2026-09-27T00:00:00.000Z',
  });
  NotesStore.upsert(otherAtt, {
    ...base,
    note_id: otherId,
    size: 121100,
    content_sha256: 'hash-other-render',
    ocr_text: `${INVOICE_OCR}.`,
    created_at: '2026-09-20T00:00:00.000Z',
  });
  const ownerRow = NotesStore.get(ownerId);
  ownerRow.content.attachments = [ownerAtt];
  ownerRow.content.ocr_text = INVOICE_OCR;
  ownerRow.content.attachment_names = INVOICE_NAME;
  const otherRow = NotesStore.get(otherId);
  otherRow.content.attachments = [otherAtt];
  otherRow.content.ocr_text = `${INVOICE_OCR}.`;
  otherRow.content.attachment_names = INVOICE_NAME;

  assert.deepStrictEqual(
    renderedAttachmentNames(otherId),
    [],
    'opening a note that does not own the invoice must not render that PDF',
  );
  assert.deepStrictEqual(renderedAttachmentNames(ownerId), [INVOICE_NAME]);
  assert.ok(hitsFor('136').includes(otherId), 'leaked scan text still matches until repair');
  NotesStore.repairStoredAttachmentCopies();
  assert.ok(NotesStore.get(otherAtt) && !NotesStore.get(otherAtt).deleted);
  assert.ok(!String(NotesStore.get(otherId).content.ocr_text || '').includes('136'));
  const hits = hitsFor('136');
  assert.ok(hits.includes(ownerId), 'the invoice note must still match 136');
  assert.ok(!hits.includes(otherId), 'search for 136 must not present the other note as if it contains the PDF');
  assert.deepStrictEqual(renderedAttachmentNames(otherId), []);
  assert.deepStrictEqual(renderedAttachmentNames(ownerId), [INVOICE_NAME]);

  const distinctA = NotesStore.newUuid();
  const distinctB = NotesStore.newUuid();
  NotesStore.upsert(distinctA, { ...NotesStore.defaultNote(), title: 'Scan A', content: 'alpha' });
  NotesStore.upsert(distinctB, { ...NotesStore.defaultNote(), title: 'Scan B', content: 'beta' });
  NotesStore.upsert(NotesStore.newUuid(), {
    type: 'attachment',
    note_id: distinctA,
    filename: 'notes.pdf',
    mime: 'application/pdf',
    size: 4096,
    content_sha256: 'hash-distinct-a',
    ocr_text: 'alpha only',
    ocr_method: 'pdftext',
    created_at: '2024-01-01T00:00:00.000Z',
  });
  NotesStore.upsert(NotesStore.newUuid(), {
    type: 'attachment',
    note_id: distinctB,
    filename: 'notes.pdf',
    mime: 'application/pdf',
    size: 4096,
    content_sha256: 'hash-distinct-b',
    ocr_text: 'beta only',
    ocr_method: 'pdftext',
    created_at: '2024-02-01T00:00:00.000Z',
  });
  assert.strictEqual(renderedAttachmentNames(distinctA).length, 1);
  assert.strictEqual(renderedAttachmentNames(distinctB).length, 1);

  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  const resetFn = appJs.slice(
    appJs.indexOf('function resetNoteTransientChrome'),
    appJs.indexOf('function syncEditorBodyWrap'),
  );
  assert.ok(resetFn.includes('ui.attachmentList'), 'switching notes must drop the previous attachment list before the new note paints');
  const renderFn = appJs.slice(
    appJs.indexOf('function renderAttachments'),
    appJs.indexOf('function ocrSnippet'),
  );
  assert.ok(renderFn.includes('listAttachments(noteId)'));
  assert.ok(renderFn.includes('a.content?.note_id === noteId'));
  assert.ok(!renderFn.includes('activeFindNeedle()') || renderFn.indexOf('listAttachments(noteId)') < renderFn.indexOf('activeFindNeedle()'));

  console.log('test_attachment_render_owner.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
