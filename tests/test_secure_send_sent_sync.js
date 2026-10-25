/**
 * secure_send_sent vault items participate in normal sync push/pull (ciphertext).
 */
const assert = require('assert');
const h = require('./sync_harness');

(async () => {
  h.resetServer();
  await h.unlockFresh();
  h.NotesStore.markKeyVerified();
  h.NotesStore.state.localReady = true;

  const sendId = 'send-sync-test-001';
  const shareUrl = 'https://notes.example/receive/abc#keyfrag99';
  const saved = h.NotesStore.saveSecureSendSentRecord({
    sendId,
    shareUrl,
    snapshot: {
      title: 'Synced title',
      body: 'Synced body',
      attachment_names: ['doc.pdf'],
    },
  });
  assert.ok(saved);
  assert.strictEqual(h.NotesStore.state.dirty.size, 1);

  const uuid = h.NotesStore.getSecureSendSentRecord(sendId).uuid;
  h.stopPushTimer();
  await h.NotesStore.pushDirty({ quiet: true });
  await h.tick(10);

  const pushes = h.pushCalls();
  assert.ok(pushes.length >= 1, 'pushDirty uploads secure_send_sent');
  const pushed = pushes[0].body.items.find((row) => row.item_uuid === uuid);
  assert.ok(pushed && pushed.ciphertext, 'row is encrypted for sync');

  const serverRow = {
    ...pushed,
    rev: 1,
    synced_at: 6000,
    updated_at: 6000,
  };

  // Second device: empty local vault, pull from server.
  delete require.cache[require.resolve('../app/static/js/store.js')];
  h.idb.clear();
  h.meta.clear();
  h.fetchCalls.length = 0;
  h.server.pullPages = [{ items: [serverRow], has_more: false, total_undeleted: 1 }];
  h.server.watermark = { watermark: 6000, synced_watermark: 6000, item_count: 1 };

  const NotesStoreB = require('../app/static/js/store.js');
  await NotesStoreB.unlock(h.PASSWORD, h.SALT, { kdfVersion: 1 });
  NotesStoreB.markKeyVerified();
  NotesStoreB.state.localReady = true;
  NotesStoreB.state.lastSync = 0;
  await NotesStoreB.sync({ quiet: true, full: true });
  await h.tick(20);

  const rec = NotesStoreB.getSecureSendSentRecord(sendId);
  assert.ok(rec, 'device B has vault sent record after pull');
  assert.strictEqual(rec.shareUrl, shareUrl, 'full URL including # fragment');
  assert.strictEqual(rec.snapshot.title, 'Synced title');
  assert.strictEqual(rec.snapshot.body, 'Synced body');
  assert.deepStrictEqual(rec.snapshot.attachment_names, ['doc.pdf']);
  assert.ok(
    !NotesStoreB.listNotes().some((n) => n.content?.type === 'secure_send_sent'),
    'sent records are not notes',
  );

  console.log('test_secure_send_sent_sync ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
