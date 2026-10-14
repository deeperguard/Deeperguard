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

  // Copies already stored before the hash check: same PDF name and size,
  // different content hashes, OCR text containing 136 on the unrelated note.
  const noteOwner = NotesStore.newUuid();
  const noteOther = NotesStore.newUuid();
  const ownerNote = NotesStore.defaultNote();
  ownerNote.title = '2026-0198 Factuur Joyce';
  ownerNote.content = '';
  NotesStore.upsert(noteOwner, ownerNote);
  const otherNote = NotesStore.defaultNote();
  otherNote.title = 'Bevestiging registratie Schutten invest';
  otherNote.content = 'Registration confirmed for the investment account.';
  NotesStore.upsert(noteOther, otherNote);
  const ownerAtt = NotesStore.newUuid();
  const otherAtt = NotesStore.newUuid();
  const storedFile = {
    type: 'attachment',
    filename: INVOICE_NAME,
    original_filename: INVOICE_NAME,
    mime: 'application/pdf',
    size: 120832,
    ocr_text: INVOICE_OCR,
    ocr_method: 'pdftext',
    ocr_index: NotesStore.OCR_INDEX,
  };
  NotesStore.upsert(ownerAtt, {
    ...storedFile,
    note_id: noteOwner,
    content_sha256: 'hash-owner-copy',
    created_at: '2026-09-27T00:00:00.000Z',
  });
  NotesStore.upsert(otherAtt, {
    ...storedFile,
    note_id: noteOther,
    content_sha256: 'hash-other-copy',
    created_at: '2026-09-20T00:00:00.000Z',
  });
  const ownerRow = NotesStore.get(noteOwner);
  ownerRow.content.attachments = [ownerAtt];
  ownerRow.content.ocr_text = INVOICE_OCR;
  ownerRow.content.attachment_names = INVOICE_NAME;
  const otherRow = NotesStore.get(noteOther);
  otherRow.content.attachments = [otherAtt];
  otherRow.content.ocr_text = INVOICE_OCR;
  otherRow.content.attachment_names = INVOICE_NAME;
  assert.ok(NotesStore.listAttachments(noteOwner).some((item) => item.uuid === ownerAtt));
  assert.deepStrictEqual(
    NotesStore.listAttachments(noteOther),
    [],
    'a stored copy with a different hash must not render on the unrelated note',
  );
  assert.ok(NotesStore.listAttachments().some((item) => item.uuid === otherAtt));
  assert.ok(!hitsFor('136').includes(noteOther), 'a copied scan the note list hides must not match');
  const repaired = NotesStore.repairStoredAttachmentCopies();
  assert.ok(repaired >= 1);
  assert.strictEqual(NotesStore.get(otherAtt).content.duplicate_of, ownerAtt);
  assert.strictEqual(NotesStore.get(otherAtt).deleted, false);
  assert.ok(!NotesStore.get(noteOther).content.attachments.includes(otherAtt));
  assert.ok(!String(NotesStore.get(noteOther).content.ocr_text || '').includes('136'));
  assert.ok(String(NotesStore.get(noteOwner).content.ocr_text || '').includes('136'));
  assert.ok(NotesStore.listAttachments(noteOwner).some((item) => item.uuid === ownerAtt));
  assert.deepStrictEqual(NotesStore.listAttachments(noteOther), []);
  const repairedHits = hitsFor('136');
  assert.ok(repairedHits.includes(noteOwner));
  assert.ok(!repairedHits.includes(noteOther));
  assert.ok(!repairedHits.includes(noteB));

  const distinctA = NotesStore.newUuid();
  const distinctB = NotesStore.newUuid();
  NotesStore.upsert(distinctA, { ...NotesStore.defaultNote(), title: 'Scan A', content: 'alpha' });
  NotesStore.upsert(distinctB, { ...NotesStore.defaultNote(), title: 'Scan B', content: 'beta' });
  const distinctSize = 4096;
  const attA = NotesStore.newUuid();
  const attB = NotesStore.newUuid();
  NotesStore.upsert(attA, {
    type: 'attachment',
    note_id: distinctA,
    filename: 'notes.pdf',
    mime: 'application/pdf',
    size: distinctSize,
    content_sha256: 'hash-distinct-a',
    ocr_text: 'alpha only',
    ocr_method: 'pdftext',
    created_at: '2024-01-01T00:00:00.000Z',
  });
  NotesStore.upsert(attB, {
    type: 'attachment',
    note_id: distinctB,
    filename: 'notes.pdf',
    mime: 'application/pdf',
    size: distinctSize,
    content_sha256: 'hash-distinct-b',
    ocr_text: 'beta only',
    ocr_method: 'pdftext',
    created_at: '2024-01-02T00:00:00.000Z',
  });
  assert.strictEqual(NotesStore.listAttachments(distinctA).length, 1);
  assert.strictEqual(NotesStore.listAttachments(distinctB).length, 1);

  const sameNameA = NotesStore.newUuid();
  const sameNameB = NotesStore.newUuid();
  NotesStore.upsert(sameNameA, { ...NotesStore.defaultNote(), title: 'Upload A', content: 'first file' });
  NotesStore.upsert(sameNameB, { ...NotesStore.defaultNote(), title: 'Upload B', content: 'second file' });
  NotesStore.upsert(NotesStore.newUuid(), {
    type: 'attachment',
    note_id: sameNameA,
    filename: 'same.pdf',
    mime: 'application/pdf',
    size: 2048,
    content_sha256: 'hash-same-name-a',
    ocr_text: '',
    created_at: '2024-03-01T00:00:00.000Z',
  });
  NotesStore.upsert(NotesStore.newUuid(), {
    type: 'attachment',
    note_id: sameNameB,
    filename: 'same.pdf',
    mime: 'application/pdf',
    size: 2048,
    content_sha256: 'hash-same-name-b',
    ocr_text: '',
    created_at: '2024-03-02T00:00:00.000Z',
  });
  assert.strictEqual(NotesStore.listAttachments(sameNameA).length, 1, 'filename and size alone must not hide a file');
  assert.strictEqual(NotesStore.listAttachments(sameNameB).length, 1, 'filename and size alone must not hide a file');

  const nearOwner = NotesStore.newUuid();
  const nearOther = NotesStore.newUuid();
  const nearOwnerNote = NotesStore.defaultNote();
  nearOwnerNote.title = 'Near invoice';
  nearOwnerNote.content = '';
  NotesStore.upsert(nearOwner, nearOwnerNote);
  const nearOtherNote = NotesStore.defaultNote();
  nearOtherNote.title = 'Near copy';
  nearOtherNote.content = 'A different note that was given a copied scan.';
  NotesStore.upsert(nearOther, nearOtherNote);
  const nearOcr = `${INVOICE_OCR}\nNear copy marker ${'line '.repeat(20)}`;
  const nearChanged = nearOcr.replace('Reeuwijk', 'Reexwijk');
  assert.notStrictEqual(nearOcr, nearChanged);
  assert.ok(nearChanged.includes('136'));
  const nearOwnerAtt = NotesStore.newUuid();
  const nearOtherAtt = NotesStore.newUuid();
  NotesStore.upsert(nearOwnerAtt, {
    type: 'attachment',
    note_id: nearOwner,
    filename: 'near-invoice.pdf',
    mime: 'application/pdf',
    size: 88001,
    content_sha256: 'hash-near-owner',
    ocr_text: nearOcr,
    ocr_method: 'pdftext',
    created_at: '2026-08-01T00:00:00.000Z',
  });
  NotesStore.upsert(nearOtherAtt, {
    type: 'attachment',
    note_id: nearOther,
    filename: 'near-invoice-copy.pdf',
    mime: 'application/pdf',
    size: 88050,
    content_sha256: 'hash-near-other',
    ocr_text: nearChanged,
    ocr_method: 'pdftext',
    created_at: '2026-08-02T00:00:00.000Z',
  });
  NotesStore.get(nearOther).content.ocr_text = nearChanged;
  NotesStore.get(nearOther).content.attachments = [nearOtherAtt];
  assert.deepStrictEqual(NotesStore.listAttachments(nearOther), [], 'one-character OCR copies are the same document');
  assert.ok(NotesStore.listAttachments().some((item) => item.uuid === nearOtherAtt));
  assert.ok(!NotesStore.get(nearOtherAtt).deleted, 'hiding a copy must not delete its bytes');
  assert.ok(!hitsFor('136').includes(nearOther));
  assert.ok(hitsFor('136').includes(nearOwner));

  const keptCopyNote = NotesStore.newUuid();
  const keptNote = NotesStore.defaultNote();
  keptNote.title = 'Duplicated invoice';
  keptNote.content = '';
  NotesStore.upsert(keptCopyNote, keptNote);
  const keptAtt = NotesStore.newUuid();
  NotesStore.upsert(keptAtt, {
    type: 'attachment',
    note_id: keptCopyNote,
    filename: INVOICE_NAME,
    mime: 'application/pdf',
    size: 120832,
    content_sha256: 'hash-owner-copy',
    ocr_text: INVOICE_OCR,
    ocr_method: 'pdftext',
    intentional_copy: true,
    created_at: '2026-10-01T00:00:00.000Z',
  });
  assert.ok(NotesStore.listAttachments(keptCopyNote).some((item) => item.uuid === keptAtt));
  assert.ok(hitsFor('136').includes(keptCopyNote), 'Duplicate keeps a second file that still matches');
  assert.ok(hitsFor('136').includes(noteOwner));

  async function waitForIdb(uuid) {
    for (let i = 0; i < 40; i += 1) {
      if (idb.has(uuid)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`not persisted: ${uuid}`);
  }
  await waitForIdb(nearOwner);
  await waitForIdb(nearOther);
  await waitForIdb(nearOtherAtt);
  NotesSearch.indexNotes(NotesStore.listNotes(), new Map());
  assert.strictEqual(NotesSearch.memoryIndexActive(), true);
  await NotesStore.lock();
  assert.strictEqual(NotesSearch.memoryIndexActive(), false, 'the in-memory index is dropped on lock');
  await NotesStore.unlock('vault-password', 'salt-1');
  await NotesStore.loadLocal();
  await NotesStore.finishUnlockMaintenance();
  const unlockedOther = NotesStore.get(nearOther);
  assert.ok(unlockedOther, 'the copied note is still in the vault after unlock');
  assert.ok(!String(unlockedOther.content.ocr_text || '').includes('136'), 'unlock cleanup drops the copied scan text');
  assert.ok(NotesStore.get(nearOtherAtt) && !NotesStore.get(nearOtherAtt).deleted);
  const unlockedHits = hitsFor('136');
  assert.ok(unlockedHits.includes(nearOwner), 'the invoice note still matches after unlock');
  assert.ok(!unlockedHits.includes(nearOther), 'a copied scan must not match after unlock');

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
