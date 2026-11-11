/**
 * Agenda date math: repeat expansion and month grid across clock changes, month-end
 * clipping, all-day series, long-running series, imported BYDAY rules.
 *
 * Runs the real client modules in child processes pinned to a timezone, because the
 * bugs only show where a local day is 23 or 25 hours long.
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const child = `
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const root = ${JSON.stringify(root)};
global.window = global;
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda']) {
  vm.runInThisContext(fs.readFileSync(root + '/app/static/js/' + f + '.js', 'utf8'));
}
const A = global.NotesAgenda;
const Occ = global.NotesAgendaOccurrence;
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const day = (d) => fmt(d).slice(0, 10);
const ev = (o) => ({ id: 'x', type: 'agenda_event', title: 't', all_day: false, rrule: '', ics_exdates: [], ics_occurrence_overrides: {}, ...o });
const timed = (y, m, d, rrule) => ev({ start: new Date(y, m, d, 9).toISOString(), end: new Date(y, m, d, 10).toISOString(), rrule });
const starts = (e, a, b) => A.expandEventOccurrences(e, a, b).map((o) => fmt(o.start));

// Month grids: strictly consecutive days, 7 per row, for every month of two years.
for (let y = 2026; y <= 2027; y += 1) {
  for (let m = 0; m < 12; m += 1) {
    A._state.view = 'month';
    A._state.anchor = new Date(y, m, 15);
    const days = A.rangeForView().days;
    assert.strictEqual(days.length % 7, 0, 'month grid rows ' + y + '-' + (m + 1));
    assert.strictEqual(days[0].getDay(), 1, 'month grid starts Monday ' + y + '-' + (m + 1));
    for (let i = 1; i < days.length; i += 1) {
      const expect = new Date(days[i - 1].getFullYear(), days[i - 1].getMonth(), days[i - 1].getDate() + 1);
      assert.strictEqual(day(days[i]), day(expect), 'month grid day ' + i + ' of ' + y + '-' + (m + 1));
      assert.strictEqual(days[i].getHours(), 0, 'month grid cell at midnight ' + y + '-' + (m + 1));
    }
  }
}
A._state.view = 'agenda';
A._state.anchor = new Date(2026, 9, 20);
assert.deepStrictEqual(A.rangeForView().days.map(day).slice(4, 8), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);

// Weekly and daily keep their wall-clock time across both clock changes.
for (const [y, m, d] of [[2026, 9, 12], [2026, 2, 2], [2027, 2, 1]]) {
  for (const rule of ['FREQ=WEEKLY;INTERVAL=1', 'FREQ=DAILY;INTERVAL=1']) {
    const got = A.expandEventOccurrences(timed(y, m, d, rule), new Date(y, m, d), new Date(y, m, d + 42));
    assert.ok(got.length >= 6, rule + ' count');
    got.forEach((o) => {
      assert.strictEqual(o.start.getHours(), 9, rule + ' start hour ' + fmt(o.start));
      assert.strictEqual(o.end.getTime() - o.start.getTime(), 3600000, rule + ' duration');
    });
  }
}

// Monthly on the 31st clips per month and returns to the 31st.
assert.deepStrictEqual(
  starts(timed(2026, 0, 31, 'FREQ=MONTHLY;INTERVAL=1'), new Date(2026, 0, 1), new Date(2026, 5, 1)).map((x) => x.slice(0, 10)),
  ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
);
// Yearly on 29 Feb uses 28 Feb in common years and 29 Feb in leap years.
assert.deepStrictEqual(
  starts(timed(2024, 1, 29, 'FREQ=YEARLY;INTERVAL=1'), new Date(2024, 0, 1), new Date(2029, 0, 1)).map((x) => x.slice(0, 10)),
  ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'],
);

// All-day series repeat (yearly birthday, weekly), including multi-day spans.
const birthday = ev({ all_day: true, start: new Date(2025, 10, 11).toISOString(), end: new Date(2025, 10, 12).toISOString(), rrule: 'FREQ=YEARLY;INTERVAL=1' });
assert.deepStrictEqual(starts(birthday, new Date(2026, 10, 1), new Date(2026, 11, 1)), ['2026-11-11 00:00']);
const weeklyAllDay = ev({ all_day: true, start: new Date(2026, 9, 19).toISOString(), end: new Date(2026, 9, 20).toISOString(), rrule: 'FREQ=WEEKLY;INTERVAL=1' });
assert.deepStrictEqual(starts(weeklyAllDay, new Date(2026, 9, 26), new Date(2026, 10, 9)), ['2026-10-26 00:00', '2026-11-02 00:00']);
const twoDays = ev({ all_day: true, start: new Date(2025, 11, 25).toISOString(), end: new Date(2025, 11, 27).toISOString(), rrule: 'FREQ=YEARLY' });
const hit = A.expandEventOccurrences(twoDays, new Date(2026, 11, 26), new Date(2026, 11, 27));
assert.strictEqual(hit.length, 1);
assert.strictEqual(day(hit[0].start), '2026-12-25');
assert.strictEqual(day(hit[0].end), '2026-12-27');

// A daily series older than 400 days is still shown.
assert.deepStrictEqual(
  starts(timed(2025, 5, 1, 'FREQ=DAILY;INTERVAL=1'), new Date(2026, 10, 9), new Date(2026, 10, 11)),
  ['2026-11-09 09:00', '2026-11-10 09:00'],
);

// Imported rules.
assert.deepStrictEqual(
  starts(timed(2026, 10, 2, 'FREQ=WEEKLY;BYDAY=MO,WE,FR'), new Date(2026, 10, 2), new Date(2026, 10, 9)).map((x) => x.slice(0, 10)),
  ['2026-11-02', '2026-11-04', '2026-11-06'],
);
assert.deepStrictEqual(
  starts(timed(2026, 8, 8, 'FREQ=MONTHLY;BYDAY=2TU'), new Date(2026, 8, 1), new Date(2026, 11, 31)).map((x) => x.slice(0, 10)),
  ['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08'],
);
assert.deepStrictEqual(
  starts(timed(2026, 8, 25, 'FREQ=MONTHLY;BYDAY=-1FR'), new Date(2026, 8, 1), new Date(2026, 11, 1)).map((x) => x.slice(0, 10)),
  ['2026-09-25', '2026-10-30', '2026-11-27'],
);
assert.deepStrictEqual(
  starts(timed(2026, 10, 2, 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5'), new Date(2026, 10, 1), new Date(2027, 0, 1)).map((x) => x.slice(0, 10)),
  ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16'],
);
assert.deepStrictEqual(
  starts(timed(2026, 10, 2, 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261201T235959Z'), new Date(2026, 10, 1), new Date(2027, 0, 1)).map((x) => x.slice(0, 10)),
  ['2026-11-02', '2026-11-16', '2026-11-30'],
);
// A rule the expander does not implement shows its first date only, flagged, never wrong dates.
const odd = A.expandEventOccurrences(timed(2026, 10, 2, 'FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1'), new Date(2026, 10, 1), new Date(2027, 5, 1));
assert.strictEqual(odd.length, 1);
assert.strictEqual(odd[0].partial, true);

// Edits stored by older clients (keyed by the fixed-24h instant) still apply after a clock change.
const base = timed(2026, 9, 12, 'FREQ=WEEKLY;INTERVAL=1');
const legacyInstant = new Date(new Date(2026, 9, 12, 9).getTime() + 14 * 86400000);
const legacyRid = Occ.recurrenceIdForStart(legacyInstant, false);
const edited = A.expandEventOccurrences({ ...base, ics_occurrence_overrides: { [legacyRid]: { title: 'EDITED' } } }, new Date(2026, 9, 26), new Date(2026, 9, 27));
assert.strictEqual(edited.length, 1);
assert.strictEqual(edited[0].displayTitle, 'EDITED');
assert.strictEqual(fmt(edited[0].start), '2026-10-26 09:00');
const removed = starts({ ...base, ics_exdates: [legacyRid] }, new Date(2026, 9, 19), new Date(2026, 10, 3));
assert.deepStrictEqual(removed, ['2026-10-19 09:00', '2026-11-02 09:00']);

// Month navigation clips the day instead of skipping a month.
const R = global.NotesAgendaRecurrence;
assert.strictEqual(day(R.addCalendarMonths(new Date(2026, 0, 31, 9), 1)), '2026-02-28');
`;

for (const tz of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'UTC']) {
  const run = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  assert.strictEqual(run.status, 0, `agenda dates failed in ${tz}:\n${run.stderr}`);
}

console.log('agenda dates dst ok');
