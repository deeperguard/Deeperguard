/**
 * Backlink index + "Linked from" panel: build, incremental edit/delete,
 * store-hook -> flush -> panel wiring with a stubbed NotesStore and DOM,
 * keyboard use, clear on lock, and no storage writes at all.
 */
const assert = require('assert');
const { install } = require('./domstub');

const { document } = install();
const Proto = global.Element.prototype;
if (!Proto.setAttribute) {
  Proto.setAttribute = function setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); };
  Proto.getAttribute = function getAttribute(k) { return (this.attrs || {})[k] ?? null; };
}

// Storage spies: any access to persistent storage fails the test.
const touches = [];
const spyStorage = (name) => new Proxy({}, { get(_, k) { touches.push(`${name}.${String(k)}`); return () => null; } });
global.localStorage = spyStorage('localStorage');
global.sessionStorage = spyStorage('sessionStorage');
global.indexedDB = spyStorage('indexedDB');
global.NotesIDB = spyStorage('NotesIDB');
global.caches = spyStorage('caches');

const B = require('../app/static/js/backlinks.js');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

const note = (uuid, title, content, extra = {}) => ({ uuid, deleted: false, content: { type: 'note', title, content, ...extra } });

// Stubbed NotesStore with the onItemChanged hook the real store exposes.
function makeStore() {
  const items = new Map();
  const listeners = new Set();
  let unlocked = true;
  return {
    items,
    listNotes: () => [...items.values()].filter((i) => !i.deleted && i.content.type === 'note'),
    get: (id) => items.get(id) || null,
    isUnlocked: () => unlocked,
    onItemChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    upsert(id, item) { items.set(id, item); listeners.forEach((fn) => fn(id)); },
    remove(id) { const it = items.get(id); it.deleted = true; listeners.forEach((fn) => fn(id)); },
    fireAll() { listeners.forEach((fn) => fn(null)); },
    lock() { unlocked = false; items.clear(); B.clear(); },
  };
}

const texts = (el) => {
  const out = [];
  const walk = (n) => { if (n.textContent) out.push(n.textContent); (n.children || []).forEach(walk); };
  walk(el);
  return out.join(' | ');
};
const buttons = (el) => el.querySelectorAll('button');

(async () => {
  // --- pure index ---
  const store = makeStore();
  store.items.set(A, note(A, 'Target', 'I am the target'));
  store.items.set(S1, note(S1, 'Plan', `Before text. See [Target](dg-note:${A}) for details. After.`));
  store.items.set(S2, note(S2, 'Code only', `\`\`\`\n[Target](dg-note:${A})\n\`\`\``));
  store.items.set(S3, note(S3, 'Other', 'no links'));

  const changes = [];
  const panel = document.createElement('section');
  const opened = [];
  const ctl = B.connect({
    store,
    debounceMs: 5,
    titleOf: (it) => it.content.title,
    onChange: (touched) => {
      changes.push(touched);
      if (!touched || touched.has(A)) ctl.render(panel, A, (id) => opened.push(id), document);
    },
  });

  ctl.render(panel, A, (id) => opened.push(id), document);
  assert.ok(texts(panel).includes('Indexing links'), 'shows indexing state before build');
  assert.strictEqual(panel.getAttribute('aria-busy'), 'true');

  await ctl.ensureBuilt();
  assert.strictEqual(B.status, 'ready');
  assert.deepStrictEqual(B.linksTo(A).map((r) => r.sourceUuid), [S1], 'links in code are ignored');
  assert.ok(texts(panel).includes('Linked from (1)'), texts(panel));
  assert.ok(texts(panel).includes('Plan'));
  assert.ok(/See Target for details/.test(texts(panel)), 'snippet shows context around the link');

  // Click and keyboard open the source note.
  const [btn] = buttons(panel);
  assert.strictEqual(btn.tagName, 'BUTTON', 'native button: Enter/Space work');
  btn.listeners.click[0]();
  assert.deepStrictEqual(opened, [S1]);

  // --- store hook -> flush -> panel updates: new source ---
  store.upsert(S3, note(S3, 'Other', `Now links [x](dg-note:${A})`));
  await ctl.flush();
  assert.ok(texts(panel).includes('Linked from (2)'), 'edit adding a link updates panel');
  const btns = buttons(panel);
  let focused = null;
  btns.forEach((b) => { b.focus = () => { focused = b; }; });
  btns[0].listeners.keydown[0]({ key: 'ArrowDown', preventDefault() {} });
  assert.strictEqual(focused, btns[1], 'ArrowDown moves to next backlink');

  // Debounced path also flushes by itself.
  store.upsert(S1, note(S1, 'Plan', 'link removed'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(texts(panel).includes('Linked from (1)'), 'edit removing a link updates panel');
  assert.ok(!texts(panel).includes('Plan'));

  // Rename of a source (body unchanged) refreshes the title in the panel.
  store.upsert(S3, note(S3, 'Renamed', `Now links [x](dg-note:${A})`));
  await ctl.flush();
  assert.ok(texts(panel).includes('Renamed'));

  // Delete the source.
  store.remove(S3);
  await ctl.flush();
  assert.deepStrictEqual(B.linksTo(A), []);
  assert.ok(texts(panel).includes('Linked from (0)') && texts(panel).includes('No notes link here yet'));

  // Trashed sources are flagged and hidden.
  store.upsert(S1, note(S1, 'Plan', `[T](dg-note:${A})`, { trashed: true }));
  await ctl.flush();
  assert.strictEqual(B.linksTo(A)[0].trashed, true);
  assert.ok(texts(panel).includes('Linked from (0)'));

  // Rebuild request (null, as the store sends after the first pull) re-scans
  // everything, including items that changed without a per-item event.
  store.items.set(S2, note(S2, 'Fresh', `[T](dg-note:${A})`));
  store.fireAll();
  await ctl.flush();
  assert.deepStrictEqual(B.linksTo(A).map((r) => r.sourceUuid).sort(), [S1, S2].sort());

  // Property: incremental state equals a from-scratch build after random edits.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ids = [A, S1, S2, S3];
  for (let i = 0; i < 200; i += 1) {
    const id = ids[Math.floor(rnd() * ids.length)];
    if (rnd() < 0.2) {
      if (store.items.has(id)) store.remove(id);
    } else {
      const to = ids[Math.floor(rnd() * ids.length)];
      store.upsert(id, note(id, `t${i}`, rnd() < 0.5 ? `x [l](dg-note:${to}) y` : 'plain'));
    }
    if (rnd() < 0.3) await ctl.flush();
  }
  await ctl.flush();
  const snapshot = () => ids.map((t) => B.linksTo(t).map((r) => `${r.sourceUuid}:${r.count}`).sort().join(','));
  const incremental = snapshot();
  B.clear();
  await ctl.ensureBuilt();
  assert.deepStrictEqual(incremental, snapshot(), 'incremental index equals full rebuild');

  // --- lock clears the index and the panel ---
  assert.ok(B.stats().scanned > 0);
  store.lock();
  assert.deepStrictEqual(B.stats(), { sources: 0, targets: 0, scanned: 0, status: 'idle' });
  assert.deepStrictEqual(B.linksTo(A), []);
  assert.strictEqual(changes[changes.length - 1], null, 'panel told to reset on lock');
  // No build while locked.
  await ctl.ensureBuilt();
  assert.strictEqual(B.status, 'idle');

  // The index never touched persistent storage.
  assert.deepStrictEqual(touches, [], `storage touched: ${touches.join(', ')}`);
  ctl.disconnect();
  console.log('backlinks: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
