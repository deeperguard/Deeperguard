/**
 * Backlink index wired to the real NotesStore: notes arriving in the first
 * pull (since=0, search index deferred) land in the index, a remote delete and
 * a local edit update it, lock() clears it, and no plaintext index data ends up
 * in localStorage / sessionStorage / IndexedDB.
 */
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore, server, idb, meta } = h;
global.NotesLinks = require('../app/static/js/notelinks.js');
global.NotesBacklinks = require('../app/static/js/backlinks.js');
const B = global.NotesBacklinks;

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const MARK = 'Zebra-context-marker';

(async () => {
  await h.unlockFresh();
  h.resetServer();
  const events = [];
  const ctl = B.connect({ store: NotesStore, debounceMs: 1, onChange: (t) => events.push(t) });
  // Index built (empty vault) before the first pull has finished.
  await ctl.ensureBuilt();
  assert.strictEqual(B.status, 'ready');
  assert.strictEqual(NotesStore.syncSince(), 0, 'first pull of this device');

  const now = Date.now() / 1000;
  const note = (title, content) => ({ type: 'note', title, content, tags: [], updated_at: new Date().toISOString() });
  server.pullPages = [{
    items: [
      await h.encryptedRow(T, note('Target', 'target body'), now - 30, now - 30),
      await h.encryptedRow(S1, note('Source one', `${MARK} [Target](dg-note:${T}) tail`), now - 20, now - 20),
      await h.encryptedRow(S2, note('Source two', `also [T](dg-note:${T})`), now - 10, now - 10),
    ],
    has_more: false,
    server_time: now,
  }];
  await NotesStore.sync();
  h.stopPushTimer();
  await ctl.flush();
  await h.waitFor(() => B.status === 'ready', 'index ready');
  assert.deepStrictEqual(
    B.linksTo(T).map((r) => r.sourceUuid).sort(), [S1, S2],
    'notes from the first (deferred) pull are in the index',
  );

  // Incoming remote delete of a source (incremental pull).
  server.pullPages = [{
    items: [await h.encryptedRow(S2, { ...note('Source two', ''), deleted: true }, now + 5, now + 5, { deleted: true })],
    has_more: false,
    server_time: now + 5,
  }];
  await NotesStore.sync();
  h.stopPushTimer();
  await ctl.flush();
  assert.deepStrictEqual(B.linksTo(T).map((r) => r.sourceUuid), [S1], 'remote delete removes the backlink');

  // Local edit removes the link.
  NotesStore.upsert(S1, { ...NotesStore.get(S1).content, content: 'no more link' });
  h.stopPushTimer();
  await ctl.flush();
  assert.deepStrictEqual(B.linksTo(T), [], 'local edit updates the index');
  NotesStore.upsert(S1, { ...NotesStore.get(S1).content, content: `${MARK} [Target](dg-note:${T})` });
  h.stopPushTimer();
  await ctl.flush();
  assert.strictEqual(B.linksTo(T).length, 1);
  await h.tick(10);

  // Nothing about the index (or the plaintext it came from) is in storage.
  const dump = JSON.stringify([localStorage.store, sessionStorage.store, [...idb.values()], [...meta.entries()]]);
  for (const needle of [MARK, 'Source one', 'backlink', `dg-note:${T}`]) {
    assert.ok(!dump.includes(needle), `storage must not contain ${needle}`);
  }

  // Lock wipes the index from memory.
  NotesStore.lock();
  assert.deepStrictEqual(B.stats(), { sources: 0, targets: 0, scanned: 0, status: 'idle' });
  assert.deepStrictEqual(B.linksTo(T), []);
  assert.strictEqual(events[events.length - 1], null);
  ctl.disconnect();
  console.log('backlinks store: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
