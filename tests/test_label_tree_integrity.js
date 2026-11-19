// Label tree integrity: a move under an own sub-label is refused with a reason,
// a missing parent falls back to the top level, cycles found on load are repaired
// without losing labels or notes, and legacy labels without an order get one.
const assert = require('assert');
const h = require('./sync_harness');
const L = require('../app/static/js/labels.js');

const { NotesStore } = h;
const rec = (uuid, content) => ({ uuid, content: { type: 'tag', color: '#111', created_at: 'c', updated_at: 'u', ...content } });
const nested = (uuid, name, parent, extra) => rec(uuid, { title: name, name, parent_id: parent, title_sync: name, order: 1024, ...extra });
const applied = (records, updates) => {
  const map = new Map(records.map((r) => [r.uuid, r.content]));
  updates.forEach((u) => map.set(u.uuid, u.content));
  return map;
};
const asRecords = (map) => [...map].map(([uuid, content]) => ({ uuid, content }));
// Walks parent links; true when every label reaches the top level.
const allReachTop = (map) => [...map.keys()].every((id) => {
  const seen = new Set();
  for (let cur = id; cur; cur = map.get(cur).parent_id) {
    if (seen.has(cur) || !map.has(cur)) return false;
    seen.add(cur);
  }
  return true;
});

