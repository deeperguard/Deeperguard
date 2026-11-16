// Calendar name, color and visibility are stored in the encrypted agenda_pack, so they must
// survive locking and unlocking the vault, and the default calendar cannot be deleted.
const assert = require('assert');
const h = require('./sync_harness');
const Cals = require('../app/static/js/agenda-calendars.js');

const { NotesStore } = h;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;

(async () => {
  await h.unlockFresh();
  Cals._setStore(NotesStore);

  const id = Cals.createCalendar('Werk', 'teal');
  assert.ok(id);
  assert.ok(Cals.renameCalendar(id, 'Kantoor'));
  assert.ok(Cals.setCalendarColor(id, 'purple'));
  assert.ok(Cals.setCalendarVisible(id, false));
  NotesStore.upsertAgendaEvent('e1', {
    type: 'agenda_event', version: 1, title: 'Overleg', start: '2026-11-20T09:00:00.000Z',
    end: '2026-11-20T10:00:00.000Z', all_day: false, rrule: '', calendarId: id,
  });

  await NotesStore.flush();
  await h.waitFor(() => h.idb.has(NotesStore.AGENDA_PACK_UUID), 'pack persisted');
  NotesStore.lock();
  assert.ok(!NotesStore.isUnlocked(), 'vault is locked');
  await h.unlockFresh();
  await NotesStore.loadLocal({});

  const cal = Cals.listCalendars().find((c) => c.id === id);
  assert.ok(cal, 'calendar survives lock/unlock');
  assert.strictEqual(cal.name, 'Kantoor');
  assert.strictEqual(cal.color, 'purple');
  assert.strictEqual(cal.visible, false);

  assert.ok(!Cals.deleteCalendar(DEF, 'move').ok, 'default calendar cannot be deleted');
  assert.ok(Cals.deleteCalendar(id, 'move').ok);
  const found = NotesStore.listAgendaEvents().find((e) => e.id === 'e1' || e.uuid === 'e1');
  assert.ok(found, 'event kept');
  assert.strictEqual(NotesStore.agendaEventCalendarId(found.content || found), DEF);
  assert.ok(!Cals.listCalendars().some((c) => c.id === id));

  console.log('agenda calendars relock ok');
})().catch((e) => { console.error(e); process.exit(1); });
