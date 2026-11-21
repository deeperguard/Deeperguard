// Drop planning for the sidebar label tree: reorder, nest, refuse cycles.
const assert = require('assert');
const L = require('../app/static/js/labels.js');
const T = require('../app/static/js/labeltree.js');

const rec = (uuid, content) => ({ uuid, content: { type: 'tag', color: '#111', ...content } });
const tree = () => L.indexOf([
  rec('a', { name: 'A', parent_id: '', order: 1024 }),
  rec('b', { name: 'B', parent_id: '', order: 2048 }),
  rec('c', { name: 'C', parent_id: '', order: 3072 }),
  rec('a1', { name: 'A1', parent_id: 'a', order: 1024 }),
]);
const apply = (byId, id, plan) => {
  const next = new Map(byId);
  for (const [k, order] of Object.entries(plan.orders)) {
    next.set(k, { ...next.get(k), order, ...(k === id ? { parent_id: plan.parent } : {}) });
  }
  return next;
};
const top = (byId) => T.childMap(byId).get('');

// before / after reorder with a midpoint order, a single changed record
let plan = T.dropPlan(tree(), 'c', 'b', 'before');
assert.strictEqual(plan.ok, true);
assert.strictEqual(plan.parent, '');
assert.deepStrictEqual(plan.orders, { c: 1536 });
assert.deepStrictEqual(top(apply(tree(), 'c', plan)), ['a', 'c', 'b']);
plan = T.dropPlan(tree(), 'a', 'c', 'after');
assert.deepStrictEqual(top(apply(tree(), 'a', plan)), ['b', 'c', 'a']);
plan = T.dropPlan(tree(), 'c', 'a', 'before');
assert.deepStrictEqual(top(apply(tree(), 'c', plan)), ['c', 'a', 'b']);

// dropping onto a label makes a last sub-label
plan = T.dropPlan(tree(), 'c', 'a', 'into');
assert.strictEqual(plan.parent, 'a');
assert.deepStrictEqual(T.childMap(apply(tree(), 'c', plan)).get('a'), ['a1', 'c']);
// between two sub-labels of another parent
plan = T.dropPlan(tree(), 'c', 'a1', 'before');
assert.strictEqual(plan.parent, 'a');
assert.deepStrictEqual(T.childMap(apply(tree(), 'c', plan)).get('a'), ['c', 'a1']);

// cycles and self drops are refused
assert.deepStrictEqual(T.dropPlan(tree(), 'a', 'a1', 'into'), { ok: false, error: 'cycle' });
assert.strictEqual(T.dropPlan(tree(), 'a', 'a1', 'before').error, 'cycle');
assert.strictEqual(T.dropPlan(tree(), 'a', 'a', 'into').ok, false);
assert.strictEqual(T.dropPlan(tree(), 'a', 'zzz', 'into').ok, false);

// no gap between neighbours / labels without order: siblings are renumbered
const tight = L.indexOf([
  rec('x', { name: 'X', parent_id: '', order: 1 }),
  rec('y', { name: 'Y', parent_id: '', order: 1 }),
  rec('z', { name: 'Z', parent_id: '', order: 5 }),
]);
plan = T.dropPlan(tight, 'z', 'y', 'before');
assert.deepStrictEqual(top(apply(tight, 'z', plan)), ['x', 'z', 'y']);
const legacy = L.indexOf([
  rec('p', { name: 'P', parent_id: '' }),
  rec('q', { name: 'Q', parent_id: '' }),
  rec('r', { name: 'R', parent_id: '' }),
]);
plan = T.dropPlan(legacy, 'r', 'p', 'before');
assert.deepStrictEqual(top(apply(legacy, 'r', plan)), ['r', 'p', 'q']);

// repeated drops into the same gap: the orders must not pick up long fractions
let cur = L.indexOf([
  rec('a', { name: 'A', parent_id: '', order: 1024 }),
  rec('b', { name: 'B', parent_id: '', order: 2048 }),
  rec('m', { name: 'M', parent_id: '', order: 3072 }),
  rec('n', { name: 'N', parent_id: '', order: 4096 }),
]);
let most = 0;
for (let i = 0; i < 60; i++) {
  const id = i % 2 ? 'n' : 'm';
  cur = apply(cur, id, T.dropPlan(cur, id, 'b', 'before'));
  for (const id2 of top(cur)) most = Math.max(most, (String(cur.get(id2).order).split('.')[1] || '').length);
}
assert.ok(most <= 1, `orders kept ${most} decimal places`);
assert.deepStrictEqual(top(cur), ['a', 'm', 'n', 'b']);

// Alt+Arrow step
assert.deepStrictEqual(T.siblingStep(tree(), 'b', -1), { target: 'a', zone: 'before' });
assert.deepStrictEqual(T.siblingStep(tree(), 'b', 1), { target: 'c', zone: 'after' });
assert.strictEqual(T.siblingStep(tree(), 'a', -1), null);
assert.strictEqual(T.siblingStep(tree(), 'c', 1), null);

// Alt+Right / Alt+Left step (indent / outdent)
assert.deepStrictEqual(T.levelStep(tree(), 'b', 1), { target: 'a', zone: 'into' });
assert.strictEqual(T.levelStep(tree(), 'a', 1), null);
assert.strictEqual(T.levelStep(tree(), 'b', -1), null);
assert.deepStrictEqual(T.levelStep(tree(), 'a1', -1), { target: 'a', zone: 'after' });
plan = T.dropPlan(tree(), 'a1', 'a', 'after');
assert.deepStrictEqual(top(apply(tree(), 'a1', plan)), ['a', 'a1', 'b', 'c']);
let step = T.levelStep(tree(), 'b', 1);
plan = T.dropPlan(tree(), 'b', step.target, step.zone);
assert.strictEqual(plan.parent, 'a');
assert.deepStrictEqual(T.childMap(apply(tree(), 'b', plan)).get('a'), ['a1', 'b']);

// planUpdate keeps an explicit order
const pu = L.planUpdate('c', { parent_id: 'a', order: 77 }, tree());
assert.strictEqual(pu.updates[0].content.order, 77);
console.log('ok');
