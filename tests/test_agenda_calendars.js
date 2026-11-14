// Multiple calendars (docs/design/calendar-multi.md §2-§4, milestone M1): calendars live in
// the encrypted agenda_pack, events carry an optional calendarId, a missing calendarId means
// the default calendar, and the default calendar has a fixed id so two devices never
// create two of them.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;

const iso = (ms) => new Date(ms).toISOString();

(async () => {
  const T = Date.parse('2026-11-12T12:00:00Z');
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  // --- 1. old payload format: events without calendarId, pack without calendars -------
  const oldEvent = {
    type: 'agenda_event',
    version: 1,
    title: 'Tandarts',
    location: 'Utrecht',
    notes: '',
    color: 'green',
    start: '2026-11-20T09:00:00.000Z',
    end: '2026-11-20T10:00:00.000Z',
    all_day: false,
    rrule: '',
    reminders: ['m15'],
    updated_at: iso(T),
  };
  const oldPack = {
    type: 'agenda_pack',
    version: 1,
    created_at: iso(T),
    updated_at: iso(T),
    events: { old1: oldEvent },
  };
  const oldRow = await h.encryptedRow(PACK, oldPack, 100, 1001, { rev: 3 });
  h.server.pullPages = [{ items: [oldRow], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });

  const listed = NotesStore.listAgendaEvents();
  assert.strictEqual(listed.length, 1);
  assert.deepStrictEqual(listed[0], { id: 'old1', ...oldEvent }, 'old event is read unchanged');
  assert.strictEqual(NotesStore.agendaEventCalendarId(listed[0]), DEF, 'missing calendarId = default calendar');
  const cals0 = NotesStore.listAgendaCalendars();
  assert.deepStrictEqual(cals0.map((c) => c.id), [DEF], 'read-only view shows the default calendar');
  assert.ok(cals0[0].is_default);
  assert.strictEqual(NotesStore.get(PACK).content.calendars, undefined, 'reading does not write calendars');
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'reading an old pack uploads nothing');
  assert.strictEqual(
    NotesStore.agendaEventCalendarId({ ...oldEvent, calendarId: 'gone-calendar' }),
    DEF,
    'an event pointing at an unknown calendar shows in the default calendar',
  );

  // --- 2. two devices create the default calendar: exactly one ------------------------
  // The phone (other device) opened the agenda first and wrote the default calendar: rev 4.
  const phonePack = {
    ...oldPack,
    updated_at: iso(Date.now() - 1000),
    calendars: {
      [DEF]: {
        type: 'agenda_calendar', version: 1, name: 'Agenda', color: 'blue', visible: true,
        order: 0, default_reminders: [], is_default: true, updated_at: iso(Date.now() - 1000),
      },
    },
  };
  const phoneRow = await h.encryptedRow(PACK, phonePack, 300, 1003, { rev: 4 });
  h.resetServer();
  let finalPush = null;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== PACK) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    if (row.base_rev === 3) return { item_uuid: PACK, status: 'conflict', rev: 4, server_item: phoneRow };
    finalPush = row;
    return { item_uuid: PACK, status: 'ok', rev: 5 };
  });
  assert.strictEqual(NotesStore.ensureDefaultCalendar(), true, 'this device also creates it (still on rev 3)');
  assert.strictEqual(NotesStore.ensureDefaultCalendar(), false, 'idempotent: second call writes nothing');
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(finalPush, 'merged pack was pushed');
  const merged = await h.decryptRow(finalPush);
  assert.deepStrictEqual(Object.keys(merged.calendars), [DEF], 'exactly one default calendar after merge');
  assert.deepStrictEqual(NotesStore.listAgendaCalendars().filter((c) => c.is_default).map((c) => c.id), [DEF]);
  assert.strictEqual(NotesStore.ensureDefaultCalendar(), false, 'nothing to create after the merge');

  // Pure merge of two independently created packs gives one entry as well.
  const devA = { type: 'agenda_pack', events: {}, calendars: { [DEF]: { ...phonePack.calendars[DEF], updated_at: iso(T + 1) } } };
  const devB = { type: 'agenda_pack', events: {}, calendars: { [DEF]: { ...phonePack.calendars[DEF], updated_at: iso(T + 2) } } };
  const m = NotesStore.mergeAgendaPacks(devA, devB, T + 10);
  assert.deepStrictEqual(Object.keys(m.calendars), [DEF]);
  assert.strictEqual(m.calendars[DEF].updated_at, iso(T + 2), 'newest copy wins');

  // --- 3. calendar + calendarId round-trip, and nothing in plain text for the server ---
  h.resetServer();
  const pushedBodies = [];
  h.server.pushResponder = (items, body) => {
    pushedBodies.push(JSON.stringify(body));
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 6 }));
  };
  const workId = NotesStore.upsertAgendaCalendar('cal-werk-7f3a', {
    name: 'Werk Geheimnaam', color: 'teal', visible: true, order: 1, future_field: { keep: 1 },
  });
  assert.strictEqual(workId, 'cal-werk-7f3a');
  NotesStore.upsertAgendaEvent('ev-werk', {
    title: 'Overleg', start: '2026-11-21T11:00:00.000Z', end: '2026-11-21T12:00:00.000Z',
    all_day: false, calendarId: workId,
  });
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(pushedBodies.length >= 1, 'pack was sent to the server');
  const wire = pushedBodies.join('\n');
  for (const secret of ['Werk Geheimnaam', '"teal"', 'calendarId', 'cal-werk-7f3a', 'agenda_calendar', 'future_field']) {
    assert.ok(!wire.includes(secret), `server request must not contain ${secret} in plain text`);
  }
  const sentRow = JSON.parse(pushedBodies[pushedBodies.length - 1]).items.find((r) => r.item_uuid === PACK);
  const roundTrip = await h.decryptRow(sentRow);
  assert.strictEqual(roundTrip.calendars[workId].name, 'Werk Geheimnaam', 'decrypts back to the calendar');
  assert.strictEqual(roundTrip.calendars[workId].color, 'teal');
  assert.strictEqual(roundTrip.calendars[workId].visible, true);
  assert.strictEqual(roundTrip.calendars[workId].order, 1);
  assert.deepStrictEqual(roundTrip.calendars[workId].future_field, { keep: 1 });
  assert.strictEqual(roundTrip.events['ev-werk'].calendarId, workId);
  assert.ok(roundTrip.calendars[DEF], 'default calendar stays');

  // --- 4. unknown fields survive a save ---------------------------------------------
  const fromNewerApp = {
    ...oldEvent, title: 'Van nieuwere app', tz: 'Europe/Amsterdam', x_future: { a: [1, 2] }, calendarId: workId,
  };
  const newerPack = { ...NotesStore.get(PACK).content, events: { ...NotesStore.get(PACK).content.events, newer: fromNewerApp } };
  // An edit by this app spreads the stored row and changes only known fields.
  NotesStore.upsert(PACK, newerPack);
  const row = NotesStore.listAgendaEvents().find((e) => e.id === 'newer');
  const { id: _id, ...content } = row;
  NotesStore.upsertAgendaEvent('newer', { ...content, title: 'Bewerkt' });
  const saved = NotesStore.get(PACK).content.events.newer;
  assert.strictEqual(saved.title, 'Bewerkt');
  assert.deepStrictEqual(saved.x_future, { a: [1, 2] }, 'unknown event field kept');
  assert.strictEqual(saved.tz, 'Europe/Amsterdam');
  assert.strictEqual(saved.calendarId, workId);
  // Unknown pack fields and unknown calendar fields survive calendar edits too.
  NotesStore.upsert(PACK, { ...NotesStore.get(PACK).content, pack_future: 'x' });
  NotesStore.upsertAgendaCalendar(workId, { name: 'Werk' });
  const packNow = NotesStore.get(PACK).content;
  assert.strictEqual(packNow.pack_future, 'x', 'unknown pack field kept');
  assert.deepStrictEqual(packNow.calendars[workId].future_field, { keep: 1 }, 'unknown calendar field kept');
  assert.strictEqual(packNow.calendars[workId].color, 'teal');

  // --- 5. deleting a calendar: move or delete its events -----------------------------
  assert.strictEqual(NotesStore.removeAgendaCalendar(DEF, { mode: 'move' }).ok, false, 'default calendar cannot be deleted');
  assert.strictEqual(NotesStore.removeAgendaCalendar(workId).ok, false, 'a mode must be chosen (confirm dialog)');
  const moveRes = NotesStore.removeAgendaCalendar(workId, { mode: 'move' });
  assert.deepStrictEqual(moveRes, { ok: true, moved: 2, deletedEventIds: [] });
  const afterMove = NotesStore.get(PACK).content;
  assert.ok(!afterMove.calendars[workId] && afterMove.deleted_calendars[workId], 'calendar tombstoned');
  assert.strictEqual(afterMove.events['ev-werk'].calendarId, DEF, 'events moved to the default calendar');
  assert.strictEqual(afterMove.events.newer.x_future.a.length, 2, 'moving keeps unknown fields');
  assert.strictEqual(afterMove.events.old1.calendarId, undefined, 'events of other calendars are untouched');

  const famId = NotesStore.upsertAgendaCalendar('', { name: 'Familie', color: 'red', order: 2 });
  NotesStore.upsertAgendaEvent('ev-fam', {
    title: 'Verjaardag', start: '2026-12-01T09:00:00.000Z', end: '2026-12-01T10:00:00.000Z', all_day: false, calendarId: famId,
  });
  const delRes = NotesStore.removeAgendaCalendar(famId, { mode: 'delete' });
  assert.deepStrictEqual(delRes, { ok: true, moved: 0, deletedEventIds: ['ev-fam'] });
  const afterDel = NotesStore.get(PACK).content;
  assert.ok(!afterDel.events['ev-fam'] && afterDel.deleted_events['ev-fam'], 'event deleted with a tombstone');

  // A merge with a device that still has the deleted calendar does not bring it back.
  const stale = { ...afterDel, calendars: { ...afterDel.calendars, [famId]: { type: 'agenda_calendar', name: 'Familie', updated_at: iso(T) } }, deleted_calendars: {} };
  const m2 = NotesStore.mergeAgendaPacks(afterDel, stale, Date.now());
  assert.ok(!m2.calendars[famId], 'deleted calendar stays deleted after merge');
  assert.ok(m2.calendars[DEF], 'default calendar survives the merge');
  h.stopPushTimer();

  console.log('agenda calendars ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
