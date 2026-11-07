/**
 * Agenda ICS export: escaping, folding, timed and all-day events, import roundtrip.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const icsPath = path.join(root, 'app/static/js/agenda-ics.js');
vm.runInThisContext(fs.readFileSync(icsPath, 'utf8'), { filename: 'agenda-ics.js' });
const Ics = global.NotesAgendaIcs;
assert.ok(Ics && typeof Ics.buildIcsCalendarFromEvents === 'function');

assert.strictEqual(Ics.escapeIcsText('a,b;c\\d\nx'), 'a\\,b\\;c\\\\d\\nx');

const longSummary = `x${'y'.repeat(80)}`;
const folded = Ics.foldIcsLine(`SUMMARY:${longSummary}`);
assert.ok(folded.includes('\r\n '), 'long line should fold with CRLF continuation');

const uid = '550e8400-e29b-41d4-a716-446655440000';
const t0 = new Date(2026, 10, 7, 9, 30, 0);
const t1 = new Date(2026, 10, 7, 10, 45, 0);
const rows = [
  {
    id: 'e1',
    ical_uid: uid,
    title: 'Meet; team',
    location: 'Room A, B',
    notes: 'Agenda: review\nSecond line',
    start: t0.toISOString(),
    end: t1.toISOString(),
    all_day: false,
    rrule: '',
    webcall_url: 'https://meet.example.com/x',
    attendees: [],
  },
  {
    id: 'e2',
    title: 'Away',
    start: new Date(2026, 11, 24).toISOString(),
    end: new Date(2026, 11, 26).toISOString(),
    all_day: true,
    ical_uid: 'allday-1',
  },
];

const cal = Ics.buildIcsCalendarFromEvents(rows);
assert.ok(cal.includes('BEGIN:VCALENDAR'));
assert.ok(cal.includes('VERSION:2.0'));
assert.ok(cal.includes('METHOD:PUBLISH'));
assert.ok(cal.includes(`UID:${uid}`));
assert.ok(cal.includes('DTSTART:20261107T093000'));
assert.ok(cal.includes('DTEND:20261107T104500'));
assert.ok(cal.includes('https://meet.example.com/x'));

const parsed = Ics.parseIcsFile(cal);
assert.ok(parsed.events && parsed.events.length >= 1);
const back = parsed.events.find((e) => e.ical_uid === uid);
assert.ok(back, 'timed event roundtrips by UID');
assert.ok(back.title.includes('Meet'), back.title);

const { events: alldayEvs } = Ics.parseIcsFile(cal);
const ad = alldayEvs.find((e) => e.ical_uid === 'allday-1');
if (ad) {
  assert.strictEqual(ad.all_day, true);
}

console.log('test_agenda_ics_export_roundtrip ok');
