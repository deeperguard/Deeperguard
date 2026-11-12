/**
 * Export: repeating timed events (and edited occurrences) are written as local time with
 * TZID + VTIMEZONE so they keep their hour across clock changes in other calendar apps;
 * one-off timed events stay UTC. Import of our own export returns the same instants.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const icsPath = path.join(__dirname, '..', 'app/static/js/agenda-ics.js');

function script() {
  return `
    const fs = require('fs');
    const vm = require('vm');
    const assert = require('assert');
    vm.runInThisContext(fs.readFileSync(${JSON.stringify(icsPath)}, 'utf8'));
    const Ics = global.NotesAgendaIcs;
    const unfold = (t) => t.replace(/\\r\\n[ \\t]/g, '');

    const weekly = (extra) => Object.assign({
      id: 'w', ical_uid: 'weekly-1', title: 'Standup', all_day: false, rrule: 'FREQ=WEEKLY',
      start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T08:30:00.000Z', // 09:00 Amsterdam
    }, extra || {});
    const once = { id: 'o', ical_uid: 'once-1', title: 'Once', all_day: false,
      start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T09:00:00.000Z' };

    // --- Amsterdam: TZID wall time, VTIMEZONE with last-Sunday rules ---------------------------
    let cal = unfold(Ics.buildIcsCalendarFromEvents([weekly({ ics_exdates: ['20261112T080000Z'] }), once], { timeZone: 'Europe/Amsterdam' }));
    assert.ok(cal.includes('DTSTART;TZID=Europe/Amsterdam:20261105T090000'));
    assert.ok(cal.includes('DTEND;TZID=Europe/Amsterdam:20261105T093000'));
    assert.ok(cal.includes('EXDATE;TZID=Europe/Amsterdam:20261112T090000'));
    assert.ok(cal.includes('DTSTART:20261105T080000Z'), 'one-off events stay UTC');
    assert.ok(cal.indexOf('BEGIN:VTIMEZONE') > 0 && cal.indexOf('BEGIN:VTIMEZONE') < cal.indexOf('BEGIN:VEVENT'), 'VTIMEZONE comes before the events');
    assert.ok(cal.includes('TZID:Europe/Amsterdam'));
    assert.ok(cal.includes('BEGIN:DAYLIGHT') && cal.includes('BEGIN:STANDARD'));
    assert.ok(cal.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU'));
    assert.ok(cal.includes('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU'));
    assert.ok(cal.includes('TZOFFSETFROM:+0100') && cal.includes('TZOFFSETTO:+0200'));
    assert.strictEqual((cal.match(/BEGIN:VTIMEZONE/g) || []).length, 1);

    // --- New York and Sydney rules --------------------------------------------------------------
    cal = unfold(Ics.buildIcsCalendarFromEvents([weekly()], { timeZone: 'America/New_York' }));
    assert.ok(cal.includes('DTSTART;TZID=America/New_York:20261105T030000'));
    assert.ok(cal.includes('BYMONTH=3;BYDAY=2SU') && cal.includes('BYMONTH=11;BYDAY=1SU'));
    cal = unfold(Ics.buildIcsCalendarFromEvents([weekly()], { timeZone: 'Australia/Sydney' }));
    assert.ok(cal.includes('BYMONTH=10;BYDAY=1SU') && cal.includes('BYMONTH=4;BYDAY=1SU'));

    // --- zones without clock changes get one fixed observance ------------------------------------
    cal = unfold(Ics.buildIcsCalendarFromEvents([weekly()], { timeZone: 'Asia/Tokyo' }));
    assert.ok(cal.includes('DTSTART;TZID=Asia/Tokyo:20261105T170000'));
    assert.ok(cal.includes('TZOFFSETFROM:+0900') && cal.includes('TZOFFSETTO:+0900'));
    assert.ok(!cal.includes('BEGIN:DAYLIGHT'));

    // --- UTC / unknown zone: the old UTC export ------------------------------------------------
    for (const z of ['UTC', 'Mars/Olympus', '']) {
      cal = unfold(Ics.buildIcsCalendarFromEvents([weekly({ ics_exdates: ['20261112T080000Z'] })], { timeZone: z }));
      assert.ok(cal.includes('DTSTART:20261105T080000Z'), 'zone ' + z);
      assert.ok(cal.includes('EXDATE:20261112T080000Z'));
      assert.ok(!cal.includes('VTIMEZONE') && !cal.includes('TZID='));
    }

    // --- all-day series: dates, no TZID -----------------------------------------------------------
    cal = unfold(Ics.buildIcsCalendarFromEvents([weekly({ all_day: true })], { timeZone: 'Europe/Amsterdam' }));
    assert.ok(cal.includes('DTSTART;VALUE=DATE:') && !cal.includes('VTIMEZONE'));

    // --- edited occurrence: RECURRENCE-ID in the same zone ----------------------------------------
    cal = unfold(Ics.buildIcsCalendarFromEvents([
      weekly(),
      Object.assign(weekly({ rrule: '', title: 'Moved', start: '2026-11-12T09:00:00.000Z', end: '2026-11-12T09:30:00.000Z' }), { ics_recurrence_id: '20261112T080000Z' }),
    ], { timeZone: 'Europe/Amsterdam' }));
    assert.ok(cal.includes('RECURRENCE-ID;TZID=Europe/Amsterdam:20261112T090000'));
    assert.ok(cal.includes('DTSTART;TZID=Europe/Amsterdam:20261112T100000'));

    // --- round trip across the spring clock change: the series keeps its local hour -------------
    // Weekly 09:00 Amsterdam starting 2027-03-22 (CET); 29 March is CEST (07:00Z).
    const spring = weekly({ start: '2027-03-22T08:00:00.000Z', end: '2027-03-22T08:30:00.000Z' });
    const back = Ics.parseIcsFile(Ics.buildIcsCalendarFromEvents([spring, once], { timeZone: 'Europe/Amsterdam' }));
    const e = back.events.find((x) => x.ical_uid === 'weekly-1');
    assert.strictEqual(e.start, spring.start);
    assert.strictEqual(e.end, spring.end);
    assert.strictEqual(e.source_tz, 'Europe/Amsterdam');
    assert.strictEqual(back.events.find((x) => x.ical_uid === 'once-1').start, once.start);
    assert.deepStrictEqual(back.warnings, []);
    const ex = Ics.parseIcsFile(Ics.buildIcsCalendarFromEvents([weekly({ ics_exdates: ['20261112T080000Z'] })], { timeZone: 'Europe/Amsterdam' }));
    assert.deepStrictEqual(ex.events[0].ics_exdates, ['20261112T080000Z'], 'EXDATE survives the round trip as the same instant');
    const rid = Ics.parseIcsFile(cal);
    assert.ok(rid.events.some((x) => x.ics_recurrence_id === '20261112T080000Z'));
  `;
}

// The zone argument is explicit, but also run under several device zones to prove independence.
for (const tz of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'UTC']) {
  const r = spawnSync(process.execPath, ['-e', script()], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  assert.strictEqual(r.status, 0, `TZ ${tz} failed:\n${r.stderr}${r.stdout}`);
}

// Default zone = device zone: with TZ=Europe/Amsterdam a weekly event exports with that TZID.
const def = spawnSync(process.execPath, ['-e', `
  const fs = require('fs'); const vm = require('vm');
  vm.runInThisContext(fs.readFileSync(${JSON.stringify(icsPath)}, 'utf8'));
  const cal = NotesAgendaIcs.buildIcsCalendarFromEvents([{ id: 'w', ical_uid: 'w1', title: 'x', all_day: false, rrule: 'FREQ=DAILY',
    start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T09:00:00.000Z' }]);
  if (!cal.includes('DTSTART;TZID=Europe/Amsterdam:20261105T090000')) { console.error(cal); process.exit(1); }
`], { encoding: 'utf8', env: { ...process.env, TZ: 'Europe/Amsterdam' } });
assert.strictEqual(def.status, 0, def.stderr);

console.log('agenda ics export tzid ok');
