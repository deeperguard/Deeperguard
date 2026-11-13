// Label tree UI model (spec section 1): ARIA attributes, keyboard navigation,
// filter scope over sub-labels and expand-state persistence without label names.
const assert = require('assert');
const L = require('../app/static/js/labels.js');
const T = require('../app/static/js/labeltree.js');
const S = require('../app/static/js/search.js');

const rec = (uuid, content) => ({ uuid, content: { type: 'tag', color: '#111', ...content } });
const byId = L.indexOf([
  rec('w', { title: 'Work', name: 'Work', parent_id: '', order: 1 }),
  rec('p', { title: 'Work / Project A', name: 'Project A', parent_id: 'w', order: 1 }),
  rec('q', { title: 'Work / Project A / Specs', name: 'Specs', parent_id: 'p', order: 1 }),
  rec('h', { title: 'Home <b>', name: 'Home <b>', parent_id: '', order: 2 }),
]);
const ctx = (open, selected) => ({ open, selected, active: null, count: () => 1, color: () => '#111' });

// --- ARIA markup ---
const collapsed = T.html(byId, ctx(new Set(), null));
assert.ok(collapsed.includes('role="tree"'));
assert.ok(!collapsed.includes('Project A'), 'children of a collapsed label are not rendered');
assert.ok(/data-label="w"[^>]*aria-level="1"[^>]*aria-expanded="false"/.test(collapsed));
assert.ok(!/data-label="h"[^>]*aria-expanded/.test(collapsed), 'leaf has no aria-expanded');
assert.ok(collapsed.includes('Home &lt;b&gt;') && !collapsed.includes('<b>'), 'names are escaped');
const open = T.html(byId, ctx(new Set(['w', 'p']), 'q'));
assert.ok(/data-label="w"[^>]*aria-expanded="true"/.test(open));
assert.ok(/data-label="q"[^>]*aria-level="3"[^>]*aria-selected="true"/.test(open));
assert.ok(/data-label="p"[^>]*aria-level="2"[^>]*aria-selected="false"/.test(open));
assert.strictEqual((open.match(/role="group"/g) || []).length, 2);
assert.strictEqual((open.match(/role="treeitem"/g) || []).length, 4);
assert.strictEqual((open.match(/tabindex="0"/g) || []).length, 1, 'roving tabindex');

// --- keyboard navigation ---
let rows = T.visibleRows(byId, new Set());
assert.deepStrictEqual(rows.map((r) => r.uuid), ['w', 'h']);
assert.deepStrictEqual(T.navigate(rows, 'w', 'ArrowDown'), { focus: 'h' });
assert.deepStrictEqual(T.navigate(rows, 'h', 'ArrowDown'), { focus: 'h' }, 'stops at the end');
assert.deepStrictEqual(T.navigate(rows, 'w', 'ArrowUp'), { focus: 'w' });
assert.deepStrictEqual(T.navigate(rows, 'w', 'ArrowRight'), { expand: 'w' });
assert.deepStrictEqual(T.navigate(rows, 'h', 'ArrowRight'), {}, 'leaf: right does nothing');
assert.deepStrictEqual(T.navigate(rows, 'h', 'Home'), { focus: 'w' });
assert.deepStrictEqual(T.navigate(rows, 'w', 'End'), { focus: 'h' });
assert.deepStrictEqual(T.navigate(rows, 'w', 'Enter'), { select: 'w' });
rows = T.visibleRows(byId, new Set(['w']));
assert.deepStrictEqual(rows.map((r) => r.uuid), ['w', 'p', 'h']);
assert.deepStrictEqual(T.navigate(rows, 'w', 'ArrowRight'), { focus: 'p' }, 'open parent: right goes to first child');
assert.deepStrictEqual(T.navigate(rows, 'w', 'ArrowLeft'), { collapse: 'w' });
assert.deepStrictEqual(T.navigate(rows, 'p', 'ArrowLeft'), { focus: 'w' }, 'child: left goes to parent');
assert.deepStrictEqual(T.navigate(rows, 'p', 'ArrowDown'), { focus: 'h' });
assert.deepStrictEqual(T.navigate(rows, 'p', 'F2'), { rename: 'p' });
assert.deepStrictEqual(T.navigate(rows, 'p', 'ContextMenu'), { menu: 'p' });

// --- filtering on a parent includes sub-labels ---
assert.deepStrictEqual(T.scope('w', byId).sort(), ['p', 'q', 'w']);
assert.deepStrictEqual(T.scope('q', byId), ['q']);
const notes = [
  { uuid: 'n1', content: { type: 'note', title: 'a', content: 'x', tags: ['q'], updated_at: '1' } },
  { uuid: 'n2', content: { type: 'note', title: 'b', content: 'x', tags: ['h'], updated_at: '2' } },
  { uuid: 'n3', content: { type: 'note', title: 'c', content: 'x', tags: ['w'], updated_at: '3' } },
];
const run = (tagId, tagScope) => S.filterNotes(notes, {
  query: '', filter: 'all', tagId, tagScope, folderId: null, tagMap: new Map(), folderMap: new Map(), sort: 'updated',
}).map((n) => n.uuid).sort();
assert.deepStrictEqual(run('w', T.scope('w', byId)), ['n1', 'n3'], 'parent filter shows sub-label notes');
assert.deepStrictEqual(run('w'), ['n3'], 'without scope only the label itself');
assert.deepStrictEqual(run('q', T.scope('q', byId)), ['n1']);

// --- move targets: no self, no descendants, no too-deep ---
assert.deepStrictEqual(T.moveTargets('w', byId).sort(), ['h']);
assert.deepStrictEqual(T.moveTargets('q', byId).sort(), ['h', 'p', 'w']);

// --- expand state persists as ids only ---
const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
T.saveOpen(storage, new Set(['w', 'p']));
assert.deepStrictEqual([...T.loadOpen(storage)].sort(), ['p', 'w']);
const stored = JSON.stringify(mem);
for (const name of ['Work', 'Project A', 'Specs', 'Home']) assert.ok(!stored.includes(name), `label name stored: ${name}`);
assert.deepStrictEqual([...T.loadOpen({ getItem: () => 'garbage' })], []);

console.log('test_label_tree.js: ok');
