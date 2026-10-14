// Regression: permanently deleting a note left its attachments live on the
// server (orphaned bytes counting against the quota), and removing an entry
// from the shared search index only deleted the key, so the next merge with a
// device that still had the entry brought it back.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

function fakeFile(text, name) {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type: 'text/plain',
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // --- deleting a note deletes its files -----------------------------------
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Receipts' });
  const attA = await NotesStore.addAttachment(noteId, fakeFile('receipt one', 'one.txt'));
  const attB = await NotesStore.addAttachment(noteId, fakeFile('receipt two', 'two.txt'));
  const otherNote = NotesStore.newUuid();
  NotesStore.upsert(otherNote, { ...NotesStore.defaultNote(), title: 'Keep' });
  const attKeep = await NotesStore.addAttachment(otherNote, fakeFile('unrelated', 'keep.txt'));
  h.stopPushTimer();
  NotesStore.setAttachmentOcr(attA, 'receipt one text', 'tesseract');
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0);
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 2);

  h.resetServer();
  assert.ok(NotesStore.remove(noteId));
  h.stopPushTimer();
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 0, 'the note\'s files are gone with it');
  assert.ok(NotesStore.get(attA)?.deleted && NotesStore.get(attB)?.deleted, 'attachment items are tombstoned');
  assert.ok(!NotesStore.get(attKeep).deleted, 'another note\'s file is untouched');
  await NotesStore.pushDirty({ quiet: true });
  const pushedDeletes = h.pushCalls().flatMap((c) => c.body.items).filter((row) => row.deleted).map((row) => row.item_uuid).sort();
  assert.deepStrictEqual(pushedDeletes, [attA, attB, noteId].sort(), 'the server receives tombstones for the note and both files');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- the shared search index forgets removed files for good --------------
  const index = NotesStore.get(NotesStore.SEARCH_INDEX_UUID);
  assert.ok(index, 'a search index record exists');
  assert.strictEqual(index.content.entries[attA]?.method, 'removed', 'a removed file leaves a tombstone, not a hole');
  // Another device still holds the old entry: merging must not bring it back.
  const stale = { [attA]: { note_id: noteId, filename: 'one.txt', text: 'receipt one text', method: 'tesseract' } };
  const merged = NotesStore.mergeSearchEntries(index.content.entries, stale);
  assert.strictEqual(merged[attA]?.method, 'removed', 'a removal wins over a stale live entry (local side)');
  const mergedOther = NotesStore.mergeSearchEntries(stale, index.content.entries);
  assert.strictEqual(mergedOther[attA]?.method, 'removed', 'a removal wins over a stale live entry (remote side)');
  // Live entries still merge by the longer text, and old tombstones are pruned
  // on both sides so a prune never ping-pongs between devices.
  const live = NotesStore.mergeSearchEntries({ x: { text: 'short', method: 'tesseract' } }, { x: { text: 'much longer text', method: 'tesseract' } });
  assert.strictEqual(live.x.text, 'much longer text');
  const old = { y: { method: 'removed', removed_at: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString() } };
  assert.deepStrictEqual(NotesStore.mergeSearchEntries(old, {}), {}, 'expired tombstones drop out');
  assert.deepStrictEqual(NotesStore.mergeSearchEntries({}, old), {});
  assert.ok(!NotesStore.searchIndexCovers(attA), 'a removed entry never counts as indexed');

  console.log('test_sync_delete_cleanup.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
