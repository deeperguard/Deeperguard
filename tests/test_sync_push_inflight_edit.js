// Regression: text typed while a push was on the wire was dropped from the
// dirty queue when that push settled, so the last few seconds of typing never
// reached the server and later pulls overwrote them.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;

(async () => {
  await h.unlockFresh();
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'first', content: 'first' });
  h.stopPushTimer();
  await h.waitFor(() => h.idb.get(noteId)?.ciphertext, 'note persisted');

  // Hold the first push open, type while it is in flight, then let it settle.
  const gate = h.deferred();
  let pushes = 0;
  h.server.pushResponder = async (items) => {
    pushes += 1;
    if (pushes === 1) await gate.promise;
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  };
  h.resetServer();
  h.server.pushResponder = async (items) => {
    pushes += 1;
    if (pushes === 1) await gate.promise;
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  };
  const inFlight = NotesStore.pushDirty({ quiet: true });
  await h.waitFor(() => h.pushCalls().length === 1, 'first push on the wire');
  await new Promise((resolve) => setTimeout(resolve, 5));
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'second (typed during push)' });
  h.stopPushTimer();
  assert.ok(NotesStore.state.dirty.has(noteId), 'edit during push marks the note dirty');
  gate.resolve();
  const ok = await inFlight;
  assert.strictEqual(ok, true, 'push reports success');

  const sent = h.pushCalls();
  assert.strictEqual(sent.length, 2, 'the edit made during the first push is pushed again');
  const last = await h.decryptRow(sent[1].body.items.find((row) => row.item_uuid === noteId));
  assert.strictEqual(last.content, 'second (typed during push)', 'server receives the latest text');
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false, 'queue drains once the latest text is on the server');

  // A delete during an in-flight push must survive as well.
  h.resetServer();
  pushes = 0;
  const gate2 = h.deferred();
  h.server.pushResponder = async (items) => {
    pushes += 1;
    if (pushes === 1) await gate2.promise;
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  };
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, content: 'third' });
  h.stopPushTimer();
  const inFlight2 = NotesStore.pushDirty({ quiet: true });
  await h.waitFor(() => h.pushCalls().length === 1, 'push on the wire');
  assert.ok(NotesStore.remove(noteId), 'delete while pushing');
  h.stopPushTimer();
  gate2.resolve();
  await inFlight2;
  const deletes = h.pushCalls().filter((c) => c.body.items.some((row) => row.item_uuid === noteId && row.deleted));
  assert.strictEqual(deletes.length, 1, 'the delete made during the push is pushed afterwards');
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'queue drained');

  // Items the server refuses are not retried in a tight loop.
  h.resetServer();
  const stuckId = NotesStore.newUuid();
  NotesStore.upsert(stuckId, { ...NotesStore.defaultNote(), title: 'stuck' });
  h.stopPushTimer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'rejected' }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(h.pushCalls().length, 1, 'a rejected item is pushed once per pass, not in a loop');
  assert.ok(NotesStore.state.dirty.has(stuckId), 'rejected item stays queued for the next pass');

  console.log('test_sync_push_inflight_edit.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
