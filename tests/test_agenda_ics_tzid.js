/**
 * ICS import honours TZID: wall times in another zone become the right instant,
 * and EXDATE / RECURRENCE-ID values with a TZID still match the series occurrences.
 * Runs each case under several device time zones.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const icsPath = path.join(root, 'app/static/js/agenda-ics.js');
const occPath = path.join(root, 'app/static/js/agenda-occurrence.js');

function caseScript() {
  return `
    const fs = require('fs');
    const vm = require('vm');
    const assert = require('assert');
    vm.runInThisContext(fs.readFileSync(${JSON.stringify(icsPath)}, 'utf8'));
    vm.runInThisContext(fs.readFileSync(${JSON.stringify(occPath)}, 'utf8'));
    const Ics = global.NotesAgendaIcs;
    const Occ = global.NotesAgendaOccurrence;
    const cal = (body) => 'BEGIN:VCALENDAR\\r\\nBEGIN:VEVENT\\r\\nUID:x\\r\\nSUMMARY:T\\r\\n' + body + 'END:VEVENT\\r\\nEND:VCALENDAR\\r\\n';
    const one = (body) => Ics.parseIcsFile(cal(body));

    // New York 09:00 in November (EST, UTC-5) = 14:00 UTC.
    let r = one('DTSTART;TZID=America/New_York:20261112T090000\\r\\nDTEND;TZID=America/New_York:20261112T100000\\r\\n');
    assert.strictEqual(r.events[0].start, '2026-11-12T14:00:00.000Z');
    assert.strictEqual(r.events[0].end, '2026-11-12T15:00:00.000Z');
    assert.strictEqual(r.events[0].source_tz, 'America/New_York');
    assert.deepStrictEqual(r.warnings, []);

    // Summer (EDT, UTC-4), Tokyo (no DST), London summer (BST).
    assert.strictEqual(one('DTSTART;TZID=America/New_York:20260701T090000\\r\\n').events[0].start, '2026-07-01T13:00:00.000Z');
    assert.strictEqual(one('DTSTART;TZID=Asia/Tokyo:20261112T090000\\r\\n').events[0].start, '2026-11-12T00:00:00.000Z');
    assert.strictEqual(one('DTSTART;TZID=Europe/London:20260701T090000\\r\\n').events[0].start, '2026-07-01T08:00:00.000Z');

    // Quoted TZID and Outlook/Windows zone names.
    assert.strictEqual(one('DTSTART;TZID="Europe/Amsterdam":20261112T090000\\r\\n').events[0].start, '2026-11-12T08:00:00.000Z');
    assert.strictEqual(one('DTSTART;TZID=W. Europe Standard Time:20261112T090000\\r\\n').events[0].start, '2026-11-12T08:00:00.000Z');
    assert.strictEqual(one('DTSTART;TZID=Pacific Standard Time:20261112T090000\\r\\n').events[0].start, '2026-11-12T17:00:00.000Z');

    // Spring-forward gap in New York (02:30 on 8 March 2026 does not exist) moves forward to 03:30 EDT.
    assert.strictEqual(one('DTSTART;TZID=America/New_York:20260308T023000\\r\\n').events[0].start, '2026-03-08T07:30:00.000Z');
    // Fall-back overlap (01:30 on 1 Nov 2026 happens twice): a valid instant, either 05:30Z or 06:30Z.
    assert.ok(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']
      .includes(one('DTSTART;TZID=America/New_York:20261101T013000\\r\\n').events[0].start));

    // Unknown zone: local wall time, with a warning.
    r = one('DTSTART;TZID=Mars/Olympus:20261112T090000\\r\\n');
    assert.strictEqual(r.events[0].start, new Date(2026, 10, 12, 9, 0, 0).toISOString());
    assert.strictEqual(r.warnings.length, 1);

    // UTC and floating values are unchanged.
    assert.strictEqual(one('DTSTART:20261112T090000Z\\r\\n').events[0].start, '2026-11-12T09:00:00.000Z');
    assert.strictEqual(one('DTSTART:20261112T090000\\r\\n').events[0].start, new Date(2026, 10, 12, 9, 0, 0).toISOString());
    assert.strictEqual(one('DTSTART;VALUE=DATE:20261112\\r\\n').events[0].all_day, true);

    // EXDATE with TZID (comma list) and RECURRENCE-ID with TZID become UTC keys that match occurrences.
    r = one(
      'DTSTART;TZID=America/New_York:20261105T090000\\r\\n'
      + 'RRULE:FREQ=WEEKLY\\r\\n'
      + 'EXDATE;TZID=America/New_York:20261112T090000,20261119T090000\\r\\n',
    );
    const ev = r.events[0];
    assert.deepStrictEqual(ev.ics_exdates, ['20261112T140000Z', '20261119T140000Z']);
    assert.ok(Occ.isExcludedByExdate(new Date('2026-11-12T14:00:00Z'), ev.ics_exdates, false));
    assert.ok(Occ.isExcludedByExdate(new Date('2026-11-19T14:00:00Z'), ev.ics_exdates, false));
    assert.ok(!Occ.isExcludedByExdate(new Date('2026-11-26T14:00:00Z'), ev.ics_exdates, false));

    r = one('RECURRENCE-ID;TZID=America/New_York:20261112T090000\\r\\nDTSTART;TZID=America/New_York:20261112T110000\\r\\n');
    assert.strictEqual(r.events[0].ics_recurrence_id, '20261112T140000Z');
    assert.strictEqual(r.events[0].ics_recurrence_id, Occ.recurrenceIdForStart(new Date('2026-11-12T14:00:00Z'), false));
  `;
}

for (const tz of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'UTC']) {
  const r = spawnSync(process.execPath, ['-e', caseScript()], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz },
  });
  assert.strictEqual(r.status, 0, `TZ ${tz} failed:\n${r.stderr}${r.stdout}`);
}

console.log('agenda ics tzid ok');