(async () => {
  // --- pure: every refusal has its own sentence ---
  const texts = ['cycle', 'unknown_parent', 'too_deep', 'duplicate', 'unknown_label'].map(L.moveErrorText);
  assert.strictEqual(new Set(texts).size, texts.length, 'one distinct message per reason');
  assert.match(L.moveErrorText('cycle'), /into itself or one of its own sub-labels/);
  assert.ok(L.moveErrorText('too_deep').includes(String(L.MAX_DEPTH)));

  // --- pure: repair of nothing, one label, and a healthy tree changes nothing ---
  assert.deepStrictEqual(L.repair([]), []);
  assert.deepStrictEqual(L.repair([nested('a', 'A', '')]), []);
  assert.deepStrictEqual(L.repair([nested('a', 'A', ''), nested('b', 'B', 'a', { title: 'A / B', title_sync: 'A / B' })]), []);

  // --- pure: self-parent, a three-label cycle with a tail, and a second cycle ---
  const tangled = [
    nested('self', 'Self', 'self'),
    nested('c1', 'C1', 'c3', { updated_at: '2026-01-03' }),
    nested('c2', 'C2', 'c1', { updated_at: '2026-01-01' }),
    nested('c3', 'C3', 'c2', { updated_at: '2026-01-02' }),
    nested('tail', 'Tail', 'c3'),
    nested('d1', 'D1', 'd2', { updated_at: '2026-02-01' }),
    nested('d2', 'D2', 'd1', { updated_at: '2026-02-01' }),
    nested('lost', 'Lost', 'no-such-label'),
    nested('fine', 'Fine', ''),
  ];
  const fixed = applied(tangled, L.repair(tangled));
  assert.deepStrictEqual([...fixed.keys()].sort(), tangled.map((r) => r.uuid).sort(), 'no label lost');
  assert.ok(allReachTop(fixed), 'no cycle left');
  assert.strictEqual(fixed.get('self').parent_id, '');
  assert.strictEqual(fixed.get('lost').parent_id, '', 'missing parent falls back to the top level');
  assert.strictEqual(fixed.get('c2').parent_id, '', 'oldest link of the cycle is cut');
  assert.strictEqual(fixed.get('c3').parent_id, 'c2', 'other links stay');
  assert.strictEqual(fixed.get('c1').parent_id, 'c3');
  assert.strictEqual(fixed.get('tail').parent_id, 'c3');
  assert.strictEqual(fixed.get('tail').title, 'C2 / C3 / Tail', 'compat title follows the repaired path');
  assert.strictEqual(fixed.get('d1').parent_id, '', 'same age: lower uuid is cut');
  assert.strictEqual(fixed.get('d2').parent_id, 'd1');
  assert.deepStrictEqual(fixed.get('fine'), tangled.find((r) => r.uuid === 'fine').content, 'healthy label untouched');
  for (const r of tangled) {
    assert.strictEqual(fixed.get(r.uuid).name, r.content.name);
    assert.strictEqual(fixed.get(r.uuid).color, r.content.color);
    assert.strictEqual(fixed.get(r.uuid).order, r.content.order);
  }
  assert.deepStrictEqual(L.repair(asRecords(fixed)), [], 'second repair changes nothing');

  // A parent that is deleted or not a label counts as missing.
  const odd = [
    nested('k1', 'K1', 'gone'),
    { ...nested('gone', 'Gone', ''), deleted: true },
    nested('k2', 'K2', 'note1'),
    { uuid: 'note1', content: { type: 'note', title: 'N' } },
  ];
  const oddFixed = applied(odd, L.repair(odd));
  assert.strictEqual(oddFixed.get('k1').parent_id, '');
  assert.strictEqual(oddFixed.get('k2').parent_id, '');
  assert.deepStrictEqual(oddFixed.get('note1'), { type: 'note', title: 'N' }, 'the note is not rewritten');

  // --- pure: legacy labels without name, parent or order ---
  const legacy = [
    rec('z', { title: 'Zeta' }),
    rec('m', { title: 'Mid', parent_id: 'vanished' }),
    rec('a', { title: 'Alpha', extra_unknown: 7 }),
    nested('n', 'New', '', { order: 4096 }),
  ];
  const migrated = applied(legacy, L.migrate(legacy));
  assert.deepStrictEqual(['a', 'm', 'z'].map((id) => migrated.get(id).order), [5120, 6144, 7168], 'alphabetical, after the existing labels');
  assert.strictEqual(migrated.get('n').order, 4096, 'label that already had an order keeps it');
  assert.strictEqual(migrated.get('a').extra_unknown, 7);
  assert.strictEqual(migrated.get('a').name, 'Alpha');
  const afterRepair = applied(asRecords(migrated), L.repair(asRecords(migrated)));
  assert.strictEqual(afterRepair.get('m').parent_id, '', 'legacy label with a missing parent ends at the top level');
  assert.strictEqual(afterRepair.get('m').order, 6144);
  assert.deepStrictEqual(L.migrate(asRecords(afterRepair)), [], 'migration is done once');

  // --- store: refused moves say why and change nothing ---
  await h.unlockFresh();
  h.resetServer();
  const work = NotesStore.createTag('Work');
  const proj = NotesStore.createTag('Projects', work);
  const alpha = NotesStore.createTag('Alpha', proj);
  const snapshot = () => JSON.stringify(NotesStore.listTags().map((t) => [t.uuid, t.content]).sort());
  const before = snapshot();
  for (let i = 0; i < 2; i += 1) {
    assert.deepStrictEqual(NotesStore.moveTagResult(work, alpha), { ok: false, error: 'cycle' }, 'under a grandchild');
    assert.deepStrictEqual(NotesStore.moveTagResult(work, proj), { ok: false, error: 'cycle' }, 'under a child');
    assert.deepStrictEqual(NotesStore.moveTagResult(work, work), { ok: false, error: 'cycle' }, 'under itself');
  }
  assert.strictEqual(NotesStore.moveTag(work, proj), false);
  const missing = NotesStore.newUuid();
  assert.deepStrictEqual(NotesStore.moveTagResult(alpha, missing), { ok: false, error: 'unknown_parent' });
  assert.deepStrictEqual(NotesStore.moveTagResult(missing, work), { ok: false, error: 'unknown_label' });
  assert.strictEqual(NotesStore.createTag('Orphan', missing), null, 'no new label under a missing parent');
  assert.strictEqual(snapshot(), before, 'refused moves write nothing');
  assert.deepStrictEqual(NotesStore.moveTagResult(alpha, work), { ok: true });
  assert.strictEqual(NotesStore.get(alpha).content.parent_id, work);
  assert.strictEqual(NotesStore.get(alpha).content.title, 'Work / Alpha');

  // --- store: a cycle and an orphan that arrived through sync are repaired on load ---
  const raw = (uuid, patch) => NotesStore.upsert(uuid, { ...NotesStore.get(uuid).content, ...patch });
  raw(work, { parent_id: alpha });
  raw(proj, { parent_id: missing });
  const oldLabel = NotesStore.newUuid();
  NotesStore.upsert(oldLabel, { ...NotesStore.defaultTag('Legacy'), color: '#abcdef' });
  const n1 = NotesStore.newUuid();
  const n2 = NotesStore.newUuid();
  NotesStore.upsert(n1, { ...NotesStore.defaultNote(), title: 'One', tags: [work, alpha] });
  NotesStore.upsert(n2, { ...NotesStore.defaultNote(), title: 'Two', tags: [proj, oldLabel] });
  const labelIds = NotesStore.listTags().map((t) => t.uuid).sort();
  const noteIds = NotesStore.listNotes().map((n) => n.uuid).sort();

  assert.strictEqual(NotesStore.migrateLabels(), 1);
  assert.ok(NotesStore.repairLabels() > 0);
  const tree = new Map(NotesStore.listTags().map((t) => [t.uuid, t.content]));
  assert.deepStrictEqual([...tree.keys()].sort(), labelIds, 'all labels still there');
  assert.deepStrictEqual(NotesStore.listNotes().map((n) => n.uuid).sort(), noteIds, 'all notes still there');
  assert.deepStrictEqual(NotesStore.get(n1).content.tags, [work, alpha], 'notes keep their labels');
  assert.deepStrictEqual(NotesStore.get(n2).content.tags, [proj, oldLabel]);
  assert.ok(allReachTop(tree), 'cycle gone');
  const links = [tree.get(work).parent_id, tree.get(alpha).parent_id];
  assert.ok(links[0] === '' ? links[1] === work : links[0] === alpha && links[1] === '', 'exactly one link of the cycle is cut');
  assert.strictEqual(tree.get(proj).parent_id, '');
  assert.strictEqual(typeof tree.get(oldLabel).order, 'number', 'legacy label got an order');
  assert.strictEqual(tree.get(oldLabel).color, '#abcdef');
  assert.strictEqual(NotesStore.repairLabels(), 0, 'nothing left to repair');
  assert.strictEqual(NotesStore.migrateLabels(), 0);
  const [top, child] = links[0] === '' ? [work, alpha] : [alpha, work];
  assert.deepStrictEqual(NotesStore.moveTagResult(top, child), { ok: false, error: 'cycle' }, 'still guarded after repair');

  console.log('test_label_tree_integrity.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
