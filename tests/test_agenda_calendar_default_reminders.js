// Default reminders per calendar (docs/design/calendar-multi.md §2.1 `default_reminders`): set in the
// calendar edit form (presets plus a custom value), stored in minutes inside the encrypted
// agenda_pack, kept by the push and by the per-calendar merge, and never sent in plain text.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');

const root = path.join(__dirname, '..');
// offsetMinutes() lives in agenda-reminders.js; the calendar module uses it to clean the values.
require(path.join(root, 'app/static/js/agenda-reminders.js'));
const Cals = require(path.join(root, 'app/static/js/agenda-calendars.js'));
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  await h.unlockFresh();
  Cals._setStore(NotesStore);

  // --- the edit form offers presets and a custom value -----------------------------------
  const src = fs.readFileSync(path.join(root, 'app/static/js/agenda-calendars.js'), 'utf8');
  assert.ok(/Default reminders for new events/.test(src), 'calendar form has a default reminders section');
  assert.ok(/name="default_reminder_custom"/.test(src), 'calendar form has a custom minutes field');
  assert.ok(/Reminders only work while Deeperguard is open in your browser/.test(src), 'form says reminders need the open app');

  // --- create and update keep default_reminders in minutes -------------------------------
  const id = Cals.createCalendar('Werk', 'teal', ['15', 'h1', '20', 'nonsense', -5]);
  assert.ok(id, 'calendar created');
  let cal = Cals.listCalendars().find((c) => c.id === id);
  assert.deepStrictEqual(cal.default_reminders, [15, 20, 60], 'presets, legacy keys and custom values become minutes');

  assert.strictEqual(Cals.updateCalendar(id, { name: 'Werk', color: 'teal', default_reminders: [0, 1440, 45] }), true);
  cal = Cals.listCalendars().find((c) => c.id === id);
  assert.deepStrictEqual(cal.default_reminders, [0, 45, 1440], 'edit replaces the defaults');

  Cals.updateCalendar(id, { name: 'Werk 2' });
  cal = Cals.listCalendars().find((c) => c.id === id);
  assert.deepStrictEqual(cal.default_reminders, [0, 45, 1440], 'a rename keeps the defaults');

  // --- push: encrypted, round-trips --------------------------------------------------------
  h.resetServer();
  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 9 }));
  };
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  const wire = bodies.join('\n');
  assert.ok(!wire.includes('default_reminders'), 'server never sees default_reminders in plain text');
  const sent = JSON.parse(bodies[bodies.length - 1]).items.find((r) => r.item_uuid === PACK);
  const pack = await h.decryptRow(sent);
  assert.deepStrictEqual(pack.calendars[id].default_reminders, [0, 45, 1440], 'decrypts back with the defaults');

  // --- merge: the newer copy of the calendar wins, with its defaults -----------------------
  const T = Date.parse('2026-11-20T09:00:00Z');
  const base = pack.calendars[id];
  const devA = { type: 'agenda_pack', events: {}, calendars: { [id]: { ...base, default_reminders: [5], updated_at: iso(T + 1) } } };
  const devB = { type: 'agenda_pack', events: {}, calendars: { [id]: { ...base, default_reminders: [10, 30], updated_at: iso(T + 2) } } };
  const merged = NotesStore.mergeAgendaPacks(devA, devB, T + 10);
  assert.deepStrictEqual(merged.calendars[id].default_reminders, [10, 30], 'merge keeps default_reminders of the newer copy');

  // --- the editor uses the calendar's defaults for new events ------------------------------
  assert.ok(/calendarDefaultReminders\(content\.calendarId\)/.test(agendaJs), 'new events start with the calendar defaults');
  assert.ok(/fillReminderOffsetsEditor\(\{ reminders: calendarDefaultReminders\(e\.target\.value\) \}\)/.test(agendaJs),
    'switching calendar on a new event applies that calendar\'s defaults');

  console.log('test_agenda_calendar_default_reminders ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
