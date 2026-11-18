const assert = require('assert');
const Zip = require('../app/static/js/ziplib.js');
const Export = require('../app/static/js/readable-export.js');

const dec = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);

const note = (uuid, content) => ({
  uuid,
  content: {
    type: 'note', title: 'T', content: '', tags: [], attachments: [], locked: false, trashed: false,
    created_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T11:00:00.000Z', ...content,
  },
});
const att = (uuid, filename, mime, bytes) => ({ uuid, content: { type: 'attachment', filename, mime }, bytes });

(async () => {
  // Any network use during the export would fail this test.
  global.fetch = () => { throw new Error('network used'); };
  global.XMLHttpRequest = function Xhr() { throw new Error('network used'); };

  const pdf = att('aaaaaaaa-1111-4000-8000-000000000001', 'layout test.pdf', 'application/pdf', enc('%PDF-1'));
  const png = att('bbbbbbbb-1111-4000-8000-000000000002', 'scan (1).png', 'image/png', Uint8Array.from([137, 80, 78, 71, 0, 255]));
  const gone = att('cccccccc-1111-4000-8000-000000000003', 'missing.bin', 'application/octet-stream', null);
  const items = new Map([pdf, png, gone].map((a) => [a.uuid, a]));
  const tags = [{ uuid: 't1', content: { type: 'tag', title: 'work' } }, { uuid: 't2', content: { type: 'tag', title: 'say "hi"' } }];

  const notes = [
    note('n1', {
      title: 'Meeting: Q1/Q2?', content: 'Line one\nLine two', tags: ['t1', 't2'], attachments: [pdf.uuid, png.uuid, gone.uuid],
    }),
    note('n2', { title: 'meeting: q1/q2?', content: 'dup', created_at: '2026-11-18T12:00:00.000Z' }),
    note('n3', { title: 'Café "quoted"\nnewline', content: '' }),
    note('n4', { title: 'con', content: 'reserved' }),
    note('n5', { title: 'Secret', content: 'x', locked: true }),
    note('n6', { title: 'Deleted', content: 'x', trashed: true }),
  ];
  const progress = [];
  const result = await Export.build({
    notes,
    tags,
    getAttachment: (id) => items.get(id),
    getAttachmentBytes: async (id) => items.get(id).bytes,
    onProgress: (p) => progress.push(p),
    now: new Date('2026-11-18T23:59:00Z'),
  });

  assert.strictEqual(result.filename, 'deeperguard-export-2026-11-18.zip');
  assert.deepStrictEqual(result.counts, { notes: 4, attachments: 2 });
  const files = new Map((await Zip.readZip(result.bytes)).map((e) => [e.name, e.bytes]));
  assert.deepStrictEqual([...files.keys()].sort(), [
    'README.txt',
    'attachments/aaaaaaaa-layout test.pdf',
    'attachments/bbbbbbbb-scan (1).png',
    'notes/Café _quoted__newline.md',
    'notes/Meeting_ Q1_Q2_.md',
    'notes/_con.md',
    'notes/meeting_ q1_q2_ (2).md',
  ]);

  const main = dec(files.get('notes/Meeting_ Q1_Q2_.md'));
  assert.strictEqual(main, [
    '---',
    'title: "Meeting: Q1/Q2?"',
    'created: 2026-11-18T10:00:00.000Z',
    'modified: 2026-11-18T11:00:00.000Z',
    'tags: ["work", "say \\"hi\\""]',
    'attachments: ["aaaaaaaa-layout test.pdf", "bbbbbbbb-scan (1).png"]',
    '---',
    '',
    'Line one',
    'Line two',
    '',
    'Attachments:',
    '',
    '- [layout test.pdf](../attachments/aaaaaaaa-layout%20test.pdf)',
    '- ![scan (1).png](../attachments/bbbbbbbb-scan%20%281%29.png)',
    '',
  ].join('\n'));
  assert.ok(dec(files.get('notes/Café _quoted__newline.md')).includes('title: "Café \\"quoted\\"\\nnewline"'));
  assert.ok(!dec(files.get('notes/_con.md')).includes('attachments:'));

  assert.deepStrictEqual([...files.get('attachments/bbbbbbbb-scan (1).png')], [137, 80, 78, 71, 0, 255]);
  assert.strictEqual(dec(files.get('attachments/aaaaaaaa-layout test.pdf')), '%PDF-1');

  const readme = dec(files.get('README.txt'));
  assert.ok(readme.startsWith('WARNING: THIS ARCHIVE IS NOT ENCRYPTED.\n'));
  assert.ok(readme.includes('1 locked note(s)') && readme.includes('1 trashed note(s)'));
  assert.ok(readme.includes('unreadable attachment: missing.bin'));
  assert.ok(!readme.includes('Secret') && ![...files.values()].some((b) => dec(b).includes('Deleted')));

  assert.ok(progress.every((p) => p.total === 7));
  assert.strictEqual(progress[progress.length - 2].done, 7);
  assert.strictEqual(progress[progress.length - 1].status, 'Zipping');

  // Same attachment-id prefix: both use the full uuid.
  const a1 = att('dddddddd-0000-4000-8000-000000000001', 'a.txt', 'text/plain', enc('1'));
  const a2 = att('dddddddd-0000-4000-8000-000000000002', 'a.txt', 'text/plain', enc('2'));
  const clash = await Export.build({
    notes: [note('n', { attachments: [a1.uuid, a2.uuid] })],
    getAttachment: (id) => [a1, a2].find((a) => a.uuid === id),
    getAttachmentBytes: async (id) => [a1, a2].find((a) => a.uuid === id).bytes,
  });
  const names = (await Zip.readZip(clash.bytes)).map((e) => e.name);
  assert.ok(names.includes(`attachments/${a1.uuid}-a.txt`) && names.includes(`attachments/${a2.uuid}-a.txt`));

  // Nothing exportable: no archive.
  assert.strictEqual(await Export.build({ notes: [notes[4], notes[5]], getAttachment: () => null, getAttachmentBytes: async () => null }), null);
  assert.strictEqual(await Export.build({ notes: [], getAttachment: () => null, getAttachmentBytes: async () => null }), null);

  // Hostile names never produce a path segment.
  assert.strictEqual(Export.safeName('../../etc/passwd'), '_.._etc_passwd');
  assert.strictEqual(Export.safeName('x'.repeat(300)).length, 80);
  assert.strictEqual(Export.safeName('', { attachment: true }), 'unnamed');
  assert.strictEqual(Export.safeName('a'.repeat(200) + '.pdf', { attachment: true }).endsWith('.pdf'), true);
  console.log('readable export ok');
})().catch((err) => { console.error(err); process.exit(1); });
