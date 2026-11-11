/**
 * Agenda reminders: payload shape, shared repeat expansion, stable ids, retry queue.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Minimal browser surface for the client modules.
const storage = new Map();
global.window = global;
global.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda-reminders', 'agenda']) {
  vm.runInThisContext(read(`app/static/js/${f}.js`), { filename: `${f}.js` });
}
const R = global.NotesAgendaReminders;
const Occ = global.NotesAgendaOccurrence;
const appHtml = read('app/templates/app.html');
const appPy = read('app/app.py');
const cron = read('app/agenda_reminder_cron.py');
const remindersJs = read('app/static/js/agenda-reminders.js');
const agendaJs = read('app/static/js/agenda.js');

assert.ok(R);
assert.ok(appHtml.includes("asset_script('js/agenda-reminders.js')"));
assert.ok(appHtml.includes('agenda-reminder-channel-settings'));
assert.ok(appHtml.includes('id="agenda-edit-reminders-hint"'));
assert.ok(remindersJs.includes("Push isn't available yet."));
assert.ok(!remindersJs.includes('VAPID keys required'));
// One expander: reminders must not carry their own repeat-rule stepping.
assert.ok(!/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(remindersJs));
assert.ok(!remindersJs.includes('_testExpand'));
assert.ok(!remindersJs.includes("setItem('agenda_reminder_bindings_v1'"));
assert.ok(agendaJs.includes('expandEventOccurrences,'));

const HOUR = 3600000;
const DAY = 86400000;
const now = new Date(2026, 10, 11, 8, 0, 0).getTime();
const at = (d, h) => new Date(2026, 10, d, h, 0, 0);
const base = (o) => ({
  id: 'ev-1',
  type: 'agenda_event',
  title: 'Private title',
  location: 'Private place',
  notes: 'Private notes',
  all_day: false,
  ics_exdates: [],
  ics_occurrence_overrides: {},
  ...o,
});
const fireTimes = (rows) => rows.map((r) => new Date(r.fire_at * 1000));
const days = (rows) => fireTimes(rows).map((d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);

(async () => {
  // Payload: only the allowed keys, never event content.
  const weekly = base({ start: at(12, 9).toISOString(), end: at(12, 10).toISOString(), rrule: 'FREQ=WEEKLY;INTERVAL=1', reminders: ['m15', 'h1'] });
  const planned = await R.planReminders(weekly, ['email', 'push'], now);
  assert.ok(planned.length >= 4);
  R.publicUploadRows(planned).forEach((row) => {
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(row.fire_at > now / 1000);
    assert.ok(['email', 'push'].includes(row.channel));
    assert.ok(Object.keys(row).every((k) => R.ALLOWED_UPLOAD_KEYS.has(k)));
    assert.match(row.local_time_label, /^\d{2}:\d{2}$/);
    assert.ok(!JSON.stringify(row).includes('Private'));
    assert.ok(!JSON.stringify(row).includes('ev-1'));
  });

  // Ids are stable across calls (and so across devices) and unique within a plan.
  const again = await R.planReminders(weekly, ['email', 'push'], now + 5000);
  assert.deepStrictEqual(again.map((r) => r.id), planned.map((r) => r.id));
  assert.strictEqual(new Set(planned.map((r) => r.id)).size, planned.length);
  const other = await R.planReminders({ ...weekly, id: 'ev-2' }, ['email', 'push'], now);
  assert.ok(!other.some((r) => planned.some((p) => p.id === r.id)));

  // Every 2 weeks reminds every 2 weeks, not weekly.
  const biweekly = base({ start: at(12, 9).toISOString(), end: at(12, 10).toISOString(), rrule: 'FREQ=WEEKLY;INTERVAL=2', reminders: ['at_start'] });
  assert.deepStrictEqual(days(R.computePlannedReminders(biweekly, ['email'], now)).slice(0, 3), ['11/12 9:00', '11/26 9:00', '12/10 9:00']);

  // UNTIL and COUNT end the reminders with the series.
  const until = base({ start: at(12, 9).toISOString(), end: at(12, 10).toISOString(), rrule: 'FREQ=WEEKLY;INTERVAL=1;UNTIL=20261120T235959Z', reminders: ['at_start'] });
  assert.deepStrictEqual(days(R.computePlannedReminders(until, ['email'], now)), ['11/12 9:00', '11/19 9:00']);
  const count = base({ start: at(12, 9).toISOString(), end: at(12, 10).toISOString(), rrule: 'FREQ=DAILY;COUNT=3', reminders: ['at_start'] });
  assert.strictEqual(R.computePlannedReminders(count, ['email'], now).length, 3);

  // A deleted occurrence does not remind; a moved one reminds at its new time.
  const ridSecond = Occ.recurrenceIdForStart(at(19, 9), false);
  const ridThird = Occ.recurrenceIdForStart(at(26, 9), false);
  const edited = base({
    start: at(12, 9).toISOString(),
    end: at(12, 10).toISOString(),
    rrule: 'FREQ=WEEKLY;INTERVAL=1',
    reminders: ['at_start'],
    ics_exdates: [ridSecond, ridThird],
    ics_occurrence_overrides: { [ridThird]: { start: at(27, 15).toISOString(), end: at(27, 16).toISOString() } },
  });
  const editedPlan = R.computePlannedReminders(edited, ['email'], now);
  assert.deepStrictEqual(days(editedPlan).slice(0, 3), ['11/12 9:00', '11/27 15:00', '12/3 9:00']);
  assert.strictEqual(editedPlan[1].local_time_label, '15:00');
  // The moved occurrence keeps the id of its slot, so the server row is updated, not duplicated.
  const plainPlan = await R.planReminders({ ...edited, ics_exdates: [], ics_occurrence_overrides: {} }, ['email'], now);
  const movedPlan = await R.planReminders(edited, ['email'], now);
  assert.strictEqual(movedPlan[1].id, plainPlan[2].id);

  // Planning window: only the coming weeks, and a cap per event.
  const daily = base({ start: at(12, 9).toISOString(), end: at(12, 10).toISOString(), rrule: 'FREQ=DAILY;INTERVAL=1', reminders: ['at_start', 'm15', 'h1', 'd1'] });
  const dailyPlan = R.computePlannedReminders(daily, ['email', 'push'], now);
  assert.ok(dailyPlan.length <= 150);
  assert.ok(Math.max(...dailyPlan.map((r) => r.fire_at * 1000)) <= now + R.PLAN_HORIZON_DAYS * DAY);

  // No channel switched on: nothing is planned, and the editor says why.
  assert.deepStrictEqual(R.computePlannedReminders(weekly, [], now), []);
  storage.clear();
  assert.ok(R.editorHint().includes('Calendar settings'));
  storage.set('deeperguard-prefs', JSON.stringify({ agenda_reminder_email: true }));
  assert.strictEqual(R.editorHint(), '');

  // All-day events remind relative to local midnight and carry no clock label.
  const allDay = base({ all_day: true, start: new Date(2026, 10, 14).toISOString(), end: new Date(2026, 10, 15).toISOString(), reminders: ['d1'] });
  const allDayPlan = R.computePlannedReminders(allDay, ['email'], now);
  assert.deepStrictEqual(days(allDayPlan), ['11/13 0:00']);
  assert.strictEqual(allDayPlan[0].local_time_label, '');

  // Sync: uploads the plan, deletes stale ids, stores the new ids once; a failure is queued and retried.
  const calls = [];
  let failNext = false;
  let stored = { ...weekly, id: 'ev-1', reminders: ['at_start'], scheduled_reminder_ids: [{ id: '11111111-1111-4111-8111-111111111111', channel: 'email', fire_at: 1 }] };
  let upserts = 0;
  global.NotesStore = {
    isUnlocked: () => true,
    listAgendaEvents: () => (stored ? [stored] : []),
    upsertAgendaEvent: (id, content) => { upserts += 1; stored = { ...content, id }; },
    api: async (url, opts) => {
      if (url.endsWith('/push-config')) return { push_ready: false, email_ready: true, vapid_public_key: '' };
      if (failNext) { failNext = false; throw new Error('offline'); }
      calls.push(JSON.parse(opts.body));
      return { ok: true };
    },
  };
  storage.set('deeperguard-prefs', JSON.stringify({ agenda_reminder_email: true, agenda_reminder_push: true }));
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await R.syncEventReminders('ev-1');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].reminders.length >= 2);
    assert.ok(calls[0].reminders.every((r) => r.channel === 'email'), 'push is not uploaded while the server cannot send it');
    assert.deepStrictEqual(calls[0].delete_ids, ['11111111-1111-4111-8111-111111111111']);
    assert.strictEqual(upserts, 1);
    assert.strictEqual(stored.scheduled_reminder_ids.length, calls[0].reminders.length);

    await R.syncEventReminders('ev-1');
    assert.strictEqual(upserts, 1, 'unchanged plan does not rewrite the vault');
    assert.deepStrictEqual(calls[1].delete_ids, []);

    failNext = true;
    await assert.rejects(R.syncEventReminders('ev-1'));
    assert.deepStrictEqual(JSON.parse(storage.get('agenda_reminder_pending_v1')).events, ['ev-1']);
    const before = calls.length;
    await R.flushPending();
    assert.strictEqual(calls.length, before + 1);
    assert.ok(!storage.has('agenda_reminder_pending_v1'));

    // Deleting the event removes its reminders; if that fails the ids are queued.
    failNext = true;
    const doomed = stored;
    stored = null;
    await assert.rejects(R.cancelEventReminders('ev-1', doomed));
    assert.strictEqual(JSON.parse(storage.get('agenda_reminder_pending_v1')).deletes.length, doomed.scheduled_reminder_ids.length);
    await R.flushPending();
    assert.deepStrictEqual(calls[calls.length - 1].delete_ids.sort(), doomed.scheduled_reminder_ids.map((x) => x.id).sort());
    assert.ok(!storage.has('agenda_reminder_pending_v1'));
  } finally {
    Date.now = realNow;
  }

  const body = R.genericBody('14:00');
  assert.ok(body.includes('14:00'));
  assert.ok(!body.includes('Team sync'));

  assert.ok(appPy.includes('AGENDA_REMINDER_ALLOWED_KEYS'));
  assert.ok(appPy.includes('plaintext event fields forbidden'));
  assert.ok(cron.includes('You have an upcoming event'));
  assert.ok(cron.includes('Turn off agenda email reminders'));
  assert.ok(cron.includes('expire_overdue_agenda_reminders'));
  assert.ok(agendaJs.includes('syncRemindersAfterSave(state.selectedId);'), 'occurrence delete updates reminders');

  console.log('test_agenda_reminders ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
