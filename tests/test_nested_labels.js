// Nested labels (docs/NOTES_ORGANIZATION_SPEC.md section 1): migration, cycles,
// depth, rename, delete, old-client behaviour and the zero-knowledge wire check.
const assert = require('assert');
const h = require('./sync_harness');
const L = require('../app/static/js/labels.js');

const { NotesStore } = h;
const rec = (uuid, content) => ({ uuid, content: { type: 'tag', color: '#111', created_at: 'c', updated_at: 'u', ...content } });
const apply = (map, updates) => updates.forEach((u) => map.set(u.uuid, u.content));

(async () => {
  // --- pure: migration is lossless and idempotent ---
  const legacy = [
    rec('b', { title: 'Beta', extra_unknown: 7 }),
    rec('a', { title: 'Alpha' }),
    rec('c', { title: 'Work/Misc' }),
  ];
  const migrated = L.migrate(legacy);
  assert.strictEqual(migrated.length, 3);
  for (const u of migrated) {
    const before = legacy.find((r) => r.uuid === u.uuid).content;
    for (const k of Object.keys(before)) assert.deepStrictEqual(u.content[k], before[k], `field ${k} kept`);
    assert.strictEqual(u.content.name, before.title);
    assert.strictEqual(u.content.parent_id, '');
    assert.strictEqual(u.content.title_sync, before.title);
  }
  assert.strictEqual(migrated.find((u) => u.uuid === 'c').content.name, 'Work/Misc', 'legacy slash names are not split');
  assert.deepStrictEqual(L.migrate(migrated), [], 'second migration changes nothing');
  assert.deepStrictEqual(L.repair(migrated), [], 'repair of a healthy tree is a no-op');

  // --- cycles, depth, names ---
  const t = L.indexOf([
    rec('r', { title: 'R', name: 'R', parent_id: '' }),
    rec('s', { title: 'R / S', name: 'S', parent_id: 'r' }),
    rec('u', { title: 'R / S / U', name: 'U', parent_id: 's' }),
  ]);
  assert.strictEqual(L.validateParent('r', 'u', t).error, 'cycle');
  assert.strictEqual(L.validateParent('r', 'r', t).error, 'cycle');
  assert.strictEqual(L.validateParent('s', 'u', t).error, 'cycle');
  assert.strictEqual(L.validateParent('u', 'r', t).ok, true);
  assert.strictEqual(L.validateParent(null, 'nope', t).error, 'unknown_parent');
  assert.strictEqual(L.planUpdate('r', { parent_id: 'u' }, t).error, 'cycle');

  const deep = [rec('d1', { title: 'n1', name: 'n1', parent_id: '' })];
  for (let i = 2; i <= L.MAX_DEPTH; i += 1) {
    deep.push(rec(`d${i}`, { title: `n${i}`, name: `n${i}`, parent_id: `d${i - 1}` }));
  }
  const dm = L.indexOf(deep);
  assert.strictEqual(L.depthOf(`d${L.MAX_DEPTH}`, dm), L.MAX_DEPTH);
  assert.strictEqual(L.validateParent(null, `d${L.MAX_DEPTH}`, dm).error, 'too_deep');
  assert.strictEqual(L.validateParent(null, `d${L.MAX_DEPTH - 1}`, dm).ok, true);
  const extra = new Map(dm);
  extra.set('x', { type: 'tag', name: 'x', title: 'x', parent_id: '' });
  assert.strictEqual(L.validateParent('x', `d${L.MAX_DEPTH - 1}`, extra).ok, true);
  extra.set('x2', { type: 'tag', name: 'x2', title: 'x2', parent_id: 'x' });
  assert.strictEqual(L.validateParent('x', `d${L.MAX_DEPTH - 1}`, extra).error, 'too_deep', 'subtree height counts');
  assert.strictEqual(L.validateName('a/b').error, 'slash');
  assert.strictEqual(L.validateName('  ').error, 'empty');
  assert.strictEqual(L.validateName('x'.repeat(65)).error, 'too_long');

  // --- repair: orphan, cycle from two devices, old-client rename ---
  const broken = [
    rec('o', { title: 'Gone / O', name: 'O', parent_id: 'missing', title_sync: 'Gone / O' }),
    rec('p', { title: 'P', name: 'P', parent_id: 'q', title_sync: 'P', updated_at: '1' }),
    rec('q', { title: 'P / Q', name: 'Q', parent_id: 'p', title_sync: 'P / Q', updated_at: '2' }),
    rec('n', { title: 'Renamed by old', name: 'Old', parent_id: '', title_sync: 'Old' }),
  ];
  const fixed = new Map(broken.map((r) => [r.uuid, r.content]));
  apply(fixed, L.repair(broken));
  assert.strictEqual(fixed.get('o').parent_id, '');
  assert.strictEqual(fixed.get('o').title, 'O');
  assert.strictEqual(fixed.get('p').parent_id, '', 'oldest link becomes root');
  assert.strictEqual(fixed.get('q').parent_id, 'p');
  assert.strictEqual(fixed.get('q').title, 'P / Q');
  assert.strictEqual(fixed.get('n').name, 'Renamed by old');
  assert.deepStrictEqual(L.repair([...fixed].map(([uuid, content]) => ({ uuid, content }))), [], 'repair idempotent');

  // --- store: create / rename / move / delete ---
  await h.unlockFresh();
  h.resetServer();
  const work = NotesStore.createTag('Work');
  const proj = NotesStore.createTag('Projects', work);
  const alpha = NotesStore.createTag('Alpha', proj);
  assert.ok(work && proj && alpha);
  assert.strictEqual(NotesStore.createTag('alpha', proj), null, 'case-insensitive sibling duplicate');
  assert.strictEqual(NotesStore.get(alpha).content.title, 'Work / Projects / Alpha');
  assert.strictEqual(NotesStore.moveTag(work, alpha), false, 'cycle refused');
  assert.strictEqual(NotesStore.get(work).content.parent_id, '');

  assert.strictEqual(NotesStore.renameTag(work, 'Job'), true);
  assert.strictEqual(NotesStore.get(alpha).content.title, 'Job / Projects / Alpha', 'descendant titles follow');
  assert.strictEqual(NotesStore.renameTag(work, 'a/b'), false);

  const old = NotesStore.newUuid();
  NotesStore.upsert(old, { ...NotesStore.defaultTag('Legacy'), color: '#abcdef' });
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'N', tags: [old, alpha, proj] });
  assert.strictEqual(NotesStore.get(old).content.name, undefined);
  assert.strictEqual(NotesStore.migrateLabels(), 1);
  assert.strictEqual(NotesStore.get(old).content.name, 'Legacy');
  assert.strictEqual(NotesStore.get(old).content.title, 'Legacy');
  assert.strictEqual(NotesStore.get(old).content.color, '#abcdef');
  assert.strictEqual(NotesStore.migrateLabels(), 0, 'idempotent in the store too');
  assert.deepStrictEqual(NotesStore.get(noteId).content.tags, [old, alpha, proj], 'note references untouched');

  // delete a parent: children move up (default)
  NotesStore.deleteTag(proj);
  assert.ok(!NotesStore.listTags().some((x) => x.uuid === proj));
  assert.strictEqual(NotesStore.get(alpha).content.parent_id, work);
  assert.strictEqual(NotesStore.get(alpha).content.title, 'Job / Alpha');
  assert.deepStrictEqual(NotesStore.get(noteId).content.tags, [old, alpha]);
  assert.ok(NotesStore.get(noteId) && !NotesStore.get(noteId).deleted, 'note itself is kept');

  // delete a parent together with its children
  const sub = NotesStore.createTag('Sub', alpha);
  NotesStore.deleteTag(work, { children: 'delete' });
  const left = NotesStore.listTags().map((x) => x.uuid);
  assert.ok(!left.includes(work) && !left.includes(alpha) && !left.includes(sub));
  assert.ok(left.includes(old));
  assert.deepStrictEqual(NotesStore.get(noteId).content.tags, [old]);

  // same leaf name under different parents is not a duplicate
  const p1 = NotesStore.createTag('Pone');
  const p2 = NotesStore.createTag('Ptwo');
  NotesStore.createTag('Same', p1);
  NotesStore.createTag('Same', p2);
  assert.strictEqual(NotesStore.mergeDuplicateTags(), 0);

  // --- zero-knowledge: no label names or hierarchy fields in the push request ---
  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    return items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  };
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(bodies.length > 0, 'something was pushed');
  const wire = bodies.join('\n');
  assert.ok(wire.includes('ciphertext'));
  for (const secret of ['Pone', 'Ptwo', 'Same', 'Legacy', 'Projects', 'Alpha', 'Job', 'parent_id', 'title_sync']) {
    assert.ok(!wire.includes(secret), `plaintext leak: ${secret}`);
  }
  const keys = new Set();
  bodies.forEach((b) => (JSON.parse(b).items || []).forEach((r) => Object.keys(r).forEach((k) => keys.add(k))));
  for (const k of keys) assert.ok(!['name', 'title', 'parent_id', 'order', 'tags'].includes(k), `readable field ${k}`);

  console.log('test_nested_labels.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
