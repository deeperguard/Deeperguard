// Own order of notes inside a label (docs/FOLDERS_SPEC.md section 4): the sort key lives
// in the encrypted label record, old notes without a key sort last, and two devices that
// reorder the same label never lose a note.
const assert = require('assert');
const h = require('./sync_harness');
const L = require('../app/static/js/labels.js');
const S = require('../app/static/js/search.js');

const { NotesStore } = h;
const note = (uuid, created, extra = {}) => ({
  uuid,
  content: { type: 'note', title: uuid, content: '', tags: ['L'], created_at: created, updated_at: created, ...extra },
});
const ids = (list) => list.map((n) => n.uuid);

(async () => {
  // --- format: keyed notes by k, ties by uuid ---
  const six = ['a', 'b', 'c', 'd'].map((id, i) => note(id, `2024-01-0${i + 1}T00:00:00Z`));
  const keys = { a: { k: 2048, t: 1 }, b: { k: 1024, t: 1 }, c: { k: 1024, t: 1 } };
  assert.deepStrictEqual(ids(L.orderNotes(six, keys)), ['b', 'c', 'a', 'd'], 'k, then uuid; unkeyed note last');

  // --- old data: no note_keys at all -> newest created first, stable, nothing lost ---
  const old = [note('x', '2023-01-01T00:00:00Z'), note('y', '2023-06-01T00:00:00Z'), note('z', '2023-06-01T00:00:00Z')];
  assert.deepStrictEqual(ids(L.orderNotes(old, undefined)), ['y', 'z', 'x']);
  assert.deepStrictEqual(ids(L.orderNotes([...old].reverse(), {})), ['y', 'z', 'x'], 'input order does not matter');
  assert.deepStrictEqual(ids(L.orderNotes([], keys)), []);
  assert.deepStrictEqual(ids(L.orderNotes([old[0]], keys)), ['x']);
  // a note without created_at counts as oldest: it comes after every dated note, ties by uuid
  const undated = (uuid) => ({ uuid, content: { type: 'note', title: uuid, content: '', tags: ['L'] } });
  assert.deepStrictEqual(ids(L.orderNotes([undated('w'), old[0], undated('u'), old[1]], undefined)), ['y', 'x', 'u', 'w'], 'missing created_at sorts last');
  assert.deepStrictEqual(ids(L.orderNotes([undated('u'), old[0]], {})), ['x', 'u']);

  // --- move: append, prepend, midpoint, renumber on a tiny gap, unkeyed neighbours ---
  let k = L.moveNote({}, ['a', 'b', 'c'], 'c', 0, 10);
  assert.deepStrictEqual(Object.keys(k).sort(), ['a', 'b', 'c'], 'unkeyed neighbours: shown notes are renumbered once');
  assert.deepStrictEqual(ids(L.orderNotes(['a', 'b', 'c'].map((u) => note(u, '2024-01-01T00:00:00Z')), k)), ['c', 'a', 'b']);
  k = L.moveNote(k, ['c', 'a', 'b'], 'b', 1, 20);
  assert.ok(k.b.k > k.c.k && k.b.k < k.a.k, 'midpoint between neighbours');
  assert.strictEqual(k.b.t, 20);
  assert.strictEqual(k.a.t, 10, 'other notes keep their entry');
  k = L.moveNote(k, ['c', 'b', 'a'], 'c', 2, 30);
  assert.strictEqual(k.c.k, k.a.k + 1024, 'append = last + 1024');
  k = L.moveNote(k, ['b', 'a', 'c'], 'c', 0, 40);
  assert.strictEqual(k.c.k, k.b.k - 1024, 'prepend = first - 1024');
  const tight = { a: { k: 1, t: 1 }, b: { k: 1 + 1e-7, t: 1 }, c: { k: 5, t: 1 } };
  const spread = L.moveNote(tight, ['a', 'b', 'c'], 'c', 1, 50);
  assert.deepStrictEqual([spread.a.k, spread.c.k, spread.b.k], [1024, 2048, 3072], 'tiny gap: shown notes renumbered in steps of 1024');
  assert.deepStrictEqual(ids(L.orderNotes(['a', 'b', 'c'].map((u) => note(u, 'x')), spread)), ['a', 'c', 'b'], 'renumbered order is the requested one');
  assert.deepStrictEqual(Object.keys(L.moveNote({ gone: { k: 1, t: 1 }, a: { k: 2, t: 1 } }, ['a'], 'a', 0, 1, new Set(['a']))), ['a'], 'keys of notes that no longer exist are dropped');
  const many = {};
  for (let i = 0; i < 1005; i += 1) many[`n${i}`] = { k: i, t: i };
  assert.strictEqual(Object.keys(L.mergeNoteKeys(many, {})).length, L.MAX_NOTE_KEYS, 'capped at 1000 entries');

  // --- merge: both devices keep their change, no note disappears ---
  const dev1 = { a: { k: 500, t: 100 }, b: { k: 1500, t: 90 } };
  const dev2 = { a: { k: 900, t: 200 }, c: { k: 100, t: 95 } };
  const merged = L.mergeNoteKeys(dev1, dev2);
  assert.deepStrictEqual(merged, { a: { k: 900, t: 200 }, b: { k: 1500, t: 90 }, c: { k: 100, t: 95 } });
  assert.deepStrictEqual(L.mergeNoteKeys(dev1, dev2), L.mergeNoteKeys(dev2, dev1), 'merge is symmetric');
  const four = ['a', 'b', 'c', 'd'].map((u) => note(u, '2024-01-01T00:00:00Z'));
  assert.deepStrictEqual(ids(L.orderNotes(four, merged)).sort(), ['a', 'b', 'c', 'd'], 'every note is still listed');

  // --- list: "Own order" sort mode inside a label only ---
  const tagMap = new Map([['L', { uuid: 'L', content: { type: 'tag', note_keys: { b: { k: 1, t: 1 }, a: { k: 2, t: 1 } } } }]]);
  const base = { query: '', filter: 'all', tagMap, folderMap: new Map() };
  const listed = (opts) => ids(S.filterNotes(['a', 'b', 'c'].map((u, i) => note(u, `2024-01-0${i + 1}T00:00:00Z`, { updated_at: `2024-02-0${i + 1}T00:00:00Z` })), { ...base, ...opts }));
  assert.deepStrictEqual(listed({ tagId: 'L', sort: 'manual' }), ['b', 'a', 'c']);
  assert.deepStrictEqual(listed({ tagId: 'L', sort: 'updated' }), ['c', 'b', 'a'], 'other sort modes are unchanged');
  assert.deepStrictEqual(listed({ sort: 'manual' }), ['c', 'b', 'a'], 'no label: falls back to Recent');

  // --- store: reorder is saved in the label, never in the note, and syncs only as ciphertext ---
  await h.unlockFresh();
  h.resetServer();
  const label = NotesStore.createTag('SecretLabelName');
  const mk = (title) => {
    const uuid = NotesStore.newUuid();
    NotesStore.upsert(uuid, { ...NotesStore.defaultNote(), title, tags: [label] });
    return uuid;
  };
  const n1 = mk('one');
  const n2 = mk('two');
  const n3 = mk('three');
  const noteStamp = NotesStore.get(n2).content.updated_at;
  assert.strictEqual(NotesStore.get(label).content.note_keys, undefined, 'old label: no keys yet');
  assert.ok(NotesStore.moveNoteInLabel(label, [n1, n2, n3], n3, 0));
  assert.deepStrictEqual(Object.keys(NotesStore.get(label).content.note_keys).sort(), [n1, n2, n3].sort());
  assert.strictEqual(NotesStore.get(n2).content.updated_at, noteStamp, 'the note record is not touched');
  assert.strictEqual(NotesStore.moveNoteInLabel('missing', [n1], n1, 0), false);
  const shown = ids(L.orderNotes(NotesStore.listNotes().filter((n) => n.content.tags.includes(label)), NotesStore.get(label).content.note_keys));
  assert.strictEqual(shown[0], n3, 'the moved note is first after the store round trip');

  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(body);
    return items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  };
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  const wire = bodies.map((b) => JSON.stringify(b)).join('\n');
  assert.ok(wire.includes('ciphertext'));
  assert.ok(!wire.includes('note_keys'), 'no readable sort-key field on the wire');
  assert.ok(!/"k"\s*:/.test(wire) && !wire.includes('SecretLabelName'));
  const labelRow = bodies.flatMap((b) => b.items).find((r) => r.item_uuid === label);
  assert.ok(labelRow, 'the label was pushed');
  assert.deepStrictEqual(Object.keys((await h.decryptRow(labelRow)).note_keys).sort(), [n1, n2, n3].sort(), 'the keys are inside the ciphertext');

  // --- sync conflict: two devices reorder the same label ---
  const mine = NotesStore.get(label).content.note_keys;
  const theirContent = {
    ...NotesStore.get(label).content,
    note_keys: { [n1]: { k: 7000, t: Date.now() + 5000 }, [n2]: mine[n2] },
  };
  delete theirContent.__fv;
  const theirRow = await h.encryptedRow(label, theirContent, Date.now() + 5000, 2000, { rev: 9 });
  let repushed = null;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== label) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    if (row.base_rev !== 9) return { item_uuid: label, status: 'conflict', rev: 9, server_item: theirRow };
    repushed = row;
    return { item_uuid: label, status: 'ok', rev: 10 };
  });
  NotesStore.moveNoteInLabel(label, [n3, n1, n2], n2, 0);
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(repushed, 'the label was re-pushed on top of the server copy');
  const after = NotesStore.get(label).content.note_keys;
  assert.deepStrictEqual(Object.keys(after).sort(), [n1, n2, n3].sort(), 'no note lost from the order');
  assert.strictEqual(after[n1].k, 7000, 'the other device\'s reorder survived');
  assert.ok(after[n2].k < after[n3].k, 'this device\'s reorder survived');
  const repushedKeys = (await h.decryptRow(repushed)).note_keys;
  assert.deepStrictEqual(Object.keys(repushedKeys).sort(), [n1, n2, n3].sort());
  assert.strictEqual(repushedKeys[n1].k, 7000, 'the re-pushed ciphertext carries the merged keys');
  assert.ok(repushedKeys[n2].k < repushedKeys[n3].k);
  const live = NotesStore.listNotes().filter((n) => n.content.tags.includes(label));
  assert.strictEqual(L.orderNotes(live, after).length, 3, 'all notes are still listed');

  console.log('test_note_manual_order.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
