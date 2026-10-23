/**
 * Round 64: end-to-end rollback demo hook + history/UI contracts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');

const { NotesStore, NotesFreshness, NotesCrypto } = h;
const root = path.join(__dirname, '..');

(async () => {
  assert.ok(NotesFreshness, 'sync_harness must load freshness.js');
  assert.ok(typeof NotesStore.testDemoRollbackWarning === 'function');
  assert.ok(typeof NotesStore.testFreshnessProbeItem === 'function');

  await h.unlockFresh();
  h.stopPushTimer();
  h.resetServer();

  const uuid = NotesStore.newUuid();
  NotesStore.upsert(uuid, {
    ...NotesStore.defaultNote(),
    title: 'r64 demo',
    content: 'hello r61',
    __fv: 1,
    __fid: uuid,
  });
  await h.waitFor(() => h.idb.get(uuid)?.ciphertext, 'note persisted');
  const localBody = NotesStore.get(uuid).content.content;
  assert.strictEqual(localBody, 'hello r61');

  // Server still holds a valid older-or-same ciphertext (no new pull needed).
  const serverRow = await h.encryptedRow(
    uuid,
    { type: 'note', title: 'r64 demo', content: 'hello r61', __fv: 1, __fid: uuid },
    Date.now() / 1000,
    Date.now() / 1000,
    { rev: 1 },
  );
  h.server.itemResponder = async (id) => {
    assert.strictEqual(id, uuid);
    return serverRow;
  };

  // Without the flag, hooks must refuse.
  await assert.rejects(
    () => NotesStore.testDemoRollbackWarning(uuid, 9),
    /notes_freshness_test/,
  );

  localStorage.setItem('notes_freshness_test', '1');
  NotesFreshness.clearWarnings();

  const toasts = [];
  NotesFreshness.onChange((snap) => {
    const latest = snap?.warnings?.[0];
    if (latest?.message) toasts.push(latest.message);
  });

  const result = await NotesStore.testDemoRollbackWarning(uuid, 9);
  assert.strictEqual(result.rejected, true, 'demo must reject via production freshness path');
  assert.ok(result.warning, 'warning object required');
  assert.strictEqual(result.warning.type, NotesFreshness.WARN_TYPES.rollback);
  assert.ok(/older version/i.test(result.warning.message));
  assert.ok(toasts.some((t) => /older version/i.test(t)), `toast path must fire: ${JSON.stringify(toasts)}`);
  assert.strictEqual(
    NotesStore.get(uuid).content.content,
    'hello r61',
    'local note must not be overwritten',
  );
  assert.ok(
    h.fetchCalls.some((c) => String(c.url).includes(`/api/sync/item/${uuid}`)),
    'must re-fetch server ciphertext',
  );

  // Ordinary pull of a received item still runs checkIncoming.
  const older = await h.encryptedRow(
    uuid,
    { type: 'note', title: 'r64 demo', content: 'stale', __fv: 1, __fid: uuid },
    Date.now() / 1000,
    Date.now() / 1000,
    { rev: 2 },
  );
  h.resetServer();
  h.server.pullPages = [{ items: [older], has_more: false, cursor: 99 }];
  NotesFreshness.clearWarnings();
  NotesFreshness.testInjectRollbackScenario(uuid, 9);
  NotesStore.get(uuid).rev = 0;
  await NotesStore.sync({ quiet: true });
  assert.ok(
    NotesFreshness.getPublicSnapshot().warnings.some((w) => w.type === 'rollback'),
    'incremental pull must still gate received items',
  );
  assert.strictEqual(NotesStore.get(uuid).content.content, 'hello r61');

  localStorage.removeItem('notes_freshness_test');

  // Contracts: verify docs + trash label sync + unlock clear preserve.
  const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
  assert.ok(verify.includes('testDemoRollbackWarning'));
  assert.ok(verify.includes('applySyncPayload'));
  const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
  assert.ok(appJs.includes('syncNoteRowActionLabels'));
  assert.ok(appJs.includes('clearUnlockPasswordField({ force'));
  assert.ok(appJs.includes('if (!force && String(unlockPassword.value || \'\')) return'));
  const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
  assert.ok(storeJs.includes('title: content.title || \'\''));
  assert.ok(storeJs.includes('content: content.content || \'\''));

  console.log('test_round64_freshness_demo ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
