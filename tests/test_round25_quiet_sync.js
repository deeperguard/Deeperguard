// A quiet sync that pulls rows already on the device must still report ok,
// so the header can leave "Sync" / "Waiting". An empty check stays silent.
const assert = require('assert');
const h = require('./sync_harness');

(async () => {
  await h.unlockFresh();
  h.resetServer();
  const id = h.NotesStore.newUuid();
  const row = await h.encryptedRow(id, { ...h.NotesStore.defaultNote(), title: 'Keep' }, 10, 1001);
  h.server.pullPages = [{ items: [row], has_more: false, total_undeleted: 1, cursor: 1001 }];
  await h.NotesStore.sync({ quiet: true });
  assert.strictEqual(h.NotesStore.state.items.has(id), true);

  const statuses = [];
  h.NotesStore.setSyncStatusCallback((status) => statuses.push(status));
  h.resetServer();
  h.server.pullPages = [{ items: [row], has_more: false, total_undeleted: 1, cursor: 1002 }];
  const sizeBefore = h.NotesStore.state.items.size;
  await h.NotesStore.sync({ quiet: true });
  assert.strictEqual(h.NotesStore.state.items.size, sizeBefore, 'the same rows do not change the local count');
  assert.ok(statuses.some((status) => status.state === 'ok'), 'a quiet pull still reports synced');

  statuses.length = 0;
  h.resetServer();
  h.server.pullPages = [{ items: [], has_more: false, total_undeleted: 1, cursor: 1002 }];
  await h.NotesStore.sync({ quiet: true });
  assert.deepStrictEqual(statuses, [], 'an empty background check stays silent');

  console.log('round 25 quiet sync ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
