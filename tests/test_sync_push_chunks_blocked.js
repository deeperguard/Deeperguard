// Regression: one oversized item wedged the whole push queue. The server
// answered 413 for the batch, the client treated that as "nothing saved", and
// every later note edit sat behind the same failing request. Pushes are now
// chunked, a 413 is narrowed down to the item that caused it, and per-item
// quota / size refusals block only that item.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const statuses = [];
NotesStore.setSaveStatusCallback?.((text, isError) => statuses.push({ text, isError }));

(async () => {
  await h.unlockFresh();

  // --- chunkPushRows splits on item count and on bytes ----------------------
  const small = Array.from({ length: 450 }, (_, i) => ({ item_uuid: `s${i}`, ciphertext: 'x'.repeat(10), blob_ciphertext: '' }));
  const byCount = NotesStore.chunkPushRows(small);
  assert.deepStrictEqual(byCount.map((c) => c.length), [200, 200, 50], 'at most 200 items per request');
  const big = { item_uuid: 'big', ciphertext: 'y'.repeat(4 * 1024 * 1024), blob_ciphertext: 'z'.repeat(3 * 1024 * 1024) };
  const byBytes = NotesStore.chunkPushRows([small[0], big, small[1], small[2]]);
  assert.deepStrictEqual(byBytes.map((c) => c.map((r) => r.item_uuid)), [['s0'], ['big'], ['s1', 's2']], 'a large item gets its own request');

  // --- a 413 is narrowed to the offending item, the rest is saved ------------
  const bigId = NotesStore.newUuid();
  const noteA = NotesStore.newUuid();
  const noteB = NotesStore.newUuid();
  NotesStore.upsert(noteA, { ...NotesStore.defaultNote(), title: 'A', content: 'a' });
  NotesStore.upsert(bigId, { ...NotesStore.defaultNote(), title: 'Huge scan', content: 'pretend this is 90 MB' });
  NotesStore.upsert(noteB, { ...NotesStore.defaultNote(), title: 'B', content: 'b' });
  h.stopPushTimer();
  await h.waitFor(() => h.idb.get(noteB)?.ciphertext, 'notes persisted');
  h.resetServer();
  // Legacy server / proxy: any request containing the big item is refused whole.
  h.server.pushResponder = (items) => {
    if (items.some((row) => row.item_uuid === bigId)) {
      return { __status: 413, body: { error: 'File too large to upload' } };
    }
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  };
  statuses.length = 0;
  const ok = await NotesStore.pushDirty();
  assert.strictEqual(ok, true, 'the push as a whole succeeds');
  assert.strictEqual(NotesStore.state.dirty.has(noteA), false, 'note A reached the server');
  assert.strictEqual(NotesStore.state.dirty.has(noteB), false, 'note B reached the server');
  assert.ok(NotesStore.state.dirty.has(bigId), 'the oversized item stays queued locally');
  const blocked = NotesStore.blockedItems();
  assert.deepStrictEqual(blocked.map((b) => [b.uuid, b.status]), [[bigId, 'too_large']], 'only the big item is blocked');
  assert.ok(statuses.some((s) => /Huge scan/.test(s.text) && /too large/.test(s.text)), `the user is told which item did not sync: ${JSON.stringify(statuses)}`);
  assert.ok(h.pushCalls().length <= 6, `413 narrowing stays logarithmic (${h.pushCalls().length} requests)`);

  // Later edits are not stuck behind it.
  h.resetServer();
  h.server.pushResponder = (items) => {
    if (items.some((row) => row.item_uuid === bigId)) return { __status: 413, body: { error: 'File too large to upload' } };
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  };
  NotesStore.upsert(noteA, { ...NotesStore.get(noteA).content, content: 'a2' });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.has(noteA), false, 'a later edit syncs although the big item is blocked');
  assert.strictEqual(h.pushCalls().length, 1, 'the blocked item is not re-sent on every push');
  assert.deepStrictEqual(h.pushCalls()[0].body.items.map((r) => r.item_uuid), [noteA], 'only the edited note went out');

  // sync() retries blocked items; editing one unblocks it immediately.
  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
  await NotesStore.pushDirty({ quiet: true, retryBlocked: true });
  assert.strictEqual(h.pushCalls().length, 1, 'a retry pass re-sends blocked items');
  assert.strictEqual(NotesStore.state.dirty.has(bigId), false, 'the item syncs once the server accepts it');
  assert.strictEqual(NotesStore.blockedItems().length, 0, 'nothing left blocked');

  // --- per-item quota statuses from a current server (200 + partial) --------
  h.resetServer();
  const quotaId = NotesStore.newUuid();
  const noteC = NotesStore.newUuid();
  NotesStore.upsert(quotaId, { ...NotesStore.defaultNote(), title: 'Big PDF', content: 'over quota' });
  NotesStore.upsert(noteC, { ...NotesStore.defaultNote(), title: 'C', content: 'c' });
  h.stopPushTimer();
  h.server.pushResponder = (items, body) => {
    assert.strictEqual(body.partial, 1, 'current clients ask for per-item results');
    return items.map((row) => ({ item_uuid: row.item_uuid, status: row.item_uuid === quotaId ? 'quota_exceeded' : 'ok', rev: 1 }));
  };
  statuses.length = 0;
  await NotesStore.pushDirty();
  assert.strictEqual(NotesStore.state.dirty.has(noteC), false, 'note C is saved although another item hit the quota');
  assert.ok(NotesStore.state.dirty.has(quotaId), 'the quota item stays local');
  assert.strictEqual(NotesStore.blockedItems()[0]?.status, 'quota_exceeded');
  assert.ok(statuses.some((s) => /Big PDF/.test(s.text) && /quota/.test(s.text)), 'quota message names the item');
  // Editing the blocked item retries it without waiting for sync().
  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 2 }));
  NotesStore.upsert(quotaId, { ...NotesStore.get(quotaId).content, content: 'smaller now' });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.has(quotaId), false, 'an edited blocked item is pushed again');
  assert.strictEqual(NotesStore.blockedItems().length, 0);

  // --- a network error mid-queue keeps the chunks that were answered -------
  h.resetServer();
  const many = [];
  for (let i = 0; i < 205; i += 1) {
    const id = NotesStore.newUuid();
    many.push(id);
    NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: `n${i}`, content: String(i) });
  }
  h.stopPushTimer();
  let requests = 0;
  h.server.pushResponder = (items) => {
    requests += 1;
    if (requests === 2) throw new TypeError('Failed to fetch');
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 1 }));
  };
  const okMany = await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(okMany, false, 'the failed chunk fails the pass');
  assert.strictEqual(requests, 2, 'two chunks for 205 items');
  const stillDirty = many.filter((id) => NotesStore.state.dirty.has(id));
  assert.strictEqual(stillDirty.length, 5, `only the unanswered chunk stays queued (${stillDirty.length})`);

  console.log('test_sync_push_chunks_blocked.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
