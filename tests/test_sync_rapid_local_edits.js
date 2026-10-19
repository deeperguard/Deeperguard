// Rapid local saves on one device must not spawn a "(conflict copy)".
// When a push lands while the note is still dirty, adopt the new revision so
// the next push does not conflict with our own earlier write.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

function notesTitled(prefix) {
  return NotesStore.listNotes().filter((n) => String(n.content.title || '').startsWith(prefix));
}

(async () => {
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Checklist note', content: '- [ ] one' });
  h.stopPushTimer();
  h.server.pushResponder = (items) => items.map((row) => ({
    item_uuid: row.item_uuid,
    status: 'ok',
    rev: 1,
  }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.get(noteId).rev, 1);

  // Simulate: push of "two" is in flight; user ticks a checkbox ("three") before
  // the response arrives. editedSincePush stays true; we must still adopt rev 2.
  let pushCount = 0;
  h.resetServer();
  h.server.pushResponder = (items) => {
    pushCount += 1;
    if (pushCount === 1) {
      // Mid-flight local edit after the snapshot was taken.
      NotesStore.upsert(noteId, {
        ...NotesStore.get(noteId).content,
        content: '- [x] one\n- [ ] two\n- [ ] three',
      });
      h.stopPushTimer();
      return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 2 }));
    }
    return items.map((row) => {
      assert.strictEqual(row.base_rev, 2, 'second push builds on the adopted revision');
      return { item_uuid: row.item_uuid, status: 'ok', rev: 3 };
    });
  };

  NotesStore.upsert(noteId, {
    ...NotesStore.get(noteId).content,
    content: '- [ ] one\n- [ ] two',
  });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });

  assert.strictEqual(NotesStore.get(noteId).content.content, '- [x] one\n- [ ] two\n- [ ] three');
  assert.strictEqual(NotesStore.get(noteId).rev, 3, 'final revision after re-push');
  assert.strictEqual(notesTitled('Checklist note (conflict copy)').length, 0, 'no conflict copy on one device');
  assert.strictEqual(NotesStore.state.dirty.size, 0);
  assert.ok(pushCount >= 2, 'dirty mid-flight edit was re-pushed');

  // Fingerprint defense: a conflict whose remote text is one of our recent local
  // saves rebases without spawning a sibling.
  h.resetServer();
  const earlier = { ...NotesStore.get(noteId).content, content: '- [ ] one\n- [ ] two' };
  const theirRow = await h.encryptedRow(noteId, earlier, 300, 2001, { rev: 4 });
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== noteId) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    if (row.base_rev === 3) {
      return { item_uuid: noteId, status: 'conflict', rev: 4, server_item: theirRow };
    }
    return { item_uuid: noteId, status: 'ok', rev: 5 };
  });
  NotesStore.upsert(noteId, {
    ...NotesStore.get(noteId).content,
    content: '- [x] one\n- [ ] two\n- [ ] three\n- [ ] four',
  });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(notesTitled('Checklist note (conflict copy)').length, 0, 'recent local text rebases without a copy');
  assert.strictEqual(NotesStore.get(noteId).content.content, '- [x] one\n- [ ] two\n- [ ] three\n- [ ] four');

  console.log('test_sync_rapid_local_edits.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
