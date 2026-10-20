const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
global.navigator = { onLine: true };
global.localStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.sessionStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.NotesIDB = {
  async putItem() {},
  async deleteItem() {},
  async getItem() { return null; },
  async putBlob() {},
  async getBlob() { return ''; },
  async deleteBlob() {},
  async getMeta() { return null; },
  async putMeta() {},
  async loadItems() { return []; },
  async iterateItems() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });

const NotesSearch = require('../app/static/js/search.js');
global.NotesSearch = NotesSearch;
const NotesHistory = require('../app/static/js/note-history.js');
const NotesStore = require('../app/static/js/store.js');

const rows = NotesHistory.revisionRows({
  content: {
    revisions: [
      null,
      'bad',
      4,
      { at: 'not-a-date', title: 'Broken date', content: 'x' },
      { at: '2020-01-02T00:00:00.000Z', title: 'Older', content: 'older body' },
    ],
  },
});
assert.strictEqual(rows.length, 2);
rows.forEach((rev) => {
  assert.strictEqual(typeof rev, 'object');
  assert.ok(rev);
  const when = NotesHistory.revisionTimestamp(rev);
  assert.ok(when === 0 || when > 0);
});
// Newest-first: dated revision before undated.
assert.ok(NotesHistory.revisionTimestamp(rows[0]) > 0);
assert.strictEqual(NotesHistory.revisionTimestamp(rows[1]), 0);
assert.deepStrictEqual(NotesHistory.revisionRows(null), []);
assert.deepStrictEqual(NotesHistory.revisionRows({ content: { revisions: 'nope' } }), []);
assert.strictEqual(NotesHistory.shouldFlushOnOpen(false), true);
assert.strictEqual(NotesHistory.shouldFlushOnOpen(true), false);

const noteForLabels = {
  content: { title: 'Current note', content: 'live body', title_manual: false },
};
assert.strictEqual(
  NotesHistory.revisionLabel({ title: '', content: 'First line\nmore' }, noteForLabels),
  'First line',
);
// Never fall back to the live note title after a rename.
assert.doesNotMatch(
  NotesHistory.revisionLabel({ title: 'Title', content: '' }, noteForLabels),
  /Current note/,
);
assert.strictEqual(
  NotesHistory.revisionLabel({ at: '2024-06-01T12:30:00.000Z', title: 'Title', content: '' }, noteForLabels),
  'Untitled',
);
assert.strictEqual(
  NotesHistory.revisionLabel({ at: '2024-06-01T12:30:00.000Z', title: '', content: '' }, noteForLabels),
  'Untitled',
);
assert.strictEqual(
  NotesHistory.revisionLabel({ title: 'Saved snapshot', content: '' }, noteForLabels),
  'Saved snapshot',
);
assert.strictEqual(
  NotesHistory.revisionLabel({ title: 'Zebrafish renamed', content: 'old body' }, noteForLabels),
  'Zebrafish renamed',
);
const renamedRows = NotesHistory.revisionRows({
  content: {
    title: 'MD table test',
    revisions: [
      { at: '2024-01-01T00:00:00.000Z', title: 'Zebrafish renamed', content: 'v1' },
      { at: '2024-01-03T00:00:00.000Z', title: 'MD table test', content: 'v3' },
      { at: '2024-01-02T00:00:00.000Z', title: 'MD table test', content: 'v2' },
    ],
  },
});
assert.strictEqual(renamedRows[0].content, 'v3');
assert.strictEqual(NotesHistory.revisionLabel(renamedRows[2]), 'Zebrafish renamed');

const id = NotesStore.newUuid();
const payload = NotesStore.defaultNote();
payload.title = 'Current';
payload.content = 'saved body';
payload.revisions = [
  null,
  'nope',
  { at: '2020-01-01T00:00:00.000Z', title: 'Older', content: 'older body' },
];
NotesStore.upsert(id, payload);

const editor = { title: 'Current', content: 'unsaved keystrokes' };
if (NotesHistory.shouldFlushOnOpen(false)) {
  const live = NotesStore.get(id);
  NotesStore.upsert(id, { ...live.content, title: editor.title, content: editor.content });
}
const rev = NotesHistory.revisionRows(NotesStore.get(id))[0];
NotesStore.restoreRevision(id, rev);
if (NotesHistory.shouldFlushOnOpen(true)) {
  const after = NotesStore.get(id);
  NotesStore.upsert(id, { ...after.content, title: editor.title, content: editor.content });
}
const kept = NotesStore.get(id);
assert.strictEqual(kept.content.title, 'Older');
assert.strictEqual(kept.content.content, 'older body');
const snapshot = NotesHistory.revisionRows(kept)[0];
assert.strictEqual(snapshot.title, 'Current');
assert.strictEqual(snapshot.content, 'unsaved keystrokes');

const burstId = NotesStore.newUuid();
const burst = NotesStore.defaultNote();
burst.title = 'Burst';
burst.content = 'one';
NotesStore.upsert(burstId, burst);
NotesStore.upsert(burstId, { ...NotesStore.get(burstId).content, content: 'two' }, { recordRevision: true });
NotesStore.upsert(burstId, { ...NotesStore.get(burstId).content, content: 'three' }, { recordRevision: true });
const burstRows = NotesHistory.revisionRows(NotesStore.get(burstId));
assert.strictEqual(burstRows.length, 2);
assert.strictEqual(burstRows[0].content, 'two');
assert.strictEqual(burstRows[1].content, 'one');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const restoreAt = appJs.indexOf('NotesStore.restoreRevision(currentId, rev)');
assert.ok(restoreAt > 0);
const handler = appJs.slice(restoreAt - 280, restoreAt + 160);
assert.ok(handler.indexOf('flushSave()') >= 0 && handler.indexOf('flushSave()') < handler.indexOf('restoreRevision'));
assert.ok(handler.includes('openNote(currentId, { skipFlush: true })'));

const openFn = appJs.slice(
  appJs.indexOf('function openNote(id, { skipGate = false, skipFlush = false } = {})'),
  appJs.indexOf('function updateActionButtons(note)'),
);
const gateAt = openFn.indexOf('NotesHistory.shouldFlushOnOpen(skipFlush)');
const flushAt = openFn.indexOf('flushSave()');
assert.ok(gateAt >= 0 && flushAt > gateAt);
assert.ok(openFn.includes('renderHistory(note)'));

const historyFn = appJs.slice(appJs.indexOf('function renderHistory(note)'), appJs.indexOf('function noteHasDocs(noteId)'));
assert.ok(historyFn.includes('NotesHistory.revisionRows(note)'));
assert.ok(historyFn.includes('revisionLabel'));
assert.ok(historyFn.includes('catch (err)'));
assert.ok(!historyFn.includes('if (!revisions.length)') || historyFn.indexOf('revisionRows') < historyFn.indexOf('if (!revisions.length)'));

const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');
const historySrc = html.indexOf('/static/js/note-history.js');
const appSrc = html.indexOf('/static/js/app.js');
assert.ok(historySrc > 0 && historySrc < appSrc);

console.log('ok');
