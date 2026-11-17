// Note templates (design M3): variable filling in local time, the own
// encrypted `template` type, list hiding, rename and delete, migration of
// legacy `is_template` notes, zero-knowledge push (no name, text or type in
// plaintext) and sync to a second session.
const assert = require('assert');
const h = require('./sync_harness');
const T = require('../app/static/js/templates.js');
const S = require('../app/static/js/search.js');

const { NotesStore } = h;

(async () => {
  // --- variables ---
  const now = new Date(2026, 2, 29, 9, 5, 7); // local time (DST switch day in EU)
  assert.strictEqual(T.fill('{{date}} {{time}} {{title}}', { title: 'Plan', now }), '2026-03-29 09:05 Plan');
  assert.strictEqual(T.fill('{{title}}', { title: '   ', now }), 'Untitled');
  assert.strictEqual(T.fill('{{date:DD-MM-YYYY}} {{time:HH:mm:ss}}', { now }), '29-03-2026 09:05:07');
  assert.strictEqual(T.fill('{{ date }}', { now }), '2026-03-29', 'spaces inside braces');
  assert.strictEqual(T.fill('{{foo}} {{title:x}}', { title: 'A', now }), '{{foo}} {{title:x}}', 'unknown stays as typed');
  assert.strictEqual(T.fill('\\{{date}} {{date}}', { now }), '{{date}} 2026-03-29', 'escaped stays literal');
  assert.strictEqual(T.fill('{{title}}', { title: '<b>{{date}}</b>', now }), '<b>{{date}}</b>', 'title is text, not re-expanded');
  const late = new Date(2026, 11, 31, 23, 59);
  assert.strictEqual(T.fill('{{date}} {{time}}', { now: late }), '2026-12-31 23:59', 'local, not UTC');

  // --- note from template: copy text/labels/folder, clear flags ---
  const made = T.noteFromTemplate({
    type: 'note', title: 'Meeting', is_template: true, template_title: '{{title}} {{date}}',
    content: 'At {{time}}', tags: ['t1', 'gone'], folder_id: 'f1', editor: 'markdown',
    pinned: true, starred: true, locked: true, revisions: [{ x: 1 }], attachments: ['a'],
  }, { title: 'Kickoff', now, base: { type: 'note' }, tagExists: (id) => id === 't1' });
  assert.strictEqual(made.title, 'Kickoff 2026-03-29');
  assert.strictEqual(made.content, 'At 09:05');
  assert.deepStrictEqual(made.tags, ['t1']);
  assert.strictEqual(made.folder_id, 'f1');
  assert.strictEqual(made.editor, 'markdown');
  for (const k of ['is_template', 'pinned', 'starred', 'locked']) assert.strictEqual(made[k], false, k);
  assert.deepStrictEqual(made.revisions, []);
  assert.deepStrictEqual(made.attachments, []);
  assert.ok(!('template_title' in made));

  // --- store: save as template, hidden from normal lists ---
  await h.unlockFresh();
  h.resetServer();
  const label = NotesStore.createTag('Meetings');
  const src = NotesStore.newUuid();
  NotesStore.upsert(src, { ...NotesStore.defaultNote(), title: 'Weekly sync SECRETNAME', content: 'Body SECRETBODY {{date}}', tags: [label] });
  const saved = T.saveAsTemplate(NotesStore, src);
  assert.ok(saved.id);
  const tpl = NotesStore.get(saved.id).content;
  assert.strictEqual(tpl.type, 'template');
  assert.strictEqual(tpl.title, 'Weekly sync SECRETNAME');
  assert.strictEqual(tpl.body, 'Body SECRETBODY {{date}}');
  assert.ok(!('is_template' in tpl) && !('content' in tpl), 'not a note');
  assert.deepStrictEqual(tpl.tags, [label], 'labels copied');
  assert.deepStrictEqual(T.listTemplates(NotesStore).map((n) => n.uuid), [saved.id]);

  const locked = NotesStore.newUuid();
  NotesStore.upsert(locked, { ...NotesStore.defaultNote(), title: 'Private', content: 'pin 1234', locked: true });
  assert.deepStrictEqual(T.saveAsTemplate(NotesStore, locked), { error: 'locked' }, 'protected note refused');
  assert.strictEqual(T.listTemplates(NotesStore).length, 1);

  const list = (filter, extra = {}) => S.filterNotes(NotesStore.listNotes(), { query: '', filter, tagMap: new Map(), folderMap: new Map(), sort: 'updated', ...extra }).map((n) => n.uuid);
  assert.ok(!list('all').includes(saved.id), 'hidden from All notes');
  assert.ok(!list('untagged').includes(saved.id));
  assert.ok(!list('all', { tagId: label }).includes(saved.id), 'hidden from label view');
  assert.ok(!list('all', { query: 'SECRETBODY' }).includes(saved.id), 'hidden from search');
  assert.ok(!NotesStore.listNotes().some((n) => n.uuid === saved.id), 'not a note at all');
  assert.strictEqual(NotesStore.noteCountForTag(label), 1, 'label count ignores templates');

  // --- zero-knowledge push ---
  const bodies = [];
  const pushed = new Map();
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    items.forEach((r) => pushed.set(r.item_uuid, r));
    return items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  };
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(pushed.has(saved.id), 'template is pushed like a note');
  const wire = bodies.join('\n');
  for (const secret of ['"template"', 'template_title', 'SECRETNAME', 'SECRETBODY', '{{date}}', 'Meetings']) {
    assert.ok(!wire.includes(secret), `plaintext leak: ${secret}`);
  }
  const row = pushed.get(saved.id);
  const keys = Object.keys(row);
  for (const k of keys) assert.ok(!/template|title|content|tags/.test(k) || k === 'content_version' || k === 'content_hash', `readable field ${k}`);
  const decrypted = await h.decryptRow(row);
  assert.strictEqual(decrypted.type, 'template', 'type lives inside the ciphertext');
  assert.strictEqual(decrypted.title, 'Weekly sync SECRETNAME', 'name lives inside the ciphertext');
  assert.strictEqual(decrypted.body, 'Body SECRETBODY {{date}}', 'text lives inside the ciphertext');

  // --- second session: pull the rows, template appears in the template list ---
  const rows = [...pushed.values()].map((r, i) => ({ ...r, synced_at: 1000 + i, updated_at: r.updated_at || 1000 + i }));
  NotesStore.state.items.clear();
  h.idb.clear();
  NotesStore.state.lastSync = 0;
  assert.strictEqual(T.listTemplates(NotesStore).length, 0);
  h.server.pullPages = [{ items: rows, has_more: false }];
  await NotesStore.sync({ full: true });
  await h.waitFor(() => T.listTemplates(NotesStore).length === 1, 'template pulled');
  const pulled = T.listTemplates(NotesStore)[0];
  assert.strictEqual(pulled.uuid, saved.id);
  assert.strictEqual(pulled.content.title, 'Weekly sync SECRETNAME');
  const dialog = T.createDialog({ store: NotesStore, now: () => now });
  assert.strictEqual(dialog.state.items[0].id, saved.id, 'second session dialog lists the synced template');
  dialog.setTitle('Q2');
  const newId = dialog.confirm();
  assert.strictEqual(NotesStore.get(newId).content.content, 'Body SECRETBODY 2026-03-29');
  assert.deepStrictEqual(NotesStore.get(newId).content.tags, [label]);
  assert.strictEqual(NotesStore.get(newId).content.type, 'note');

  // --- rename: new name and text are pushed encrypted only ---
  assert.deepStrictEqual(T.updateTemplate(NotesStore, saved.id, { title: '   ' }), { error: 'empty' }, 'empty name refused');
  assert.strictEqual(T.listTemplates(NotesStore)[0].content.title, 'Weekly sync SECRETNAME');
  assert.deepStrictEqual(T.updateTemplate(NotesStore, saved.id, { title: '  RENAMEDSECRET ' }), { ok: true });
  assert.strictEqual(NotesStore.get(saved.id).content.title, 'RENAMEDSECRET');
  assert.strictEqual(NotesStore.get(saved.id).content.body, 'Body SECRETBODY {{date}}', 'rename keeps the text');
  assert.deepStrictEqual(T.updateTemplate(NotesStore, saved.id, { title: 'RENAMEDSECRET', body: 'NEWBODYSECRET {{time}}' }), { ok: true });
  assert.strictEqual(NotesStore.get(saved.id).content.body, 'NEWBODYSECRET {{time}}');
  assert.deepStrictEqual(T.updateTemplate(NotesStore, saved.id, { title: 'RENAMEDSECRET' }), { ok: true }, 'same name twice is fine');
  assert.deepStrictEqual(T.updateTemplate(NotesStore, 'no-such-id', { title: 'X' }), { error: 'missing' });
  assert.deepStrictEqual(T.updateTemplate(NotesStore, newId, { title: 'X' }), { error: 'missing' }, 'a normal note is not a template');
  bodies.length = 0;
  pushed.clear();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(pushed.has(saved.id), 'rename is synced');
  for (const secret of ['RENAMEDSECRET', 'NEWBODYSECRET', '{{time}}', '"template"']) {
    assert.ok(!bodies.join('\n').includes(secret), `plaintext leak after rename: ${secret}`);
  }
  assert.strictEqual((await h.decryptRow(pushed.get(saved.id))).title, 'RENAMEDSECRET');

  // --- delete: tombstone, gone from list and dialog, notes made from it stay ---
  assert.deepStrictEqual(T.deleteTemplate(NotesStore, saved.id), { ok: true, trashed: false });
  assert.strictEqual(NotesStore.get(saved.id).deleted, true);
  assert.strictEqual(T.listTemplates(NotesStore).length, 0);
  assert.strictEqual(T.createDialog({ store: NotesStore }).state.items.length, T.BUILTINS.length);
  assert.strictEqual(T.createFromTemplate(NotesStore, saved.id), null, 'deleted template cannot be used');
  assert.deepStrictEqual(T.deleteTemplate(NotesStore, saved.id), { error: 'missing' }, 'second delete is a no-op');
  assert.ok(NotesStore.get(newId) && !NotesStore.get(newId).deleted, 'note made from it stays');
  bodies.length = 0;
  pushed.clear();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(pushed.get(saved.id)?.deleted, true, 'delete is pushed as a tombstone');
  assert.ok(!bodies.join('\n').includes('RENAMEDSECRET'), 'tombstone carries no readable name');

  // --- migration of legacy is_template notes ---
  const legacy = NotesStore.newUuid();
  NotesStore.upsert(legacy, { ...NotesStore.defaultNote(), title: 'Old one', content: 'Old {{title}}', tags: [label], is_template: true, template_title: 'Old {{date}}' });
  const legacyLocked = NotesStore.newUuid();
  NotesStore.upsert(legacyLocked, { ...NotesStore.defaultNote(), title: 'Old locked', content: 'pin', is_template: true, locked: true });
  const legacyTrashed = NotesStore.newUuid();
  NotesStore.upsert(legacyTrashed, { ...NotesStore.defaultNote(), title: 'Old trashed', content: 'x', is_template: true, trashed: true });
  assert.deepStrictEqual(T.listTemplates(NotesStore).map((n) => n.content.title), ['Old locked', 'Old one'], 'legacy templates listed before migration');
  assert.strictEqual(T.migrateLegacy(NotesStore), 1, 'only the plain legacy template is converted');
  assert.strictEqual(T.migrateLegacy(NotesStore), 0, 'idempotent');
  const migrated = NotesStore.get(legacy).content;
  assert.strictEqual(migrated.type, 'template');
  assert.strictEqual(migrated.title, 'Old one');
  assert.strictEqual(migrated.body, 'Old {{title}}', 'text unchanged');
  assert.strictEqual(migrated.template_title, 'Old {{date}}');
  assert.deepStrictEqual(migrated.tags, [label]);
  assert.ok(!NotesStore.listNotes().some((n) => n.uuid === legacy), 'no longer a note');
  assert.strictEqual(NotesStore.get(legacyLocked).content.type, 'note', 'protected legacy template keeps its gate');
  assert.strictEqual(NotesStore.get(legacyTrashed).content.type, 'note', 'trashed legacy template stays in Trash');
  assert.deepStrictEqual(T.listTemplates(NotesStore).map((n) => n.content.title), ['Old locked', 'Old one']);
  // Legacy template still in use: rename edits the note, delete moves it to Trash.
  assert.deepStrictEqual(T.updateTemplate(NotesStore, legacyLocked, { title: 'Old locked 2', body: 'changed' }), { ok: true });
  assert.strictEqual(NotesStore.get(legacyLocked).content.title, 'Old locked 2');
  assert.strictEqual(NotesStore.get(legacyLocked).content.content, 'pin', 'protected text is not edited here');
  assert.deepStrictEqual(T.deleteTemplate(NotesStore, legacyLocked), { ok: true, trashed: true });
  assert.strictEqual(NotesStore.get(legacyLocked).content.trashed, true);
  assert.deepStrictEqual(T.listTemplates(NotesStore).map((n) => n.content.title), ['Old one']);
  const fromMigrated = NotesStore.get(T.createFromTemplate(NotesStore, legacy, { title: 'Z', now })).content;
  assert.strictEqual(fromMigrated.content, 'Old Z');
  assert.strictEqual(fromMigrated.title, 'Old 2026-03-29');

  console.log('test_templates.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
