// Assigning events to a calendar, hiding/showing calendars,
// and reminders of events in a hidden calendar. Behaviour only: real store, real modules.
const assert = require('assert');
const path = require('path');
const h = require('./sync_harness');
const Cals = require('../app/static/js/agenda-calendars.js');
require(path.join(__dirname, '..', 'app/static/js/agenda-reminders.js'));

const { NotesStore } = h;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;
const ev = (id) => NotesStore.listAgendaEvents().find((e) => e.id === id);

(async () => {
  await h.unlockFresh();
  Cals._setStore(NotesStore);
  const soon = Date.now() + 3 * 86400000;
  const start = new Date(soon).toISOString();
  const end = new Date(soon + 3600000).toISOString();
  const base = { type: 'agenda_event', version: 1, title: 'Overleg', start, end, all_day: false, rrule: '', reminders: [15] };

  // --- assign to a calendar --------------------------------------------------------------
  assert.strictEqual(Cals.lastUsedCalendarId(NotesStore.listAgendaEvents()), '', 'no events: default calendar applies');
  const work = Cals.createCalendar('Werk', 'teal');
  NotesStore.upsertAgendaEvent('e-def', base);
  NotesStore.upsertAgendaEvent('e-work', { ...base, calendarId: work });
  assert.strictEqual(NotesStore.agendaEventCalendarId(ev('e-work')), work);
  assert.strictEqual(NotesStore.agendaEventCalendarId(ev('e-def')), DEF, 'no calendarId = default calendar');
  assert.ok(Cals.labelHtml(Cals.calendarForEvent(ev('e-work'))).includes('>Werk</span>'), 'name is shown');
  assert.strictEqual(Cals.lastUsedCalendarId(NotesStore.listAgendaEvents()), work, 'last saved calendar is the next default');
  assert.strictEqual(Cals.lastUsedCalendarId([{ id: 'x', calendarId: 'gone', updated_at: '2999-01-01' }]), '',
    'a deleted calendar is never offered');

  // --- hide and show: same data back ------------------------------------------------------
  const before = JSON.stringify(ev('e-work'));
  assert.ok(Cals.setCalendarVisible(work, false));
  assert.strictEqual(Cals.lastUsedCalendarId(NotesStore.listAgendaEvents()), '',
    'a hidden calendar is not the default for a new event');
  assert.strictEqual(Cals.lastUsedCalendarId([
    { id: 'a', calendarId: DEF, updated_at: '2999-01-01' },
    { id: 'b', calendarId: work, updated_at: '2999-06-01' },
  ]), DEF, 'the last saved visible calendar is used instead of a hidden one');
  const map = Cals.calendarMap();
  const shown = NotesStore.listAgendaEvents().filter((e) => Cals.isEventVisible(e, map)).map((e) => e.id);
  assert.deepStrictEqual(shown, ['e-def'], 'events of the hidden calendar are not drawn');
  assert.ok(ev('e-work'), 'hidden events are not deleted');
  const hiddenRow = Cals.renderHtml();
  assert.ok(hiddenRow.includes(', hidden</span>'), 'settings list shows hidden state in text too');
  Cals.setCalendarVisible(work, false);
  assert.strictEqual(Cals.calendarMap().get(work).visible, false, 'hiding twice stays hidden');
  assert.ok(Cals.setCalendarVisible(work, true));
  assert.strictEqual(Cals.lastUsedCalendarId(NotesStore.listAgendaEvents()), work, 'shown again: it is the default again');
  const map2 = Cals.calendarMap();
  assert.deepStrictEqual(
    NotesStore.listAgendaEvents().filter((e) => Cals.isEventVisible(e, map2)).map((e) => e.id).sort(),
    ['e-def', 'e-work'],
  );
  assert.strictEqual(JSON.stringify(ev('e-work')), before, 'event is unchanged after hide/show');

  // --- reminders of a hidden calendar stay -------------------------------------------------
  const R = global.NotesAgendaReminders;
  const now = Date.now();
  const planned = () => R.computePlannedReminders(ev('e-work'), ['push'], now).length;
  assert.ok(planned() > 0, 'reminder is planned while visible');
  Cals.setCalendarVisible(work, false);
  assert.deepStrictEqual(ev('e-work').reminders, [15], 'reminder offsets are kept');
  assert.ok(planned() > 0, 'reminder is still planned while the calendar is hidden');
  assert.ok(NotesStore.listAgendaEvents().filter((e) => R.offsetMinutes(e.reminders).length).some((e) => e.id === 'e-work'),
    'reminder top-up still sees the hidden event');
  console.log('agenda calendar visibility ok');
})().catch((e) => { console.error(e); process.exit(1); });
