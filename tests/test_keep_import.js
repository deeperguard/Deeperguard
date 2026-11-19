const assert = require('assert');
const path = require('path');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
const Zip = require(path.join(jsRoot, 'ziplib.js'));
const Import = require(path.join(jsRoot, 'keep-import.js'));

const enc = (s) => new TextEncoder().encode(s);
const NOW = new Date('2026-11-18T12:00:00Z');
const json = (o) => enc(JSON.stringify(o));
const zip = (entries) => Zip.writeZip(entries.map(([name, bytes]) => ({ name, bytes })), { compress: false });
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

(async () => {
  const takeout = await zip([
    ['Takeout/Keep/Plain.json', json({
      title: 'Groceries talk', textContent: 'Buy tea', isPinned: true,
      labels: [{ name: 'Home' }, { name: 'home' }, { name: 'Errands' }],
      createdTimestampUsec: 1700000000000000, userEditedTimestampUsec: 1700000500000000,
      annotations: [{ url: 'https://example.com/a', title: 'Shop' }, { url: 'javascript:alert(1)', title: 'bad' }],
    })],
    ['Takeout/Keep/Plain.html', enc('<html><body>DUPLICATE HTML COPY</body></html>')],
    ['Takeout/Keep/List.json', json({
      title: 'Todo', isArchived: true,
      listContent: [{ text: 'milk', isChecked: false }, { text: 'eggs\nfree range', isChecked: true }],
      userEditedTimestampUsec: 1700000600000000,
    })],
    ['Takeout/Keep/Photo.json', json({
      title: 'With photo', textContent: 'see file',
      attachments: [{ filePath: 'IMG_1.PNG', mimetype: 'image/png' }, { filePath: 'gone.jpg', mimetype: 'image/jpeg' }],
    })],
    ['Takeout/Keep/img_1.png', PNG],
    ['Takeout/Keep/Trash.json', json({ title: 'Deleted', textContent: 'secret', isTrashed: true, labels: [{ name: 'OnlyOnTrashed' }] })],
    ['Takeout/Keep/Html.json', json({ title: 'Html only', textContentHtml: '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><img src="http://evil.test/a.png">' })],
    ['Takeout/Keep/Labels.txt', enc('Home\nErrands\n')],
  ]);
  const r = await Import.parse([{ name: 'takeout.zip', bytes: takeout }], { now: NOW });
  const by = Object.fromEntries(r.notes.map((n) => [n.title, n]));

  // text note: content, tags (deduplicated), dates, pin, link annotation; unsafe annotation dropped
  assert.deepStrictEqual(Object.keys(by).sort(), ['Groceries talk', 'Html only', 'Todo', 'With photo']);
  const plain = by['Groceries talk'];
  assert.strictEqual(plain.content, 'Buy tea\n\n[Shop](https://example.com/a)');
  assert.strictEqual(plain.editor, 'plain');
  assert.deepStrictEqual(plain.tags, ['Home', 'Errands']);
  assert.strictEqual(plain.pinned, true);
  assert.strictEqual(plain.archived, false);
  assert.strictEqual(plain.created_at, '2023-11-14T22:13:20.000Z');
  assert.strictEqual(plain.updated_at, '2023-11-14T22:21:40.000Z');
  assert.strictEqual(plain.titleManual, true);

  // checklist
  const list = by.Todo;
  assert.strictEqual(list.content, '- [ ] milk\n- [x] eggs free range');
  assert.strictEqual(list.editor, 'checklist');
  assert.strictEqual(list.archived, true);

  // attachment matched by base name, case-insensitive; the missing one is reported
  const photo = by['With photo'];
  assert.strictEqual(photo.attachments.length, 1);
  assert.strictEqual(photo.attachments[0].mime, 'image/png');
  assert.deepStrictEqual([...photo.attachments[0].bytes], [...PNG]);
  assert.strictEqual(r.attachmentCount, 1);
  assert.ok(r.skipped.some((s) => /gone\.jpg/.test(s.name) && /not in the ZIP/.test(s.reason)));

  // trashed note skipped, and its label does not leak into any note's tags
  assert.ok(!r.notes.some((n) => n.content.includes('secret') || n.title === 'Deleted'));
  assert.ok(r.skipped.some((s) => /Trash\.json/.test(s.name) && /trash/.test(s.reason)));
  assert.ok(!r.notes.some((n) => n.tags.includes('OnlyOnTrashed')));

  // HTML copies ignored; HTML-only JSON goes through the allowlist
  assert.ok(!r.notes.some((n) => /DUPLICATE/.test(n.content)));
  const html = by['Html only'].content;
  assert.ok(/<strong>there<\/strong>/.test(html));
  assert.ok(!/script|onclick|alert|evil\.test/.test(html), html);

  // malicious entry names are refused and nothing is returned
  // (the writer refuses such names, so a valid name of the same length is patched in the header bytes)
  const patched = async (good, bad) => {
    const bytes = await zip([[good, json({ title: 'x', textContent: 'y' })]]);
    const g = enc(good);
    const b = enc(bad);
    let hits = 0;
    for (let i = 0; i + g.length <= bytes.length; i += 1) {
      if (g.every((v, k) => bytes[i + k] === v)) { bytes.set(b, i); hits += 1; }
    }
    assert.strictEqual(hits, 2);
    return bytes;
  };
  for (const [good, bad] of [
    ['xx/evil.json', '../evil.json'], ['Takeout/xx/xx/evil.json', 'Takeout/../../evil.json'],
    ['zabs/evil.json', '/abs/evil.json'], ['Takeout_Keep_x.json', 'Takeout\\Keep\\x.json'], ['Cz/x.json', 'C:/x.json'],
  ]) {
    const evil = await patched(good, bad);
    await assert.rejects(Import.parse([{ name: 'evil.zip', bytes: evil }], { now: NOW }), /Unsafe entry name/, bad);
  }

  // an attachment path in the JSON that tries to leave the archive only matches by base name
  const sneaky = await zip([
    ['Keep/a.json', json({ title: 'a', textContent: 'b', attachments: [{ filePath: '../../etc/passwd', mimetype: 'text/plain' }] })],
  ]);
  const s = await Import.parse([{ name: 's.zip', bytes: sneaky }], { now: NOW });
  assert.strictEqual(s.notes[0].attachments.length, 0);

  // too deep JSON, invalid JSON, non-note JSON, non-zip, zip without notes, same input twice
  const deep = `{"title":"d","textContent":"x","a":${'['.repeat(70)}${']'.repeat(70)}}`;
  await assert.rejects(Import.parse([{ name: 'd.zip', bytes: await zip([['Keep/d.json', enc(deep)]]) }], { now: NOW }), /nested deeper/);
  const odd = await Import.parse([
    { name: 'o.zip', bytes: await zip([['Keep/bad.json', enc('{nope')], ['Keep/arr.json', enc('[1]')], ['Keep/empty.json', json({ textContent: '', isTrashed: false })]]) },
    { name: 'notes.txt', bytes: enc('x') },
    { name: 'none.zip', bytes: await zip([['readme.txt', enc('x')]]) },
  ], { now: NOW });
  assert.strictEqual(odd.notes.length, 0);
  assert.strictEqual(odd.skipped.length, 4);
  const again = await Import.parse([{ name: 'takeout.zip', bytes: takeout }], { now: NOW });
  assert.strictEqual(again.notes.length, r.notes.length);
  assert.strictEqual(again.attachmentCount, 1);

  // nested checklist items (parentId) are not kept as nesting: each item is one top-level line, in order
  const nestedZip = await zip([
    ['Keep/Nested.json', json({
      title: 'Nested', listContent: [
        { text: 'parent', isChecked: false },
        { text: 'child', isChecked: true, parentId: 'p1' },
        { text: 'sibling', isChecked: false },
      ],
    })],
  ]);
  const nested = await Import.parse([{ name: 'nested.zip', bytes: nestedZip }], { now: NOW });
  assert.strictEqual(nested.notes[0].content, '- [ ] parent\n- [x] child\n- [ ] sibling');
  assert.strictEqual(nested.notes[0].editor, 'checklist');

  console.log('keep import ok');
})().catch((err) => { console.error(err); process.exit(1); });
