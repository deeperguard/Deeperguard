// Calendar migration (docs/CALENDARS_SPEC.md §3): after unlocking an existing vault every
// event belongs to the default calendar, nothing is lost, a second run changes nothing,
// two default calendars end up as one, and calendar names/colors never reach the server
// in plain text.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;

const iso = (ms) => new Date(ms).toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const T = Date.parse('2026-11-12T12:00:00Z');
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  // --- 1. existing vault: old events without calendarId, one with an unknown id ---------
  const ev = (title, extra = {}) => ({
    type: 'agenda_event', version: 1, title, location: '', notes: '', color: 'green',
    start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z', all_day: false,
    rrule: '', reminders: [], updated_at: iso(T), ...extra,
  });
  const oldEvents = {
    a: ev('Tandarts'),
    b: ev('Kapper', { x_future: { keep: 1 } }),
    c: ev('Weg', { calendarId: 'calendar-that-does-not-exist' }),
  };
  const oldPack = { type: 'agenda_pack', version: 1, created_at: iso(T), updated_at: iso(T), events: oldEvents };
  const oldRow = await h.encryptedRow(PACK, oldPack, 100, 1001, { rev: 3 });
  h.server.pullPages = [{ items: [oldRow], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.get(PACK).content.calendars, undefined, 'sync alone does not migrate');

  // Lock and unlock again: the unlock maintenance runs the migration.
  h.stopPushTimer();
  NotesStore.lock();
  await NotesStore.unlock(h.PASSWORD, h.SALT, { kdfVersion: 1 });
  await NotesStore.loadLocal();
  await NotesStore.finishUnlockMaintenance();
  h.stopPushTimer();

  const migrated = NotesStore.get(PACK).content;
  assert.ok(migrated.calendars && migrated.calendars[DEF], 'default calendar created');
  assert.strictEqual(migrated.calendars[DEF].name, 'Agenda');
  assert.strictEqual(migrated.calendars[DEF].is_default, true);
  assert.deepStrictEqual(Object.keys(migrated.events).sort(), ['a', 'b', 'c'], 'no event lost');
  for (const [id, e] of Object.entries(migrated.events)) {
    assert.strictEqual(e.calendarId, DEF, `event ${id} belongs to the default calendar`);
    const { calendarId: _c, ...rest } = e;
    const { calendarId: _o, ...orig } = oldEvents[id];
    assert.deepStrictEqual(rest, orig, `event ${id} otherwise unchanged (incl. updated_at)`);
  }
  assert.ok(NotesStore.state.dirty.has(PACK), 'migration is queued for (encrypted) upload');

  // --- 2. idempotent: a second run gives the same result -------------------------------
  const snapshot = clone(NotesStore.get(PACK).content);
  assert.strictEqual(NotesStore.migrateAgendaCalendars(), false, 'second run writes nothing');
  assert.deepStrictEqual(NotesStore.get(PACK).content, snapshot, 'second run changes nothing');

  // --- 3. two default calendars after sync end up as one -------------------------------
  // a) Two clients that each created the default calendar (same fixed id).
  const defCal = (stamp, extra = {}) => ({
    type: 'agenda_calendar', version: 1, name: 'Agenda', color: 'blue', visible: true,
    order: 0, default_reminders: [], is_default: true, updated_at: iso(stamp), ...extra,
  });
  const devA = { type: 'agenda_pack', events: { a: { ...oldEvents.a, calendarId: DEF } }, calendars: { [DEF]: defCal(T + 1) } };
  const devB = { type: 'agenda_pack', events: { b: { ...oldEvents.b, calendarId: DEF } }, calendars: { [DEF]: defCal(T + 2) } };
  const m1 = NotesStore.mergeAgendaPacks(devA, devB, T + 10);
  const m1r = NotesStore.mergeAgendaPacks(devB, devA, T + 10);
  assert.deepStrictEqual(Object.keys(m1.calendars), [DEF], 'one default calendar');
  assert.deepStrictEqual(Object.keys(m1.events).sort(), ['a', 'b'], 'events of both clients kept');
  assert.deepStrictEqual(m1.calendars, m1r.calendars, 'same result in either order');

  // b) A client that created its default calendar under another id (spec safety net).
  const other = 'other-default-id';
  const devC = {
    type: 'agenda_pack',
    events: { c1: ev('Van C', { calendarId: other }), c2: ev('Ook van C', { calendarId: other }) },
    calendars: { [other]: defCal(T + 5, { name: 'Mijn agenda', color: 'teal' }) },
  };
  for (const [local, remote] of [[devA, devC], [devC, devA]]) {
    const m = NotesStore.mergeAgendaPacks(clone(local), clone(remote), T + 10);
    const defaults = Object.entries(m.calendars).filter(([, c]) => c.is_default);
    assert.deepStrictEqual(defaults.map(([id]) => id), [DEF], 'exactly one default calendar');
    assert.strictEqual(m.calendars[DEF].name, 'Mijn agenda', 'newest name wins');
    assert.strictEqual(m.calendars[DEF].color, 'teal', 'newest color wins');
    assert.ok(m.deleted_calendars[other], 'extra default id tombstoned');
    assert.deepStrictEqual(Object.keys(m.events).sort(), ['a', 'c1', 'c2'], 'no event lost');
    for (const e of Object.values(m.events)) assert.strictEqual(e.calendarId, DEF);
    // Merging again with the stale client does not bring the duplicate back.
    const again = NotesStore.mergeAgendaPacks(m, clone(devC), T + 20);
    assert.deepStrictEqual(Object.keys(again.calendars), [DEF]);
    assert.deepStrictEqual(Object.keys(again.events).sort(), ['a', 'c1', 'c2']);
  }

  // c) The same via a real sync conflict: this device folds the duplicate and uploads one.
  const remotePack = { ...snapshot, updated_at: iso(Date.now() - 1000), calendars: { ...snapshot.calendars, ...devC.calendars }, events: { ...snapshot.events, ...devC.events } };
  const remoteRow = await h.encryptedRow(PACK, remotePack, 300, 1003, { rev: 4 });
  h.resetServer();
  let finalPush = null;
  let conflicted = false;
  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    return items.map((row) => {
      if (row.item_uuid !== PACK) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
      if (!conflicted) {
        conflicted = true;
        return { item_uuid: PACK, status: 'conflict', rev: 4, server_item: remoteRow };
      }
      finalPush = row;
      return { item_uuid: PACK, status: 'ok', rev: 5 };
    });
  };
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(finalPush, 'merged pack was pushed');
  const merged = await h.decryptRow(finalPush);
  assert.deepStrictEqual(Object.keys(merged.calendars), [DEF], 'one default calendar after sync');
  assert.deepStrictEqual(Object.keys(merged.events).sort(), ['a', 'b', 'c', 'c1', 'c2'], 'no event lost in sync');
  for (const e of Object.values(merged.events)) assert.strictEqual(e.calendarId, DEF);

  // --- 4. the server never sees calendar name or color in plain text -------------------
  const wire = bodies.join('\n');
  assert.ok(wire.length > 0, 'something was sent');
  for (const secret of ['Mijn agenda', '"Agenda"', 'teal', '"blue"', 'calendarId', 'calendars', 'is_default', DEF, other]) {
    assert.ok(!wire.includes(secret), `server request must not contain ${secret} in plain text`);
  }
  h.stopPushTimer();

  console.log('agenda calendar migration ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
