// Encrypted folder data model: create / rename / nest / delete, cycle refusal,
// legacy items without parent_id / folder_id, and the zero-knowledge wire check.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // --- create, nest, rename ---
  const work = NotesStore.createFolder('Zebrawerk');
  const clients = NotesStore.createFolder('Klantenmap', work);
  const acme = NotesStore.createFolder('Acme', clients);
  assert.ok(work && clients && acme);
  assert.strictEqual(NotesStore.get(clients).content.parent_id, work);
  assert.strictEqual(NotesStore.get(work).content.parent_id, '');
  assert.ok(NotesStore.get(clients).content.order > 0, 'order is set');
  assert.strictEqual(NotesStore.createFolder('Nope', 'unknown-uuid'), null, 'unknown parent refused');

  assert.strictEqual(NotesStore.renameFolder(acme, 'Acme BV'), true);
  assert.strictEqual(NotesStore.get(acme).content.title, 'Acme BV');
  assert.strictEqual(NotesStore.renameFolder(acme, '  '), false, 'empty name refused');

  // duplicate names: refused next to each other, allowed in another branch
  const other = NotesStore.createFolder('Privé');
  const b = NotesStore.createFolder('Beta', clients);
  assert.strictEqual(NotesStore.renameFolder(b, 'acme bv'), false);
  const b2 = NotesStore.createFolder('Beta', other);
  assert.strictEqual(NotesStore.moveFolder(b2, clients), false, 'duplicate name at the target refused');

  // --- cycles are refused ---
  assert.strictEqual(NotesStore.moveFolder(work, work), false, 'folder under itself');
  assert.strictEqual(NotesStore.moveFolder(work, acme), false, 'folder under its grandchild');
  assert.strictEqual(NotesStore.moveFolder(clients, acme), false, 'folder under its child');
  assert.strictEqual(NotesStore.get(work).content.parent_id, '', 'tree unchanged after refusal');
  assert.strictEqual(NotesStore.get(clients).content.parent_id, work);

  // --- move (valid) ---
  assert.strictEqual(NotesStore.moveFolder(acme, other), true);
  assert.strictEqual(NotesStore.get(acme).content.parent_id, other);
  assert.strictEqual(NotesStore.moveFolder(acme, ''), true, 'back to the root');
  assert.strictEqual(NotesStore.moveFolder(acme, other), true);

  // --- delete: notes go to the root, subfolders move up ---
  const note = NotesStore.newUuid();
  NotesStore.upsert(note, { ...NotesStore.defaultNote(), title: 'N', folder_id: clients });
  assert.strictEqual(NotesStore.deleteFolder(clients), true);
  assert.ok(!NotesStore.listFolders().some((f) => f.uuid === clients));
  assert.strictEqual(NotesStore.get(b).content.parent_id, work, 'subfolder moved to the parent');
  assert.strictEqual(NotesStore.get(note).content.folder_id, '');
  assert.ok(!NotesStore.get(note).deleted, 'note is kept');
  assert.strictEqual(NotesStore.deleteFolder(clients), false, 'second delete does nothing');

  // --- legacy items load as before ---
  const legacyFolder = NotesStore.newUuid();
  NotesStore.upsert(legacyFolder, { type: 'folder', title: 'Oud', created_at: 'c', updated_at: 'u' });
  const legacyNote = NotesStore.newUuid();
  const { folder_id: _drop, ...noFolderId } = NotesStore.defaultNote();
  NotesStore.upsert(legacyNote, { ...noFolderId, title: 'Oude notitie' });
  assert.ok(NotesStore.listFolders().some((f) => f.uuid === legacyFolder), 'legacy folder listed');
  assert.strictEqual(NotesStore.createFolder('Kind', legacyFolder) !== null, true, 'legacy folder is a valid parent');
  assert.strictEqual(NotesStore.moveFolder(legacyFolder, work), true);
  assert.strictEqual(NotesStore.get(legacyNote).content.folder_id, undefined);
  assert.ok(!NotesStore.notesInFolder(legacyFolder).some((n) => n.uuid === legacyNote));
  assert.strictEqual(NotesStore.defaultNote().folder_id, '');

  // --- zero-knowledge: names, parent_id and order are not readable in the push ---
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
  for (const secret of ['Zebrawerk', 'Klantenmap', 'Acme', 'Privé', 'Beta', 'Oud', 'parent_id', 'folder_id', '"order"', 'type":"folder']) {
    assert.ok(!wire.includes(secret), `plaintext leak: ${secret}`);
  }
  // The parent uuid must not appear either: only the item's own uuid is readable.
  const items = bodies.flatMap((x) => JSON.parse(x).items || []);
  const pushed = new Set(items.map((r) => r.item_uuid));
  assert.ok(pushed.has(work) && pushed.has(acme), 'folders were pushed');
  for (const r of items) {
    for (const [k, v] of Object.entries(r)) {
      if (k === 'item_uuid' || typeof v !== 'string') continue;
      assert.ok(!v.includes(work) && !v.includes(other), `parent uuid readable in ${k}`);
    }
    for (const k of Object.keys(r)) assert.ok(!['name', 'title', 'parent_id', 'order', 'folder_id'].includes(k), `readable field ${k}`);
  }

  console.log('test_folder_model.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
