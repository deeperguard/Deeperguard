// Export -> import keeps the folder tree, the nested labels and which note sits
// where; a backup written before folders/nested labels existed still imports.
// The export rows are built like buildLocalBackup in app.js (persisted ciphertext).
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

async function exportRows() {
  const rows = [];
  for (const item of NotesStore.state.items.values()) {
    if (item.deleted) continue;
    const stored = h.idb.get(item.uuid);
    assert.ok(stored && stored.ciphertext, 'item is persisted before export');
    rows.push({
      item_uuid: item.uuid,
      content_version: 1,
      ciphertext: stored.ciphertext,
      content_hash: stored.content_hash,
      deleted: false,
      updated_at: item.updated_at,
    });
  }
  return { format: 'deeperguard-backup-v1', exported_at: new Date().toISOString(), items: rows };
}

function wipeVault() {
  NotesStore.state.items.clear();
  NotesStore.state.dirty.clear();
  h.idb.clear();
}

function structure() {
  const folders = NotesStore.listFolders().map((f) => [f.uuid, f.content.title, f.content.parent_id || '']).sort();
  const tags = NotesStore.listTags().map((t) => [t.uuid, t.content.name, t.content.parent_id || '', t.content.title]).sort();
  const notes = NotesStore.listNotes()
    .map((n) => [n.uuid, n.content.title, n.content.folder_id || '', [...(n.content.tags || [])].sort()])
    .sort();
  return { folders, tags, notes };
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // Vault with nested folders and nested labels.
  const work = NotesStore.createFolder('Werk');
  const clients = NotesStore.createFolder('Klanten', work);
  const privat = NotesStore.createFolder('Privé');
  const tWerk = NotesStore.createTag('Werk');
  const tProj = NotesStore.createTag('Projecten', tWerk);
  const tAcme = NotesStore.createTag('Acme', tProj);
  assert.ok(work && clients && privat && tWerk && tProj && tAcme);
  const mk = (title, folder, tags) => {
    const id = NotesStore.newUuid();
    NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, content: `body ${title}`, folder_id: folder, tags });
    return id;
  };
  mk('Offerte', clients, [tAcme]);
  mk('Plan', work, [tProj, tWerk]);
  mk('Dagboek', privat, []);
  mk('Los', '', [tWerk]);
  await NotesStore.flush();

  const before = structure();
  assert.strictEqual(before.folders.length, 3);
  assert.strictEqual(before.tags.length, 3);
  assert.strictEqual(before.notes.length, 4);

  const backup = await exportRows();

  // Restore into an empty vault.
  wipeVault();
  assert.strictEqual(NotesStore.listFolders().length, 0);
  const result = await NotesStore.importBackup(JSON.parse(JSON.stringify(backup)), true);
  assert.strictEqual(result.created, backup.items.length);
  assert.deepStrictEqual(structure(), before, 'folders, nested labels and note placement are equal');
  assert.strictEqual(NotesStore.get(tAcme).content.parent_id, tProj);
  assert.strictEqual(NotesStore.get(clients).content.parent_id, work);

  // Importing the same export again changes nothing.
  const again = await NotesStore.importBackup(JSON.parse(JSON.stringify(backup)), true);
  assert.strictEqual(again.created, 0);
  assert.strictEqual(again.updated, 0);
  assert.deepStrictEqual(structure(), before);

  // Old export: no folder items, notes without folder_id, flat labels without name/parent_id.
  wipeVault();
  const legacyTag = NotesStore.newUuid();
  const legacyNote = NotesStore.newUuid();
  const { folder_id: _f, ...oldNote } = NotesStore.defaultNote();
  const rows = [
    await h.encryptedRow(legacyTag, { type: 'tag', title: 'Oud label', color: '' }, 1000, 1000),
    await h.encryptedRow(legacyNote, { ...oldNote, title: 'Oude notitie', content: 'x', tags: [legacyTag] }, 1000, 1000),
  ];
  const old = await NotesStore.importBackup({ format: 'deeperguard-backup-v1', items: rows }, true);
  assert.strictEqual(old.created, 2);
  assert.strictEqual(NotesStore.listFolders().length, 0);
  assert.strictEqual(NotesStore.get(legacyNote).content.title, 'Oude notitie');
  assert.ok(!NotesStore.get(legacyNote).content.folder_id, 'no folder');
  assert.deepStrictEqual(NotesStore.get(legacyNote).content.tags, [legacyTag]);
  assert.strictEqual(NotesStore.listTags().length, 1);
  assert.strictEqual(NotesStore.listNotes().length, 1);
  // The old label is still usable as the parent of a new nested label.
  assert.ok(NotesStore.createTag('Kind', legacyTag));

  console.log('test_backup_folders_labels_roundtrip ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
