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
const syncBodies = [];
global.fetch = async (url, options = {}) => {
  if (options.body) syncBodies.push(JSON.parse(options.body));
  return { ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

function fakeFile(text, name = 'scan.txt', type = 'text/plain') {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function waitPersist(uuid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const row = idb.get(uuid);
    if (row && (row.ciphertext || row.content)) return row;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`persist timeout for ${uuid}`);
}

(async () => {
  await NotesStore.unlock('vault-password', 'salt-1');
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, NotesStore.defaultNote());

  const secret = 'invoice-42-plaintext';
  const attId = await NotesStore.addAttachment(noteId, fakeFile(secret, 'invoice.txt'));
  await waitPersist(attId);

  const att = NotesStore.get(attId);
  // iOS OOM fix: encrypted file bytes stay in IndexedDB, not in memory.
  assert.strictEqual(att.content.file_enc, undefined);
  assert.strictEqual(att.content.file_enc_stored, true);
  assert.strictEqual(att.content.data_b64, undefined);
  assert.ok(!JSON.stringify(att.content).includes(secret));

  const stored = idb.get(attId);
  assert.ok(stored.ciphertext);
  assert.strictEqual(stored.content, undefined);
  assert.ok(!JSON.stringify(stored).includes(secret));
  const storedContent = await NotesCrypto.decryptObject(
    NotesStore.state.cryptoKey,
    JSON.parse(stored.ciphertext),
  );
  assert.strictEqual(storedContent.file_enc, undefined);
  assert.strictEqual(storedContent.file_enc_stored, true);
  const storedBlob = JSON.parse(blobs.get(attId));
  assert.ok(storedBlob.iv && storedBlob.data);
  assert.strictEqual(storedContent.data_b64, undefined);

  const bytes = await NotesStore.getAttachmentBytes(attId);
  assert.strictEqual(new TextDecoder().decode(bytes), secret);
  assert.ok(NotesStore.get(attId).content.content_sha256, 'attachment stores content hash');

  await assert.rejects(
    () => NotesStore.addAttachment(noteId, fakeFile(secret, 'invoice-copy.txt')),
    /Already attached in this note:/,
    'same bytes must not attach twice',
  );
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);

  await assert.rejects(
    () => NotesStore.addAttachment(noteId, fakeFile(secret, 'renamed.txt')),
    /Already attached in this note:/,
    'same bytes with a different name must still be blocked',
  );
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);

  const stripped = NotesStore.get(attId);
  NotesStore.upsert(attId, { ...stripped.content, content_sha256: '' });
  NotesStore.state.dirty.clear();
  await assert.rejects(
    () => NotesStore.addAttachment(noteId, fakeFile(secret, 'invoice.txt')),
    /Already attached in this note:/,
    'legacy rows without a stored hash must still match by content bytes',
  );
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);
  assert.ok(!NotesStore.state.dirty.has(attId), 'hash backfill must not mark attachments dirty');

  const otherNoteId = NotesStore.newUuid();
  NotesStore.upsert(otherNoteId, NotesStore.defaultNote());
  await assert.rejects(
    () => NotesStore.addAttachment(otherNoteId, fakeFile(secret, 'invoice.txt')),
    /Already saved in/,
    'the same bytes must not be saved again on another note',
  );
  assert.strictEqual(NotesStore.listAttachments(otherNoteId).length, 0);

  const trashedNoteId = NotesStore.newUuid();
  NotesStore.upsert(trashedNoteId, { ...NotesStore.defaultNote(), trashed: true, title: 'Old upload' });
  const trashedAttId = await NotesStore.addAttachment(trashedNoteId, fakeFile('trashed-only', 'trashed.txt'));
  assert.ok(trashedAttId);
  const retryNoteId = NotesStore.newUuid();
  NotesStore.upsert(retryNoteId, NotesStore.defaultNote());
  const retryAttId = await NotesStore.addAttachment(retryNoteId, fakeFile('trashed-only', 'testosteron.txt'));
  assert.ok(retryAttId, 'upload must succeed when the only duplicate is in Trash');
  assert.strictEqual(NotesStore.listAttachments(retryNoteId).length, 1);

  const legacyNoteId = NotesStore.newUuid();
  NotesStore.upsert(legacyNoteId, NotesStore.defaultNote());
  const legacyDupId = NotesStore.newUuid();
  const legacyBytes = new TextEncoder().encode('other-invoice-body');
  NotesStore.upsert(legacyDupId, {
    type: 'attachment',
    note_id: legacyNoteId,
    filename: 'invoice.txt',
    original_filename: 'invoice.txt',
    mime: 'text/plain',
    size: legacyBytes.byteLength,
    file_enc_stored: true,
    ocr_text: '',
  });
  const legacyNote = NotesStore.get(legacyNoteId);
  legacyNote.content.attachments = [legacyDupId];
  NotesStore.upsert(legacyNoteId, legacyNote.content);
  assert.strictEqual(NotesStore.listAttachments(legacyNoteId).length, 1);

  const freshId = await NotesStore.addAttachment(legacyNoteId, fakeFile('brand-new-body', 'invoice.txt'));
  assert.ok(freshId, 'different content must not be blocked by legacy metadata-only rows');
  assert.strictEqual(NotesStore.listAttachments(legacyNoteId).length, 2);

  NotesStore.setAttachmentOcr(attId, 'recognized invoice', 'tesseract');
  assert.strictEqual(NotesStore.get(attId).content.data_b64, undefined);
  assert.ok(NotesStore.get(attId).content.file_enc_stored);
  assert.strictEqual(NotesStore.get(attId).content.ocr_index, NotesStore.OCR_INDEX);
  NotesStore.staleAttachmentOcr(attId);
  assert.strictEqual(NotesStore.get(attId).content.ocr_index, undefined);
  NotesStore.setAttachmentOcr(attId, 'recognized invoice', 'tesseract', [{ text: 'invoice', l: 0.1, t: 0.2, w: 0.1, h: 0.02 }]);
  assert.strictEqual(NotesStore.get(attId).content.ocr_index, NotesStore.OCR_INDEX);
  assert.strictEqual(NotesStore.get(attId).content.ocr_boxes.length, 1);
  const indexedAt = NotesStore.get(attId).updated_at;
  assert.strictEqual(
    NotesStore.setAttachmentOcr(attId, 'recognized invoice', 'tesseract', [{ text: 'invoice', l: 0.1, t: 0.2, w: 0.1, h: 0.02 }]),
    false,
    'identical server OCR must not create another local edit',
  );
  assert.strictEqual(NotesStore.get(attId).updated_at, indexedAt);

  const noteAfter = NotesStore.get(noteId);
  NotesStore.upsert(noteId, { ...noteAfter.content, attachments: [] });
  assert.ok(NotesStore.get(noteId).content.attachments.includes(attId));
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);
  const orphanId = NotesStore.newUuid();
  NotesStore.upsert(orphanId, {
    ...att.content,
    note_id: 'missing-legacy-note',
    filename: 'Dna.pdf',
  });
  await waitPersist(orphanId);
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);
  assert.ok(
    NotesStore.listAttachments().some((item) => item.uuid === orphanId),
    'global attachment discovery must include legacy/orphaned PDFs',
  );

  const legacyId = 'legacy-att';
  const legacyPlain = Buffer.from('old-unencrypted-scan').toString('base64');
  idb.set(legacyId, {
    uuid: legacyId,
    content: {
      type: 'attachment',
      note_id: noteId,
      filename: 'old.bin',
      mime: 'application/octet-stream',
      size: 19,
      data_b64: legacyPlain,
      ocr_text: '',
    },
    updated_at: 1,
    deleted: false,
  });
  NotesStore.state.items.clear();
  await NotesStore.loadLocal();
  await NotesStore.finishUnlockMaintenance();
  const migrated = NotesStore.get(legacyId);
  assert.ok(migrated.content.file_enc_stored);
  assert.strictEqual(migrated.content.file_enc, undefined);
  assert.strictEqual(migrated.content.data_b64, undefined);
  assert.ok(!JSON.stringify(migrated.content).includes('old-unencrypted-scan'));
  const migratedBytes = await NotesStore.getAttachmentBytes(legacyId);
  assert.strictEqual(new TextDecoder().decode(migratedBytes), 'old-unencrypted-scan');
  const migratedStored = idb.get(legacyId);
  assert.ok(migratedStored.ciphertext);
  assert.strictEqual(migratedStored.content, undefined);
  assert.ok(!JSON.stringify(migratedStored).includes('old-unencrypted-scan'));

  NotesStore.state.items.clear();
  await NotesStore.loadLocal();
  await NotesStore.finishUnlockMaintenance();
  const reopened = await NotesStore.getAttachmentBytes(legacyId);
  assert.strictEqual(new TextDecoder().decode(reopened), 'old-unencrypted-scan');

  const beforeIds = NotesStore.listAttachments(noteId).map((item) => item.uuid);
  const originalPut = global.NotesIDB.putItem;
  global.NotesIDB.putItem = async (row) => {
    if (row.uuid !== noteId && !beforeIds.includes(row.uuid)) {
      throw new Error('disk full');
    }
    return originalPut(row);
  };
  await assert.rejects(
    () => NotesStore.addAttachment(noteId, fakeFile('nope', 'fail.txt')),
    /Could not save the file/,
  );
  global.NotesIDB.putItem = originalPut;
  assert.deepStrictEqual(
    NotesStore.listAttachments(noteId).map((item) => item.uuid),
    beforeIds,
    'a failed persist must not leave an in-memory attachment',
  );
  const extraIds = [otherNoteId, trashedNoteId, trashedAttId, retryNoteId, retryAttId, legacyNoteId, legacyDupId, freshId];
  for (const uuid of idb.keys()) {
    assert.ok(
      uuid === noteId
      || beforeIds.includes(uuid)
      || uuid === legacyId
      || uuid === orphanId
      || extraIds.includes(uuid),
      uuid,
    );
  }

  await NotesStore.flush();
  assert.ok(syncBodies.length);
  const wire = JSON.stringify(syncBodies);
  assert.ok(!wire.includes(secret));
  assert.ok(!wire.includes('old-unencrypted-scan'));
  assert.ok(!wire.includes(legacyPlain));
  // Pushed rows must hydrate the real encrypted bytes from IndexedDB even though
  // the in-memory copy is stripped (file_enc_stored).
  const pushedRows = syncBodies.flatMap((body) => body.items || []);
  const pushedAtt = pushedRows.filter((row) => row.item_uuid === attId).pop();
  assert.ok(pushedAtt, 'attachment row must be pushed');
  const pushedMeta = await NotesCrypto.decryptObject(
    NotesStore.state.cryptoKey,
    JSON.parse(pushedAtt.ciphertext),
  );
  assert.ok(pushedAtt.blob_ciphertext, 'pushed attachment must include blob ciphertext');
  assert.strictEqual(pushedMeta.file_enc, undefined);
  assert.strictEqual(pushedMeta.file_enc_stored, true);
  const pushedBlob = JSON.parse(pushedAtt.blob_ciphertext);
  assert.ok(pushedBlob.iv && pushedBlob.data);

  const syncStatuses = [];
  NotesStore.setSyncStatusCallback((status) => syncStatuses.push(status));
  await NotesStore.sync({ quiet: true });
  assert.deepStrictEqual(syncStatuses, [], 'an empty background check must stay silent');
  await NotesStore.sync();
  assert.ok(syncStatuses.some((status) => status.state === 'syncing'));
  assert.strictEqual(syncStatuses.at(-1).state, 'ok');

  const pendingNoteId = NotesStore.newUuid();
  NotesStore.upsert(pendingNoteId, NotesStore.defaultNote());
  const pendingId = await NotesStore.addAttachment(pendingNoteId, fakeFile('pending-body', 'pending.pdf', 'application/pdf'), { ocrPending: true });
  assert.strictEqual(NotesStore.get(pendingId).content.ocr_method, 'pending');
  NotesStore.setAttachmentOcr(pendingId, 'page one', 'pdftext', []);
  assert.strictEqual(NotesStore.get(pendingId).content.ocr_method, 'pdftext');
  assert.strictEqual(NotesStore.get(pendingId).content.ocr_index, NotesStore.OCR_INDEX);

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
