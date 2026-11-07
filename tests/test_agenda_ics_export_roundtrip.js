/**
 * Agenda ICS export: escaping, folding (UTF-8), timed UTC Z, all-day local DATE, attendees, roundtrip.
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

function countUtf8Octets(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

const longSummary = `x${'y'.repeat(80)}`;
const folded = Ics.foldIcsLine(`SUMMARY:${longSummary}`);
assert.ok(folded.includes('\r\n '), 'long ASCII line should fold with CRLF continuation');
const foldedLines = folded.split('\r\n');
for (const ln of foldedLines) {
  assert.ok(countUtf8Octets(ln) <= 75, `each segment <= 75 octets, got ${countUtf8Octets(ln)} for ${ln.slice(0, 20)}…`);
}

// Dutch + astral emoji: must not split surrogate pair; fold on octets
const dutch = 'SUMMARY:Gegroet café coördinatie 🇳🇱 ' + 'x'.repeat(60);
const foldedNl = Ics.foldIcsLine(dutch);
for (const ln of foldedNl.split('\r\n')) {
  assert.ok(countUtf8Octets(ln) <= 75, `NL/emoji fold octets ${countUtf8Octets(ln)}`);
}

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
    attendees: ['alice@ex.com', 'bob@ex.com'],
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
assert.ok(cal.includes(`DTSTART:${Ics.formatUtcDateTime(t0)}`));
assert.ok(cal.includes(`DTEND:${Ics.formatUtcDateTime(t1)}`));
assert.ok(cal.includes('https://meet.example.com/x'));
assert.ok(cal.includes('Attendees:'), 'DESCRIPTION should list attendees');
assert.ok(!cal.includes('\\\\nAttendees:'), 'must not double-escape attendee newline');

const parsed = Ics.parseIcsFile(cal);
assert.ok(parsed.events && parsed.events.length >= 1);
const back = parsed.events.find((e) => e.ical_uid === uid);
assert.ok(back, 'timed event roundtrips by UID');
assert.ok(back.title.includes('Meet'), back.title);
assert.ok((back.notes || '').includes('Attendees:'), 'attendees in description roundtrip');
assert.deepStrictEqual(back.attendees, []);
assert.strictEqual(back.start, t0.toISOString());
assert.strictEqual(back.end, t1.toISOString());

const { events: alldayEvs } = Ics.parseIcsFile(cal);
const ad = alldayEvs.find((e) => e.ical_uid === 'allday-1');
assert.ok(ad);
assert.strictEqual(ad.all_day, true);
const reExp = Ics.buildIcsCalendarFromEvents([
  {
    id: 'e2',
    title: 'Away',
    start: ad.start,
    end: ad.end,
    all_day: true,
    ical_uid: 'allday-1',
  },
]);
assert.ok(reExp.includes('DTSTART;VALUE=DATE:20261224'));
assert.ok(reExp.includes('DTEND;VALUE=DATE:20261226'), 'exclusive DTEND day after last day');

const twoDay = Ics.parseIcsFile([
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:test-ad',
  'DTSTART;VALUE=DATE:20261224',
  'DTEND;VALUE=DATE:20261226',
  'SUMMARY:X',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n'));
const ev2 = twoDay.events[0];
assert.strictEqual(ev2.all_day, true);
const round2 = Ics.buildIcsCalendarFromEvents([{
  id: 'x',
  ical_uid: 'test-ad',
  title: 'X',
  start: ev2.start,
  end: ev2.end,
  all_day: true,
}]);
assert.ok(round2.includes('DTSTART;VALUE=DATE:20261224'));
assert.ok(round2.includes('DTEND;VALUE=DATE:20261226'));

console.log('test_agenda_ics_export_roundtrip ok');
