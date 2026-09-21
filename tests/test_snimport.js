const assert = require('assert');
const { parse, mergeTagsByTitle, applyBackupBlobs, matchLooseFile, unzip } = require('../app/static/js/snimport.js');

const tagId = '11111111-1111-4111-8111-111111111111';
const noteId = '22222222-2222-4222-8222-222222222222';

const decrypted = {
  items: [
    {
      uuid: tagId,
      content_type: 'Tag',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
      content: {
        title: 'Travel',
        color: '#2ec4b6',
        references: [{ uuid: noteId, content_type: 'Note' }],
      },
    },
    {
      uuid: noteId,
      content_type: 'Note',
      created_at: '2024-01-01T12:00:00.000Z',
      updated_at: '2024-06-01T12:00:00.000Z',
      content: {
        title: 'Boarding pass',
        text: 'Gate A12',
        noteType: 'markdown',
        appData: { 'org.standardnotes.sn': { pinned: true, starred: true } },
      },
    },
    {
      uuid: 'component-1',
      content_type: 'SN|Component',
      content: { name: 'editor' },
    },
  ],
};

const sn = parse(decrypted);
assert.equal(sn.kind, 'sn');
assert.equal(sn.tags.length, 1);
assert.equal(sn.tags[0].content.title, 'Travel');
assert.equal(sn.notes.length, 1);
assert.equal(sn.notes[0].content.title, 'Boarding pass');
assert.equal(sn.notes[0].content.content, 'Gate A12');
assert.deepEqual(sn.notes[0].content.tags, [tagId]);
assert.equal(sn.notes[0].content.editor, 'markdown');
assert.equal(sn.notes[0].content.prevent_edit, false);
assert.equal(sn.notes[0].content.pinned, true);
assert.equal(sn.skipped, 1);

const checklist = parse({
  items: [
    {
      uuid: '33333333-3333-4333-8333-333333333333',
      content_type: 'Note',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      content: { title: 'Groceries', text: '- [ ] Milk', noteType: 'task' },
    },
    {
      uuid: '44444444-4444-4444-8444-444444444444',
      content_type: 'Note',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      content: { title: 'Nested', text: '- [ ] A\n  - [ ] B', noteType: 'super' },
    },
  ],
});
assert.equal(checklist.notes[0].content.editor, 'checklist');
assert.equal(checklist.notes[1].content.editor, 'super');

const superArticle = parse({
  items: [{
    uuid: '55555555-5555-4555-8555-555555555555',
    content_type: 'Note',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    content: {
      title: 'Project dakterras',
      noteType: 'super',
      text: '{"type":"doc","content":[]}',
      preview_plain: 'Hallo,\nSinds eind 2023 zijn we de eigenaar van de toren.',
    },
  }],
});
assert.equal(superArticle.notes[0].content.editor, 'markdown');
assert.match(superArticle.notes[0].content.content, /Hallo/);

const superLinked = parse({
  items: [{
    uuid: '55555555-5555-4555-8555-555555555556',
    content_type: 'Note',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    content: {
      title: 'Linked super',
      noteType: 'super',
      text: JSON.stringify({
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Open ' },
            {
              type: 'text',
              text: 'Cursor',
              marks: [{ type: 'link', attrs: { href: 'https://cursor.com/agents' } }],
            },
          ],
        }],
      }),
      preview_plain: 'Open Cursor',
    },
  }],
});
assert.match(superLinked.notes[0].content.content, /\[Cursor\]\(https:\/\/cursor\.com\/agents\)/);

const dupTagA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const dupTagB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const dupNote = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const dupTags = parse({
  items: [
    {
      uuid: dupTagA,
      content_type: 'Tag',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      content: { title: 'BV', references: [{ uuid: dupNote, content_type: 'Note' }] },
    },
    {
      uuid: dupTagB,
      content_type: 'Tag',
      created_at: '2024-01-02T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
      content: { title: 'bv', references: [{ uuid: dupNote, content_type: 'Note' }] },
    },
    {
      uuid: dupNote,
      content_type: 'Note',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      content: { title: 'Tower', text: 'Hallo' },
    },
  ],
});
assert.equal(dupTags.tags.length, 1, 'duplicate SN tag titles collapse');
assert.deepEqual(dupTags.notes[0].content.tags, [dupTagA]);

const remapped = mergeTagsByTitle(
  [{ uuid: 'sn-pc', content: { title: 'PC', type: 'tag' } }],
  [{ uuid: 'n1', content: { tags: ['sn-pc'] } }],
  [{ uuid: 'home-pc', content: { title: 'PC' } }],
);
assert.equal(remapped.tags.length, 0);
assert.deepEqual(remapped.notes[0].content.tags, ['home-pc']);
assert.equal(remapped.remapped, 1);

