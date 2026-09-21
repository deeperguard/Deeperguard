const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();

global.addEventListener = () => {};
global.window = global;
global.localStorage = { store: {}, getItem() { return null; }, setItem() {}, removeItem() {} };
global.sessionStorage = { store: {}, getItem() { return null; }, setItem() {}, removeItem() {} };
global.NotesIDB = {
  async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
  async deleteItem(uuid) { idb.delete(uuid); blobs.delete(uuid); },
  async loadItems() { return [...idb.values()]; },
  async getItem(uuid) { return idb.get(uuid) || null; },
  async putBlob(uuid, blobCiphertext) { blobs.set(uuid, blobCiphertext); },
  async getBlob(uuid) { return blobs.get(uuid) || ''; },
  async getMeta() { return null; },
  async putMeta() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) });
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
global.NotesSnImport = require(path.join(jsRoot, 'snimport.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

(async () => {
  await NotesStore.unlock('vault-password', 'salt-1');
  const noteId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const fileId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  NotesStore.upsert(noteId, {
    ...NotesStore.defaultNote(),
    title: 'Toren',
    content: 'Hallo',
  });

  const result = await NotesStore.importBackup({
    items: [
      {
        uuid: fileId,
        content_type: 'File',
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-01T00:00:00.000Z',
        content: {
          name: 'toren.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('pdf-bytes-ok').toString('base64'),
          references: [{ uuid: noteId, content_type: 'Note' }],
        },
      },
      {
        uuid: noteId,
        content_type: 'Note',
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-01T00:00:00.000Z',
        content: { title: 'Toren', text: 'Hallo' },
      },
    ],
  }, true);

  assert.equal(result.files, 1);
  assert.equal(result.filesMissing, 0);
  const note = NotesStore.get(noteId);
  assert.ok(note.content.attachments.includes(fileId));
  assert.deepEqual(note.content.sn_pending_files, []);
  const bytes = await NotesStore.getAttachmentBytes(fileId);
  assert.equal(Buffer.from(bytes).toString(), 'pdf-bytes-ok');

  const missing = await NotesStore.importBackup({
    items: [
      {
        uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        content_type: 'File',
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-01T00:00:00.000Z',
        content: {
          name: 'scan.jpg',
          mimeType: 'image/jpeg',
          references: [{ uuid: noteId, content_type: 'Note' }],
        },
      },
      {
        uuid: noteId,
        content_type: 'Note',
        created_at: '2024-03-01T00:00:00.000Z',
        updated_at: '2024-03-01T00:00:00.000Z',
        content: { title: 'Toren', text: 'Hallo' },
      },
    ],
  }, true);
  assert.ok(missing.filesMissing >= 1);
  const pending = NotesStore.get(noteId).content.sn_pending_files;
  assert.ok(pending.some((item) => item.name === 'scan.jpg'));

  const loose = await NotesStore.importLooseSnFiles([{
    name: 'scan.jpg',
    bytes: new Uint8Array([9, 8, 7, 6]),
    mime: 'image/jpeg',
  }]);
  assert.equal(loose.attached, 1);
  assert.ok(!NotesStore.get(noteId).content.sn_pending_files.some((item) => item.name === 'scan.jpg'));

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
