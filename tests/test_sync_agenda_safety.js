// Agenda sync safety: an empty/older server pack never wipes local events, only a
// tombstone removes one, the server only sees ciphertext, and the pre-merge local
// backup can be restored. See docs/AGENDA_SYNC_BUG.md.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const iso = (ms) => new Date(ms).toISOString();
const titles = () => NotesStore.listAgendaEvents().map((e) => e.title).sort();
const emptyPack = (ms) => ({ type: 'agenda_pack', version: 1, created_at: iso(ms), updated_at: iso(ms), events: {} });

(async () => {
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();
  const pushed = [];
  h.server.pushResponder = (items) => items.map((row) => {
    pushed.push(JSON.stringify(row));
    return { item_uuid: row.item_uuid, status: 'ok', rev: 2 };
  });

  const dentist = NotesStore.newUuid();
  NotesStore.upsertAgendaEvent(dentist, {
    title: 'Dentist', start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z', all_day: false,
  });
  NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
    title: 'Team lunch', start: '2026-11-21T11:00:00.000Z', end: '2026-11-21T12:00:00.000Z', all_day: false,
  });

  // 1. Empty server pack: nothing local disappears.
  const emptyRow = await h.encryptedRow(PACK, emptyPack(Date.now() + 5000), Date.now() / 1000 + 5, 1001, { rev: 7 });
  h.server.pullPages = [{ items: [emptyRow], has_more: false, total_undeleted: 1, cursor: 5000 }];
  h.stopPushTimer();
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.deepStrictEqual(titles(), ['Dentist', 'Team lunch'], 'empty server set removes nothing');

  // 2. The server only ever got ciphertext.
  assert.ok(pushed.length, 'the agenda pack was pushed');
  for (const body of pushed) {
    assert.ok(!/Dentist|Team lunch|2026-11-2/.test(body), 'no titles or times in plaintext in the push');
  }

  // 3. Pre-merge backup exists and is restorable.
  assert.ok((await NotesStore.listAgendaBackups()).length >= 1, 'a local backup was taken before the merge');
  NotesStore.removeAgendaEvent(dentist);
  h.stopPushTimer();
  assert.deepStrictEqual(titles(), ['Team lunch']);
  const res = await NotesStore.restoreAgendaBackup();
  h.stopPushTimer();
  assert.ok(res.ok);
  assert.deepStrictEqual(titles(), ['Dentist', 'Team lunch'], 'restore brings the events back');

  // 4. Only a tombstone deletes: another device deleted the dentist.
  const remote = {
    ...emptyPack(Date.now()),
    updated_at: iso(Date.now() + 60000),
    deleted_events: { [dentist]: iso(Date.now() + 60000) },
  };
  const row = await h.encryptedRow(PACK, remote, Date.now() / 1000 + 60, 1002, { rev: 9 });
  h.server.pullPages = [{ items: [row], has_more: false, total_undeleted: 1, cursor: 6000 }];
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.deepStrictEqual(titles(), ['Team lunch'], 'a tombstone removes exactly that event');

  console.log('sync agenda safety ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
