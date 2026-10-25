const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');

const NotesSnImport = require(path.join(root, 'app/static/js/snimport.js'));
const {
  stageSecureSendNoteAttachments,
  stageSecureSendEntries,
  disambiguateZipName,
} = require(path.join(root, 'app/static/js/secure-send-note-attachments.js'));

function fileFromBytes(bytes, filename, mime) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    name: filename,
    type: mime || 'application/octet-stream',
    size: data.length,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}

function att(uuid, filename) {
  return { uuid, deleted: false, content: { filename } };
}

(async () => {
  const zero = await stageSecureSendNoteAttachments({
    attachments: [],
    loadBytes: async () => new Uint8Array(0),
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
  });
  assert.strictEqual(zero.file, null);
  assert.deepStrictEqual(zero.includedNames, []);
  assert.strictEqual(zero.zipNote, '');

  const one = await stageSecureSendNoteAttachments({
    attachments: [att('a', 'report.pdf')],
    loadBytes: async () => Uint8Array.from([9, 8, 7]),
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
    maxFileBytes: 50,
  });
  assert.deepStrictEqual(one.includedNames, ['report.pdf']);
  assert.strictEqual(one.zipNote, '');
  assert.strictEqual(one.file.name, 'report.pdf');
  assert.strictEqual(one.file.size, 3);

  const big = await stageSecureSendNoteAttachments({
    attachments: [att('b', 'huge.bin')],
    loadBytes: async () => new Uint8Array(60),
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
    maxFileBytes: 50,
  }).catch((err) => err);
  assert.ok(big instanceof Error);
  assert.match(big.message, /50 MB/);

  const multi = await stageSecureSendNoteAttachments({
    attachments: [att('1', 'alpha.txt'), att('2', 'beta.txt')],
    noteTitle: 'My Note',
    loadBytes: async (row) => {
      if (row.uuid === '1') return Uint8Array.from([1, 2]);
      return Uint8Array.from([3, 4, 5]);
    },
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
    maxFileBytes: 1024 * 1024,
  });
  assert.deepStrictEqual(multi.includedNames, ['alpha.txt', 'beta.txt']);
  assert.ok(multi.zipNote.includes('zip'));
  assert.ok(/\.zip$/i.test(multi.file.name));
  assert.ok(multi.file.size > 0);

  const zipped = await NotesSnImport.unzip(new Uint8Array(await multi.file.arrayBuffer()));
  const names = zipped.map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['alpha.txt', 'beta.txt']);
  assert.strictEqual(Buffer.from(zipped.find((e) => e.name === 'alpha.txt').bytes).toString('hex'), '0102');
  assert.strictEqual(Buffer.from(zipped.find((e) => e.name === 'beta.txt').bytes).toString('hex'), '030405');

  const dup = await stageSecureSendNoteAttachments({
    attachments: [att('x', 'same.png'), att('y', 'same.png')],
    loadBytes: async () => Uint8Array.from([0]),
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
  });
  const dupEntries = await NotesSnImport.unzip(new Uint8Array(await dup.file.arrayBuffer()));
  assert.deepStrictEqual(
    dupEntries.map((e) => e.name).sort(),
    ['same (2).png', 'same.png'],
  );
  assert.deepStrictEqual(dup.includedNames, ['same.png', 'same (2).png']);

  const oversizeZip = await stageSecureSendNoteAttachments({
    attachments: [att('1', 'a.bin'), att('2', 'b.bin')],
    loadBytes: async () => new Uint8Array(40),
    fileFromBytes,
    zipStored: NotesSnImport.zipStored,
    maxFileBytes: 50,
  }).catch((err) => err);
  assert.ok(oversizeZip instanceof Error);
  assert.match(oversizeZip.message, /50 MB/);
  assert.match(oversizeZip.message, /2 files/);

  const used = new Set();
  assert.strictEqual(disambiguateZipName('doc.pdf', used), 'doc.pdf');
  used.add('doc.pdf');
  assert.strictEqual(disambiguateZipName('doc.pdf', used), 'doc (2).pdf');

  const restageOne = stageSecureSendEntries(
    [{ name: 'solo.bin', bytes: Uint8Array.from([1]) }],
    { fileFromBytes, zipStored: NotesSnImport.zipStored },
  );
  assert.strictEqual(restageOne.file.name, 'solo.bin');
  assert.deepStrictEqual(restageOne.includedNames, ['solo.bin']);

  const restageZip = stageSecureSendEntries(
    [
      { name: 'a.txt', bytes: Uint8Array.from([1]) },
      { name: 'b.txt', bytes: Uint8Array.from([2, 3]) },
    ],
    { fileFromBytes, zipStored: NotesSnImport.zipStored, noteTitle: 'Zip me' },
  );
  assert.ok(restageZip.zipNote.includes('zip'));
  assert.deepStrictEqual(restageZip.includedNames, ['a.txt', 'b.txt']);

  const restageEmpty = stageSecureSendEntries([], { fileFromBytes, zipStored: NotesSnImport.zipStored });
  assert.strictEqual(restageEmpty.file, null);
  assert.deepStrictEqual(restageEmpty.includedNames, []);

  console.log('test_secure_send_note_attachments ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
