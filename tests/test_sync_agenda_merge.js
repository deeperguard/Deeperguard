// Regression: all agenda events live in one encrypted item (agenda_pack). On a sync
// conflict the newest pack used to win whole, so an event added on the phone vanished
// when the laptop had added another one. The conflict now merges event by event.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;

const iso = (ms) => new Date(ms).toISOString();
const ev = (title, updatedMs) => ({
  type: 'agenda_event',
  title,
  start: '2026-11-20T09:00:00.000Z',
  end: '2026-11-20T10:00:00.000Z',
  all_day: false,
  updated_at: iso(updatedMs),
});

function titles() {
  return NotesStore.listAgendaEvents().map((e) => e.title).sort();
}

(async () => {
  // --- pure merge rules ------------------------------------------------------
  const T = Date.parse('2026-11-12T12:00:00Z');
  const m = NotesStore.mergeAgendaPacks(
    {
      type: 'agenda_pack',
      updated_at: iso(T + 50),
      events: {
        a: ev('A local only', T),
        both: ev('Both: local older', T + 10),
        tie: ev('Tie: local', T + 30),
        editedAfterDelete: ev('Edited after delete', T + 40),
      },
      deleted_events: { remoteOnlyDeletedHere: iso(T + 20), old: iso(T - 61 * 86400000) },
    },
    {
      type: 'agenda_pack',
      updated_at: iso(T + 60),
      events: {
        b: ev('B remote only', T),
        both: ev('Both: remote newer', T + 20),
        tie: ev('Tie: remote', T + 30),
        remoteOnlyDeletedHere: ev('Deleted here later', T + 5),
        editedAfterDelete: ev('stale', T + 1),
      },
      deleted_events: { editedAfterDelete: iso(T + 35) },
    },
    T + 100,
  );
  assert.deepStrictEqual(Object.keys(m.events).sort(), ['a', 'b', 'both', 'editedAfterDelete', 'tie']);
  assert.strictEqual(m.events.both.title, 'Both: remote newer', 'newer edit wins per event');
  assert.strictEqual(m.events.tie.title, 'Tie: local', 'a tie keeps the local copy');
  assert.strictEqual(m.events.editedAfterDelete.title, 'Edited after delete', 'an edit after a delete wins');
  assert.ok(!m.events.remoteOnlyDeletedHere, 'a delete beats an older copy from the other device');
  assert.deepStrictEqual(Object.keys(m.deleted_events).sort(), ['remoteOnlyDeletedHere'], 'stale tombstones are dropped');
  assert.strictEqual(m.updated_at, iso(T + 60));

  // --- through a real push conflict -------------------------------------------
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  // Both devices start from the same pack with one event at server rev 3.
  const base = {
    type: 'agenda_pack',
    version: 1,
    created_at: iso(T),
    updated_at: iso(T),
    events: { shared: ev('Shared', T), gone: ev('Deleted on phone', T) },
  };
  const baseRow = await h.encryptedRow(PACK, base, 100, 1001, { rev: 3 });
  h.server.pullPages = [{ items: [baseRow], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });
  assert.deepStrictEqual(titles(), ['Deleted on phone', 'Shared']);

  // The phone (other device) adds "Dentist", renames "Shared" and deletes one event: rev 4.
  const phone = {
    ...base,
    updated_at: iso(Date.now() - 1000),
    events: {
      shared: ev('Shared (renamed on phone)', Date.now() - 1000),
      dentist: ev('Dentist', Date.now() - 1000),
    },
    deleted_events: { gone: iso(Date.now() - 1000) },
  };
  const phoneRow = await h.encryptedRow(PACK, phone, 300, 1003, { rev: 4 });

  // This device (laptop) adds "Team lunch" while still on rev 3.
  h.resetServer();
  let pushes = 0;
  let finalPush = null;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== PACK) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    pushes += 1;
    if (row.base_rev === 3) return { item_uuid: PACK, status: 'conflict', rev: 4, server_item: phoneRow };
    assert.strictEqual(row.base_rev, 4, 're-push builds on the phone revision');
    finalPush = row;
    return { item_uuid: PACK, status: 'ok', rev: 5 };
  });
  NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
    title: 'Team lunch',
    start: '2026-11-21T11:00:00.000Z',
    end: '2026-11-21T12:00:00.000Z',
    all_day: false,
  });
  h.stopPushTimer();
  const ok = await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(ok, true);
  assert.strictEqual(pushes, 2, 'one conflict, one re-push of the merged pack');
  assert.ok(finalPush, 'the merged pack was pushed');
  assert.deepStrictEqual(
    titles(),
    ['Dentist', 'Shared (renamed on phone)', 'Team lunch'],
    'both devices\' changes survive: phone add, rename and delete, laptop add',
  );
  assert.strictEqual(NotesStore.state.dirty.size, 0);
  assert.strictEqual(NotesStore.get(PACK).rev, 5);

  // --- local delete leaves a tombstone; re-creating clears it -----------------
  const lunch = NotesStore.listAgendaEvents().find((e) => e.title === 'Team lunch');
  NotesStore.removeAgendaEvent(lunch.id);
  h.stopPushTimer();
  assert.ok(NotesStore.get(PACK).content.deleted_events[lunch.id], 'delete leaves a tombstone');
  NotesStore.upsertAgendaEvent(lunch.id, { ...lunch, title: 'Team lunch again' });
  h.stopPushTimer();
  assert.ok(!NotesStore.get(PACK).content.deleted_events[lunch.id], 're-creating clears the tombstone');

  // --- reminder bookkeeping keeps the event timestamp ------------------------
  const before = NotesStore.listAgendaEvents().find((e) => e.id === lunch.id).updated_at;
  await new Promise((r) => setTimeout(r, 5));
  NotesStore.upsertAgendaEvent(lunch.id, { ...lunch, title: 'Team lunch again', scheduled_reminder_ids: [] }, { keepUpdatedAt: true });
  h.stopPushTimer();
  assert.strictEqual(NotesStore.listAgendaEvents().find((e) => e.id === lunch.id).updated_at, before);

  console.log('sync agenda merge ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