const decrypted004 = parse({
  version: '004',
  keyParams: { version: '004', identifier: 'user@example.com' },
  items: [
    {
      uuid: noteId,
      content_type: 'Note',
      items_key_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      created_at: '2024-01-01T12:00:00.000Z',
      updated_at: '2024-06-01T12:00:00.000Z',
      content: { title: 'Decrypted 004', text: 'plain text' },
    },
    {
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      content_type: 'SN|ItemsKey',
      enc_item_key: '004:aaa:bbb:ccc',
      content: '004:aaa:bbb:ccc',
    },
  ],
});
assert.equal(decrypted004.kind, 'sn', 'version 004 + keyParams must not block a decrypted backup');
assert.equal(decrypted004.notes.length, 1);
assert.equal(decrypted004.notes[0].content.title, 'Decrypted 004');
assert.equal(decrypted004.notes[0].content.content, 'plain text');

const stringContent = parse({
  items: [{
    uuid: noteId,
    content_type: 'Note',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    content: JSON.stringify({ title: 'Legacy', text: 'json string' }),
  }],
});
assert.equal(stringContent.kind, 'sn');
assert.equal(stringContent.notes[0].content.title, 'Legacy');

const encrypted = parse({
  version: '004',
  items: [{ uuid: noteId, content_type: 'Note', content: '004:abcd', enc_item_key: '004:x:y:z' }],
});
assert.equal(encrypted.kind, 'sn-encrypted');
assert.match(encrypted.error, /Decrypted backup/);

const homelab = parse({
  format: 'deeperguard-backup-v1',
  items: [{ item_uuid: 'n1', ciphertext: '{"v":1}' }],
});
assert.equal(homelab.kind, 'homelab');

assert.throws(() => parse('PK\x03\x04zip'), /Unzip the Standard Notes backup/);

const fileNote = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const fileId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const withFile = parse({
  items: [
    {
      uuid: fileId,
      content_type: 'File',
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
      content: {
        name: 'toren.pdf',
        mimeType: 'application/pdf',
        decryptedSize: 11,
        data: Buffer.from('hello-pdf!!').toString('base64'),
        references: [{ uuid: fileNote, content_type: 'Note' }],
      },
    },
    {
      uuid: fileNote,
      content_type: 'Note',
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
      content: { title: 'Toren', text: 'Hallo' },
    },
  ],
});
assert.equal(withFile.files.length, 1);
assert.equal(withFile.files[0].name, 'toren.pdf');
assert.ok(withFile.files[0].data_b64);
assert.deepEqual(withFile.files[0].noteIds, [fileNote]);
assert.equal(withFile.notes[0].content.sn_pending_files[0].name, 'toren.pdf');

const missingFile = parse({
  items: [
    {
      uuid: fileId,
      content_type: 'File',
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
      content: {
        name: 'scan.jpg',
        mimeType: 'image/jpeg',
        references: [{ uuid: fileNote, content_type: 'Note' }],
      },
    },
    {
      uuid: fileNote,
      content_type: 'Note',
      created_at: '2024-03-01T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
      content: { title: 'Scan', text: 'x' },
    },
  ],
});
assert.equal(missingFile.files[0].data_b64, '');
assert.equal(missingFile.notes[0].content.sn_pending_files[0].name, 'scan.jpg');
const matched = applyBackupBlobs(missingFile, [{
  name: `Files/${fileId}/scan.jpg`,
  bytes: new Uint8Array([1, 2, 3, 4]),
}]);
assert.ok(matched.files[0].data_b64);

const superNote = parse({
  items: [{
    uuid: fileNote,
    content_type: 'Note',
    created_at: '2024-03-01T00:00:00.000Z',
    updated_at: '2024-03-01T00:00:00.000Z',
    content: {
      title: 'Photo',
      noteType: 'super',
      preview_plain: 'See photo',
      text: JSON.stringify({
        type: 'doc',
        content: [{
          type: 'image',
          attrs: { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1s=' },
        }],
      }),
    },
  }],
});
assert.equal(superNote.notes[0].content.editor, 'markdown');
assert.equal(superNote.files.length, 1);
assert.ok(superNote.files[0].data_b64);

assert.equal(matchLooseFile([{ uuid: 'x', name: 'Toren.PDF' }], 'toren.pdf').uuid, 'x');

function crc32(bytes) {
  let crc = ~0;
  for (const value of bytes) {
    crc ^= value;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

(async () => {
  const zipped = await unzip(storedZip([
    { name: 'Files/photo.png', data: Buffer.from('PNGDATA') },
  ]));
  assert.equal(zipped.length, 1);
  assert.equal(zipped[0].name, 'Files/photo.png');
  assert.equal(Buffer.from(zipped[0].bytes).toString(), 'PNGDATA');
  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
