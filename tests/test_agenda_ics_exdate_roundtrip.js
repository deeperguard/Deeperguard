/**
 * ICS VEVENT with separate RRULE + EXDATE properties (not embedded in RRULE).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const icsPath = path.join(root, 'app/static/js/agenda-ics.js');
vm.runInThisContext(fs.readFileSync(icsPath, 'utf8'), { filename: 'agenda-ics.js' });
const Ics = global.NotesAgendaIcs;

const sample = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//fixture//EN
BEGIN:VEVENT
UID:exdate-fixture-1
DTSTART:20260304T103000Z
DTEND:20260304T113000Z
SUMMARY:Monthly with skips
RRULE:FREQ=MONTHLY;BYDAY=1MO
EXDATE:20260406T103000Z
EXDATE:20260504T103000Z
END:VEVENT
END:VCALENDAR
`;

const parsed = Ics.parseIcsFile(sample);
assert.strictEqual(parsed.events.length, 1);
const ev = parsed.events[0];
assert.ok(ev.rrule.includes('FREQ=MONTHLY'));
assert.deepStrictEqual(ev.ics_exdates, ['20260406T103000Z', '20260504T103000Z']);

const edited = {
  ...ev,
  id: 'local-1',
  title: 'Monthly with skips (edited)',
};
const cal = Ics.buildIcsCalendarFromEvents([edited]);
assert.ok(cal.includes('RRULE:FREQ=MONTHLY'));
// Repeating events are exported in the device zone (TZID) or in UTC (Z) when it is UTC: either way
// every skipped date is its own EXDATE property, and the round trip below returns the same instants.
assert.strictEqual((cal.match(/^EXDATE[;:]/gm) || []).length, 2, 'EXDATE lines are separate properties');
assert.ok(!/^RRULE:[^\r\n]*EXDATE/m.test(cal));

const back = Ics.parseIcsFile(cal).events[0];
assert.strictEqual(back.title, edited.title);
assert.deepStrictEqual(back.ics_exdates, ev.ics_exdates);

console.log('test_agenda_ics_exdate_roundtrip ok');
