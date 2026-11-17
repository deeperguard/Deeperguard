// Default-calendar migration and duplicate-default folding (docs/CALENDARS_SPEC.md §3, §7).
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;
const iso = (ms) => new Date(ms).toISOString();

function ev(title, extra) {
  return {
    type: 'agenda_event', version: 1, title, start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z',
    all_day: false, updated_at: iso(Date.parse('2026-11-01T00:00:00Z')), ...extra,
  };
}
const cal = (name, color, at) => ({
  type: 'agenda_calendar', version: 1, name, color, visible: true, order: 0, default_reminders: [],
  is_default: true, updated_at: iso(at),
});

(async () => {
  const T = Date.parse('2026-11-12T12:00:00Z');
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();

  const pack = {
    type: 'agenda_pack', version: 1, created_at: iso(T), updated_at: iso(T),
    events: { a: ev('A'), b: ev('B', { calendarId: 'nope' }), c: ev('C', { calendarId: 'gone' }) },
    deleted_calendars: { gone: iso(T) },
  };
  const row = await h.encryptedRow(PACK, pack, 100, 1001, { rev: 3 });
  h.server.pullPages = [{ items: [row], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });

  assert.strictEqual(NotesStore.ensureDefaultCalendar(), true);
  const afterFirst = JSON.stringify(NotesStore.get(PACK).content);
  assert.strictEqual(NotesStore.ensureDefaultCalendar(), false);
  assert.strictEqual(JSON.stringify(NotesStore.get(PACK).content), afterFirst, 'second run changes nothing');
  const content = NotesStore.get(PACK).content;
  assert.strictEqual(content.calendars[DEF].name, 'Agenda');
  assert.strictEqual(content.calendars[DEF].is_default, true);
  const events = NotesStore.listAgendaEvents();
  assert.deepStrictEqual(events.map((e) => e.id).sort(), ['a', 'b', 'c'], 'no event lost');
  for (const e of events) assert.strictEqual(NotesStore.agendaEventCalendarId(e), DEF);
  assert.strictEqual(content.events.b.calendarId, 'nope', 'unknown id is kept, not erased');

  const other = 'other-default-id';
  const devA = {
    type: 'agenda_pack', events: { x: ev('X', { calendarId: other }), y: ev('Y') },
    calendars: { [other]: cal('Hoofdagenda', 'red', T + 5000) },
  };
  const devB = {
    type: 'agenda_pack', events: { z: ev('Z') },
    calendars: { [DEF]: cal('Agenda', 'blue', T + 1000) },
  };
  const m1 = NotesStore.mergeAgendaPacks(devA, devB, T + 9000);
  const m2 = NotesStore.mergeAgendaPacks(devB, devA, T + 9000);
  for (const m of [m1, m2]) {
    assert.deepStrictEqual(Object.keys(m.calendars), [DEF], 'exactly one default calendar');
    assert.strictEqual(m.calendars[DEF].name, 'Hoofdagenda', 'newest default supplies name');
    assert.strictEqual(m.calendars[DEF].color, 'red');
    assert.strictEqual(m.events.x.calendarId, DEF, 'events move to the surviving default');
    assert.deepStrictEqual(Object.keys(m.events).sort(), ['x', 'y', 'z'], 'no event lost');
    assert.ok(m.deleted_calendars[other], 'extra id is tombstoned');
  }
  const later = NotesStore.mergeAgendaPacks(devA, devB, T + 500000);
  const bytes = (m) => JSON.stringify([m.calendars, m.events, m.deleted_calendars]);
  assert.strictEqual(bytes(later), bytes(m1), 'same packs fold to the same bytes on any device clock');
  assert.strictEqual(m1.deleted_calendars[other], iso(T + 5000), 'tombstone uses the newest default stamp');
  const m3 = NotesStore.mergeAgendaPacks(m1, devA, T + 10000);
  assert.deepStrictEqual(Object.keys(m3.calendars), [DEF]);
  assert.strictEqual(NotesStore.mergeAgendaPacks(m1, m1, T + 10000).calendars[DEF].name, 'Hoofdagenda', 'folded pack is stable');

  const lone = { events: { q: ev('Q', { calendarId: other }) }, calendars: { [other]: cal('Mijn', 'teal', T) } };
  const m4 = NotesStore.mergeAgendaPacks(lone, { events: {} }, T + 1);
  assert.deepStrictEqual(Object.keys(m4.calendars), [DEF]);
  assert.strictEqual(m4.calendars[DEF].name, 'Mijn');
  assert.strictEqual(m4.events.q.calendarId, DEF);

  // A device with the extra default calendar syncs against the server: the merged pack that
  // leaves the device is folded, and the server receives only ciphertext.
  const remotePack = {
    type: 'agenda_pack', version: 1, created_at: iso(T), updated_at: iso(T),
    events: { z: ev('Z') }, calendars: { [DEF]: cal('Agenda', 'blue', T + 1000) },
  };
  const remoteRow = await h.encryptedRow(PACK, remotePack, T + 1000, T + 1000, { rev: 4 });
  h.resetServer();
  let finalPush = null;
  h.server.pushResponder = (items) => items.map((row) => {
    if (row.item_uuid !== PACK) return { item_uuid: row.item_uuid, status: 'ok', rev: 1 };
    if (row.base_rev === 3) return { item_uuid: PACK, status: 'conflict', rev: 4, server_item: remoteRow };
    finalPush = row;
    return { item_uuid: PACK, status: 'ok', rev: 5 };
  });
  NotesStore.upsert(PACK, { ...devA, type: 'agenda_pack', created_at: iso(T), updated_at: iso(T) });
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(finalPush, 'merged pack was pushed');
  assert.ok(!finalPush.ciphertext.includes('Hoofdagenda'), 'calendar name is not sent in clear');
  assert.ok(!finalPush.ciphertext.includes('"red"'), 'calendar colour is not sent in clear');
  const sentPack = await h.decryptRow(finalPush);
  assert.strictEqual(sentPack.calendars[DEF].name, 'Hoofdagenda', 'the pushed ciphertext carries the folded default');
  assert.ok(!sentPack.calendars[other], 'the extra default is not pushed');

  h.stopPushTimer();
  console.log('default calendar fold ok');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
