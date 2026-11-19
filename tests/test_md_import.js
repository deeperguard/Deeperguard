const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();
const store = () => ({
  store: {},
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
  setItem(key, value) { this.store[key] = String(value); },
  removeItem(key) { delete this.store[key]; },
});
global.addEventListener = () => {};
global.window = global;
global.localStorage = store();
global.sessionStorage = store();
global.NotesIDB = {
  async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
  async deleteItem(uuid) { idb.delete(uuid); blobs.delete(uuid); },
  async loadItems() { return [...idb.values()]; },
  async iterateItems(onRow) { for (const row of idb.values()) onRow(row); },
  async getItem(uuid) { return idb.get(uuid) || null; },
  async putBlob(uuid, blob) { blobs.set(uuid, blob); },
  async getBlob(uuid) { return blobs.get(uuid) || ''; },
  async deleteBlob(uuid) { blobs.delete(uuid); },
  async getMeta() { return null; },
  async putMeta() {},
};
const fetched = [];
global.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
require(path.join(jsRoot, 'labels.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
const Zip = require(path.join(jsRoot, 'ziplib.js'));
const Export = require(path.join(jsRoot, 'readable-export.js'));
const Import = require(path.join(jsRoot, 'md-import.js'));

const enc = (s) => new TextEncoder().encode(s);
const NOW = new Date('2026-11-18T12:00:00Z');

(async () => {
  // --- front-matter, titles, tags, dates, checklist ---------------------------------------------------------
  const fm = await Import.parse([{
    name: 'x.md',
    bytes: enc('---\ntitle: "Say \\"hi\\"\\nnow"\ncreated: 2025-01-02T03:04:05.000Z\nmodified: 2025-02-03T04:05:06.000Z\ntags: ["a", "B c"]\nunknown: 1\n---\n\nBody\n'),
  }], { now: NOW });
  assert.strictEqual(fm.notes.length, 1);
  const n0 = fm.notes[0];
  assert.strictEqual(n0.title, 'Say "hi"\nnow');
  assert.strictEqual(n0.titleManual, true);
  assert.strictEqual(n0.content, 'Body');
  assert.deepStrictEqual(n0.tags, ['a', 'B c']);
  assert.strictEqual(n0.created_at, '2025-01-02T03:04:05.000Z');
  assert.strictEqual(n0.updated_at, '2025-02-03T04:05:06.000Z');
  assert.strictEqual(n0.editor, 'markdown');

  const plain = await Import.parse([
    { name: 'heading.md', bytes: enc('\n# First heading\n\ntext\r\n') },
    { name: 'My file.md', bytes: enc('no heading here') },
    { name: 'csv.md', bytes: enc('---\ntitle: T\ntags: one, two\ncreated: 2999-01-01\nmodified: nonsense\n---\n- [ ] a\n- [x] b\n') },
    { name: 'empty.md', bytes: enc('') },
  ], { now: NOW });
  assert.deepStrictEqual(plain.notes.map((n) => n.title), ['First heading', 'My file', 'T', 'empty']);
  assert.strictEqual(plain.notes[0].content, 'text');
  assert.strictEqual(plain.notes[0].titleManual, false);
  assert.strictEqual(plain.notes[1].content, 'no heading here');
  assert.deepStrictEqual(plain.notes[2].tags, ['one', 'two']);
  assert.strictEqual(plain.notes[2].editor, 'checklist');
  assert.strictEqual(plain.notes[2].created_at, NOW.toISOString(), 'future date becomes import time');
  assert.strictEqual(plain.notes[2].updated_at, NOW.toISOString(), 'unparsable date becomes import time');
  assert.strictEqual(plain.notes[3].content, '');

  const odd = await Import.parse([
    { name: 'a.txt', bytes: enc('x') },
    { name: 'bin.md', bytes: Uint8Array.from([65, 0, 66]) },
  ], { now: NOW });
  assert.strictEqual(odd.notes.length, 0);
  assert.deepStrictEqual(odd.skipped.map((s) => s.name), ['a.txt', 'bin.md']);
  assert.deepStrictEqual((await Import.parse([], { now: NOW })).notes, []);

  // --- hostile content is cleaned before anything is stored -------------------------------------------------
  const hostile = [
    'Hello <b onclick="alert(1)">bold</b> and <strong onmouseover=alert(2)>strong</strong>',
    '<script>alert(3)</script>after',
    '<img src="x" onerror="alert(4)">',
    '<img src="https://evil.example/t.png">',
    '<a href="javascript:alert(5)" onclick="x()">link</a> <a href="https://ok.example/" style="x:y">ok</a>',
    '<iframe src="https://evil.example"></iframe><svg onload=alert(6)></svg>',
    '<style>body{display:none}</style><script>unclosed(7)',
    '',
    '```',
    '<script>shown as code</script>',
    '```',
  ].join('\n');
  const evil = await Import.parse([{ name: 'evil.md', bytes: enc(hostile) }], { now: NOW });
  const body = evil.notes[0].content;
  const outsideCode = body.replace(/```[\s\S]*$/, '');
  for (const bad of [/<script/i, /alert\(/, /\bon[a-z]+\s*=/i, /javascript:/i, /<iframe/i, /<svg/i, /<style/i, /evil\.example\/t\.png/, /unclosed/]) {
    assert.ok(!bad.test(outsideCode), `still present: ${bad}`);
  }
  assert.ok(body.includes('<strong>strong</strong>'), 'allowed tags stay');
  assert.ok(!body.includes('<b'), 'tags outside the allowlist are removed');
  assert.ok(body.includes('<a href="https://ok.example/">ok</a>'));
  assert.ok(body.includes('<script>shown as code</script>'), 'code blocks are left verbatim');

  // Tags without whitespace before the attributes, multi-line tags and ">" inside values.
  const sneaky = [
    '<img/src=x onerror=alert(1)>',
    '<img/src="data:image/png;base64,AAAA"/onerror=alert(2)>',
    '<a/href=# onclick=alert(3)>a</a>',
    '<a/href="#"/onclick=alert(4)>b</a>',
    '<img src="data:image/png;base64,AAAA" onerror=alert(5)\n>',
    '<a href="#" title="x>y" onclick="alert(6)">c</a>',
    '<img alt="a>b" src=x onerror=alert(7)>',
    '<p onclick=alert(8) <b>d</p>',
    '<img src="x',
    'ok <https://example.com/> and 1 < 2',
  ].join('\n');
  const sn = (await Import.parse([{ name: 'sneaky.md', bytes: enc(sneaky) }], { now: NOW })).notes[0].content;
  // Escaped text ("&lt;p onclick=...") is inert; only real tags may not carry handlers.
  assert.ok(!/<[^>]*\bon[a-z]+\s*=/i.test(sn), `handler survived: ${sn}`);
  assert.ok(!/<(?!\/?(?:a|p|img)\b|https:)/i.test(sn), `unexpected raw "<": ${sn}`);
  assert.ok(sn.includes('<a href="#" title="x&gt;y">c</a>'), sn);
  assert.ok(sn.includes('&lt;img src="x'), 'unterminated tag is escaped');
  assert.ok(sn.includes('<https://example.com/>') && sn.includes('1 &lt; 2'));

  // The renderer is a second line of defence: the imported text goes through render() and no live handler survives.
  const Markdown = require(path.join(jsRoot, 'markdown.js'));
  const rendered = Markdown.render(sn);
  assert.ok(rendered.length > 0);
  assert.ok(!/<[^>]*\bon[a-z]+\s*=/i.test(rendered), `handler survived rendering: ${rendered}`);
  assert.ok(!/<script|<iframe|javascript:/i.test(rendered), `active markup survived rendering: ${rendered}`);

  // The import allowlist is the NotesSanitize allowlist (minus button).
  for (const tag of NotesSanitize.RICH_ALLOWED_TAGS.filter((t) => t !== 'button' && !['br', 'hr', 'img'].includes(t))) {
    const out = (await Import.parse([{ name: 't.md', bytes: enc(`<${tag}>x</${tag}>`) }], { now: NOW })).notes[0].content;
    assert.strictEqual(out, `<${tag}>x</${tag}>`);
  }
  assert.ok(!(await Import.parse([{ name: 'b.md', bytes: enc('<button>x</button>') }], { now: NOW })).notes[0].content.includes('<button'));

  // --- hostile ZIPs are refused -----------------------------------------------------------------------------
  const base = await Zip.writeZip([{ name: 'ab/cdef.md', bytes: enc('x') }], { compress: false });
  const slip = Uint8Array.from(base);
  const from = enc('ab/cdef.md');
  const to = enc('../../x.md');
  for (let i = 0; i + from.length <= slip.length; i += 1) {
    if (from.every((v, k) => slip[i + k] === v)) slip.set(to, i);
  }
  await assert.rejects(Import.parse([{ name: 'slip.zip', bytes: slip }], { now: NOW }), /Unsafe entry name/);
  const zeros = new Uint8Array(20 * 1024 * 1024);
  const bomb = await Zip.writeZip([{ name: 'bomb.md', bytes: zeros }]);
  await assert.rejects(Import.parse([{ name: 'bomb.zip', bytes: bomb }], { now: NOW }), /ratio/i);

  // --- round trip: readable export -> import into the store -------------------------------------------------
  await NotesStore.unlock('vault-password', 'salt-1');
  const pdfBytes = enc('%PDF-1.4 round trip');
  const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
  const pdfId = 'aaaaaaaa-1111-4000-8000-000000000001';
  const pngId = 'bbbbbbbb-1111-4000-8000-000000000002';
  const items = new Map([
    [pdfId, { uuid: pdfId, content: { type: 'attachment', filename: 'layout test.pdf', mime: 'application/pdf' }, bytes: pdfBytes }],
    [pngId, { uuid: pngId, content: { type: 'attachment', filename: 'scan (1).png', mime: 'image/png' }, bytes: pngBytes }],
  ]);
  const mk = (uuid, c) => ({
    uuid,
    content: {
      type: 'note', title: 'T', content: '', tags: [], attachments: [], created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-02T11:00:00.000Z', ...c,
    },
  });
  const original = [
    mk('n1', {
      title: 'Café: "plan"', content: '# Inner heading\n\nLine one\n\n- item\n\n```\ncode\n```', tags: ['t1', 't2'], attachments: [pdfId, pngId],
    }),
    mk('n2', { title: 'Tasks', content: '- [ ] one\n- [x] two' }),
    mk('n3', { title: 'Empty', content: '' }),
    mk('n4', { title: 'Same', content: 'first' }),
    mk('n5', { title: 'Same', content: 'second', created_at: '2026-11-03T10:00:00.000Z' }),
  ];
  const exported = await Export.build({
    notes: original,
    tags: [{ uuid: 't1', content: { type: 'tag', title: 'work' } }, { uuid: 't2', content: { type: 'tag', title: 'say "hi"' } }],
    getAttachment: (id) => items.get(id),
    getAttachmentBytes: async (id) => items.get(id).bytes,
    now: NOW,
  });
  const parsed = await Import.parse([{ name: exported.filename, bytes: exported.bytes }], { now: NOW });
  assert.strictEqual(parsed.notes.length, 5);
  assert.strictEqual(parsed.attachmentCount, 2);
  assert.deepStrictEqual(parsed.skipped, [], 'README.txt is not reported; everything else was used');

  const result = await NotesStore.importMarkdownNotes(parsed);
  assert.strictEqual(result.imported, 5);
  assert.strictEqual(result.files, 2);
  assert.strictEqual(result.tags, 2);
  assert.deepStrictEqual(result.failedFiles, []);
  const find = (title, content) => NotesStore.listNotes().find((n) => n.content.title === title && (content === undefined || n.content.content === content));
  for (const src of original) {
    const got = find(src.content.title, src.content.content);
    assert.ok(got, `note ${src.content.title} imported with its body`);
    assert.strictEqual(got.content.created_at, src.content.created_at);
    assert.strictEqual(got.content.updated_at, src.content.updated_at, 'modified date survives attachments');
    assert.strictEqual(got.content.title_manual, true);
    assert.notStrictEqual(got.uuid, src.uuid, 'new uuid');
  }
  const main = find('Café: "plan"');
  const tagTitles = main.content.tags.map((id) => NotesStore.get(id).content.title).sort();
  assert.deepStrictEqual(tagTitles, ['say "hi"', 'work']);
  assert.strictEqual(main.content.attachments.length, 2);
  const files = new Map();
  for (const id of main.content.attachments) {
    const a = NotesStore.get(id);
    assert.strictEqual(a.content.note_id, main.uuid);
    files.set(a.content.filename, { mime: a.content.mime, bytes: await NotesStore.getAttachmentBytes(id) });
  }
  assert.deepStrictEqual([...files.keys()].sort(), ['layout test.pdf', 'scan (1).png']);
  assert.strictEqual(files.get('layout test.pdf').mime, 'application/pdf');
  assert.deepStrictEqual(Buffer.from(files.get('scan (1).png').bytes), Buffer.from(pngBytes));
  assert.strictEqual(find('Tasks').content.editor, 'checklist');

  // Stored encrypted: no plaintext in the persisted row.
  const row = idb.get(main.uuid);
  assert.ok(row.ciphertext);
  assert.ok(!JSON.stringify(row).includes('Inner heading') && !JSON.stringify(row).includes('plan'));

  // Importing the same ZIP twice reuses tags and survives the identical attachments.
  const again = await NotesStore.importMarkdownNotes(await Import.parse([{ name: exported.filename, bytes: exported.bytes }], { now: NOW }));
  assert.strictEqual(again.imported, 5);
  assert.strictEqual(again.tags, 0);
  assert.strictEqual(again.files, 2);
  assert.strictEqual(NotesStore.listTags().length, 2);

  // Hostile text never reaches the store with script or handlers; nothing outside the sync API is requested.
  await NotesStore.importMarkdownNotes(evil);
  const stored = NotesStore.listNotes().find((n) => n.content.title === 'evil').content.content;
  assert.ok(!/<script|onerror|onclick|javascript:/i.test(stored.replace(/```[\s\S]*$/, '')));
  assert.ok(fetched.every((url) => !/example|evil/.test(url)), 'no imported URL was requested');

  // A relative link that leaves the archive or points to the web is never read.
  const links = await Zip.writeZip([
    { name: 'notes/a.md', bytes: enc('![x](../../secret.png) ![y](https://example.com/y.png) [z](/etc/passwd) [ok](../files/doc.pdf)') },
    { name: 'files/doc.pdf', bytes: enc('pdf') },
    { name: 'files/unused.bin', bytes: enc('zz') },
  ]);
  const lp = await Import.parse([{ name: 'l.zip', bytes: links }], { now: NOW });
  assert.deepStrictEqual(lp.notes[0].attachments.map((a) => a.name), ['doc.pdf']);
  assert.deepStrictEqual(lp.skipped.map((s) => s.name), ['l.zip: files/unused.bin']);

  console.log('md import ok');
})().catch((err) => { console.error(err); process.exit(1); });
