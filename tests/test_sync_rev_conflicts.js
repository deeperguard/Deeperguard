// Regression: two devices editing the same note were resolved by comparing
// client clocks (last-writer-wins) and the loser vanished without a trace. The
// server now keeps a per-item revision; pushes name the revision they build
// on, a mismatch comes back as "conflict", and the client keeps both texts.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

function notesTitled(prefix) {
  return NotesStore.listNotes().filter((n) => String(n.content.title || '').startsWith(prefix));
}

async function pullRows(rows, { cursor = 5000 } = {}) {
  h.server.pullPages = [{ items: rows, has_more: false, total_undeleted: rows.length, cursor }];
  return NotesStore.sync({ quiet: true });
}

(async () => {
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  // --- pulled rows carry the server revision; pushes send it back ----------
  const noteId = NotesStore.newUuid();
  const base = { ...NotesStore.defaultNote(), title: 'Plan', content: 'v1' };
  const row1 = await h.encryptedRow(noteId, base, 100, 1001, { rev: 3 });
  await pullRows([row1]);
  assert.strictEqual(NotesStore.get(noteId).rev, 3, 'pulled item remembers the server revision');
  assert.strictEqual(h.idb.get(noteId).rev, 3, 'the revision is persisted for the next session');

  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 4 }));
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'v2 from this device' });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  const pushed = h.pushCalls()[0].body.items[0];
  assert.strictEqual(pushed.base_rev, 3, 'the push names the revision it was based on');
  assert.strictEqual(NotesStore.get(noteId).rev, 4, 'the new revision is adopted after the push');
  assert.strictEqual(NotesStore.get(noteId).content_hash, pushed.content_hash, 'the item remembers the hash the server stored');
  assert.strictEqual(h.idb.get(noteId).content_hash, pushed.content_hash, 'IndexedDB carries the same version token');
  assert.strictEqual(h.idb.get(noteId).rev, 4);

  // The next pull reports our own row as unchanged (known_hashes match) instead
  // of downloading and re-applying it.
  h.resetServer();
  let knownSent = null;
  h.server.pullPages = [(body) => {
    knownSent = body.known_hashes || {};
    return { items: [{ item_uuid: noteId, unchanged: true, content_hash: pushed.content_hash, synced_at: 1002, updated_at: pushed.updated_at, rev: 4 }], has_more: false, total_undeleted: 1, cursor: 1002 };
  }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(knownSent[noteId], pushed.content_hash, 'the pull advertises the pushed hash');

  // --- conflict: another device wrote first; both texts survive -------------
  h.resetServer();
  const theirs = { ...base, content: 'v3 typed on the phone' };
  const theirRow = await h.encryptedRow(noteId, theirs, 300, 1003, { rev: 5 });
  let pushes = 0;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== noteId) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    pushes += 1;
    if (row.base_rev === 4) return { item_uuid: noteId, status: 'conflict', rev: 5, server_item: theirRow };
    assert.strictEqual(row.base_rev, 5, 're-push builds on the server revision');
    return { item_uuid: noteId, status: 'ok', rev: 6 };
  });
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'v3 typed on the laptop' });
  h.stopPushTimer();
  const ok = await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(NotesStore.get(noteId).content.content, 'v3 typed on the laptop', 'this device keeps its own text');
  assert.strictEqual(NotesStore.get(noteId).rev, 6, 'the re-push landed on top of the server revision');
  const copies = notesTitled('Plan (conflict copy)');
  assert.strictEqual(copies.length, 1, 'the other device\'s text became a conflict copy');
  assert.strictEqual(copies[0].content.content, 'v3 typed on the phone');
  assert.strictEqual(copies[0].content.conflict_of, noteId);
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'both the note and the copy reached the server');
  assert.ok(h.pushCalls().some((c) => c.body.items.some((r) => r.item_uuid === copies[0].uuid)), 'the copy is pushed as ciphertext');
  assert.strictEqual(pushes, 2, 'one conflict round trip, one re-push');

  // Identical text (our earlier push landed but the answer got lost) makes no copy.
  h.resetServer();
  const sameRow = await h.encryptedRow(noteId, NotesStore.get(noteId).content, 400, 1004, { rev: 7 });
  h.server.pushResponder = (items) => items.map((row) => (row.base_rev === 6
    ? { item_uuid: noteId, status: 'conflict', rev: 7, server_item: sameRow }
    : { item_uuid: noteId, status: 'ok', rev: 8 }));
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content }, { touchUpdatedAt: true });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(notesTitled('Plan (conflict copy)').length, 1, 'no conflict copy for identical text');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- pulls trust revisions over client clocks -----------------------------
  // Other device's clock is behind: its newer revision has an older updated_at.
  h.resetServer();
  const behind = await h.encryptedRow(noteId, { ...base, content: 'v4 from a slow clock' }, 50, 1005, { rev: 9 });
  await pullRows([behind]);
  assert.strictEqual(NotesStore.get(noteId).content.content, 'v4 from a slow clock', 'a newer revision applies even with an older clock');
  assert.strictEqual(NotesStore.get(noteId).rev, 9);

  // Unpushed local edit on rev 9 must not be overwritten by a pulled rev 10
  // with a later clock; the push resolves it with a conflict copy instead.
  h.resetServer();
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'v5 unpushed here' }, { touchUpdatedAt: false });
  h.stopPushTimer();
  NotesStore.get(noteId).updated_at = 10; // this device's clock is way behind
  const ahead = await h.encryptedRow(noteId, { ...base, content: 'v5 from the phone' }, 9999999999, 1006, { rev: 10 });
  h.server.pushPages = [];
  h.server.pullPages = [{ items: [ahead], has_more: false, total_undeleted: 1, cursor: 1006 }];
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== noteId) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    if (row.base_rev === 9) return { item_uuid: noteId, status: 'conflict', rev: 10, server_item: ahead };
    return { item_uuid: noteId, status: 'ok', rev: 11 };
  });
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.get(noteId).content.content, 'v5 unpushed here', 'the unpushed local edit survives the pull');
  assert.strictEqual(notesTitled('Plan (conflict copy)').length, 2, 'the phone\'s text is kept as a second conflict copy');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- deletes lose to edits -------------------------------------------------
  h.resetServer();
  const edited = await h.encryptedRow(noteId, { ...base, content: 'edited while you deleted' }, 500, 1007, { rev: 12 });
  h.server.pushResponder = (items) => items.map((row) => (row.item_uuid === noteId && row.deleted
    ? { item_uuid: noteId, status: 'conflict', rev: 12, server_item: edited }
    : { item_uuid: row.item_uuid, status: 'ok', rev: 13 }));
  assert.ok(NotesStore.remove(noteId));
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(NotesStore.get(noteId) && !NotesStore.get(noteId).deleted, 'the server edit is adopted instead of deleting it');
  assert.strictEqual(NotesStore.get(noteId).content.content, 'edited while you deleted');
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false);

  h.resetServer();
  const tomb = { item_uuid: noteId, ciphertext: '', content_hash: '', deleted: true, updated_at: 600, synced_at: 1008, rev: 13 };
  h.server.pushResponder = (items) => items.map((row) => (row.base_rev === 12
    ? { item_uuid: noteId, status: 'conflict', rev: 13, server_item: tomb }
    : { item_uuid: noteId, status: 'ok', rev: 14 }));
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'edited after they deleted' });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.get(noteId).rev, 14, 'an edit is re-pushed over a remote delete');
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false);

  // --- legacy "stale" (no revision known) also keeps both texts ---------------
  h.resetServer();
  const legacyId = NotesStore.newUuid();
  NotesStore.upsert(legacyId, { ...NotesStore.defaultNote(), title: 'Legacy', content: 'mine' });
  h.stopPushTimer();
  const serverCopy = await h.encryptedRow(legacyId, { ...NotesStore.defaultNote(), title: 'Legacy', content: 'theirs' }, Date.now() / 1000 + 50, 1009);
  let legacyPushes = 0;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== legacyId) return { item_uuid: row.item_uuid, status: 'ok' };
    legacyPushes += 1;
    return { item_uuid: legacyId, status: legacyPushes === 1 ? 'stale' : 'ok' };
  });
  h.server.refetchResponder = (body) => (body.uuids.includes(legacyId) ? [serverCopy] : []);
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.get(legacyId).content.content, 'mine');
  assert.strictEqual(notesTitled('Legacy (conflict copy)').length, 1, 'the server text is kept when a legacy clock race is lost');
  assert.ok(NotesStore.get(legacyId).updated_at > serverCopy.updated_at, 're-push is newer than the server copy for clock-based servers');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  console.log('test_sync_rev_conflicts.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
