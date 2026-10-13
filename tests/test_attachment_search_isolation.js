const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();

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
    blobs.delete(uuid);
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
  async putBlob(uuid, blobCiphertext) {
    blobs.set(uuid, blobCiphertext);
  },
  async getBlob(uuid) {
    return blobs.get(uuid) || '';
  },
  async deleteBlob(uuid) {
    blobs.delete(uuid);
  },
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
  await NotesStore.unlock('vault-password', 'salt-1');

  const noteA = NotesStore.newUuid();
  const noteB = NotesStore.newUuid();
  const invoice = NotesStore.defaultNote();
  invoice.title = 'Factuur Joyce';
  invoice.content = 'Short invoice note';
  NotesStore.upsert(noteA, invoice);
  const book = NotesStore.defaultNote();
  book.title = 'The-Real-Anthony-Fauci';
  book.content = `${'word '.repeat(4000)}end`;
  NotesStore.upsert(noteB, book);
  assert.ok(!book.content.includes('136'));

  const bytes = new TextEncoder().encode(INVOICE_OCR);
  const imported = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: noteA,
    bytes,
    filename: INVOICE_NAME,
    mime: 'application/pdf',
  });
  assert.strictEqual(imported.created, true);
  NotesStore.setAttachmentOcr(imported.uuid, INVOICE_OCR, 'pdftext');
  NotesStore.refreshNoteSearchText(noteA);
  NotesStore.refreshNoteSearchText(noteB);

  const hits = hitsFor('136');
  assert.ok(hits.includes(noteA), 'the invoice note must be a search hit for 136');
  assert.ok(!hits.includes(noteB), 'an unrelated note must not match text that exists only in the PDF');
  assert.strictEqual(NotesStore.listAttachments(noteA).length, 1);
  assert.deepStrictEqual(NotesStore.listAttachments(noteB), []);
  assert.ok(!String(NotesStore.get(noteB).content.ocr_text || '').includes('136'));
  assert.ok(String(NotesStore.get(noteA).content.ocr_text || '').includes('136'));

  const beforeGlobal = NotesStore.listAttachments().map((item) => item.uuid);
  const again = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: noteB,
    bytes,
    filename: INVOICE_NAME,
    mime: 'application/pdf',
  });
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.uuid, imported.uuid);
  assert.deepStrictEqual(NotesStore.listAttachments().map((item) => item.uuid), beforeGlobal);
  assert.strictEqual(NotesStore.listAttachments(noteA).length, 1);
  assert.deepStrictEqual(NotesStore.listAttachments(noteB), []);
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(imported.uuid));
  assert.ok(NotesStore.get(imported.uuid), 'the original file must stay in the vault');

  const shared = await NotesStore.importAttachment({
    uuid: imported.uuid,
    noteId: noteB,
    bytes,
    filename: INVOICE_NAME,
    mime: 'application/pdf',
  });
  assert.strictEqual(shared.created, false);
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(imported.uuid));
  assert.strictEqual(NotesStore.get(imported.uuid).content.note_id, noteA);

  const original = NotesStore.get(imported.uuid);
  const dupId = NotesStore.newUuid();
  NotesStore.upsert(dupId, {
    ...original.content,
    note_id: noteB,
    filename: INVOICE_NAME,
    created_at: '2099-01-01T00:00:00.000Z',
    ocr_text: INVOICE_OCR,
    ocr_method: 'pdftext',
  });
  const poisoned = NotesStore.get(noteB);
  NotesStore.upsert(noteB, {
    ...poisoned.content,
    attachments: [dupId, imported.uuid],
    ocr_text: 'leaked 136 from the invoice',
    sn_pending_files: { not: 'an array' },
  });
  assert.ok(Array.isArray(NotesStore.get(noteB).content.attachments));
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(imported.uuid));
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(dupId));
  assert.ok(NotesStore.listAttachments().some((item) => item.uuid === dupId), 'a copied row must stay in the vault');
  assert.ok(!NotesStore.listAttachments(noteB).some((item) => item.uuid === dupId));
  assert.ok(NotesStore.listAttachments(noteA).some((item) => item.uuid === imported.uuid));
  assert.ok(!String(NotesStore.get(noteB).content.ocr_text || '').includes('136'));
  NotesStore.get(noteB).content.attachments = [dupId, imported.uuid];
  NotesStore.get(noteB).content.ocr_text = 'leaked 136 from the invoice';
  assert.strictEqual(NotesStore.refreshNoteSearchText(noteB), true);
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(dupId));
  assert.ok(!NotesStore.get(noteB).content.attachments.includes(imported.uuid));
  assert.ok(!String(NotesStore.get(noteB).content.ocr_text || '').includes('136'));
  const hitsAfterCopy = hitsFor('136');
  assert.ok(hitsAfterCopy.includes(noteA));
  assert.ok(!hitsAfterCopy.includes(noteB));

  const noteC = NotesStore.newUuid();
  const noteD = NotesStore.newUuid();
  const shortNote = NotesStore.defaultNote();
  shortNote.title = 'Factuur Joyce';
  shortNote.content = 'one page';
  NotesStore.upsert(noteC, shortNote);
  const longNote = NotesStore.defaultNote();
  longNote.title = 'The-Real-Anthony-Fauci';
  longNote.content = 'chapter '.repeat(8000);
  NotesStore.upsert(noteD, longNote);
  const tiedBytes = new TextEncoder().encode('tied-invoice-body-not-136');
  const createdAt = '2024-06-01T00:00:00.000Z';
  const tied = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: noteC,
    bytes: tiedBytes,
    filename: INVOICE_NAME,
    mime: 'application/pdf',
    created_at: createdAt,
  });
  assert.strictEqual(tied.created, true);
  const tiedItem = NotesStore.get(tied.uuid);
  const tiedDup = NotesStore.newUuid();
  NotesStore.upsert(tiedDup, {
    ...tiedItem.content,
    note_id: noteD,
    filename: INVOICE_NAME,
    created_at: createdAt,
    ocr_text: '',
  });
  NotesStore.upsert(noteD, {
    ...NotesStore.get(noteD).content,
    attachments: [tiedDup],
  });
  assert.ok(NotesStore.listAttachments(noteC).some((item) => item.uuid === tied.uuid));
  assert.deepStrictEqual(NotesStore.listAttachments(noteD), []);
  assert.ok(NotesStore.listAttachments().some((item) => item.uuid === tiedDup));
  assert.ok(!NotesStore.get(noteD).content.attachments.includes(tiedDup));

  const noteE = NotesStore.newUuid();
  const noteF = NotesStore.newUuid();
  const shortOther = NotesStore.defaultNote();
  shortOther.title = 'Alpha';
  shortOther.content = 'brief';
  NotesStore.upsert(noteE, shortOther);
  const longOther = NotesStore.defaultNote();
  longOther.title = 'Beta';
  longOther.content = 'page '.repeat(3000);
  NotesStore.upsert(noteF, longOther);
  const plainBytes = new TextEncoder().encode('plain-duplicate-body');
  const plain = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: noteE,
    bytes: plainBytes,
    filename: 'scan-plain.pdf',
    mime: 'application/pdf',
    created_at: createdAt,
  });
  const plainDup = NotesStore.newUuid();
  NotesStore.upsert(plainDup, {
    ...NotesStore.get(plain.uuid).content,
    note_id: noteF,
    filename: 'scan-plain.pdf',
    created_at: createdAt,
  });
  NotesStore.upsert(noteF, { ...NotesStore.get(noteF).content, attachments: [plainDup] });
  assert.ok(NotesStore.listAttachments(noteE).some((item) => item.uuid === plain.uuid));
  assert.deepStrictEqual(NotesStore.listAttachments(noteF), []);
  assert.ok(NotesStore.listAttachments().some((item) => item.uuid === plainDup));

  const trashedId = NotesStore.newUuid();
  NotesStore.upsert(trashedId, { ...NotesStore.defaultNote(), trashed: true, title: 'Old upload' });
  const trashBytes = new TextEncoder().encode('trash-only-pdf');
  const trashAtt = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: trashedId,
    bytes: trashBytes,
    filename: 'old.pdf',
    mime: 'application/pdf',
  });
  assert.strictEqual(trashAtt.created, true);
  const retryId = NotesStore.newUuid();
  NotesStore.upsert(retryId, NotesStore.defaultNote());
  const retryAtt = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId: retryId,
    bytes: trashBytes,
    filename: 'old.pdf',
    mime: 'application/pdf',
  });
  assert.strictEqual(retryAtt.created, true);
  assert.notStrictEqual(retryAtt.uuid, trashAtt.uuid);
  assert.strictEqual(NotesStore.listAttachments(retryId).length, 1);

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
