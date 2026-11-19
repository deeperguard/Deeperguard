/**
 * Readable ZIP export: agenda/agenda.ics (docs/IMPORT_EXPORT_SPEC.md 2.3).
 * Checks UID, timed and all-day dates, recurrence with an edited occurrence,
 * RFC 5545 TEXT escaping, 75-octet folding, and that the notes are unchanged.
 */
process.env.TZ = 'Europe/Amsterdam';
const assert = require('assert');
const Zip = require('../app/static/js/ziplib.js');
const Export = require('../app/static/js/readable-export.js');

const dec = (b) => new TextDecoder().decode(b);
const octets = (s) => new TextEncoder().encode(s).length;

const note = (uuid, content) => ({
  uuid,
  content: {
    type: 'note', title: 'T', content: '', tags: [], attachments: [], locked: false, trashed: false,
    created_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T11:00:00.000Z', ...content,
  },
});
const ev = (id, fields) => ({ id, type: 'agenda_event', version: 1, title: '', notes: '', all_day: false, ...fields });

const LONG_NOTES = `Agenda, punt; één\nTweede regel met back\\slash. ${'Héél lange tekst 🎉 '.repeat(12)}`;
const events = [
  ev('ev-timed', {
    title: 'Overleg, team; Q1',
    notes: LONG_NOTES,
    location: 'Kamer 1, gebouw B',
    start: '2026-11-18T14:30:00.000Z',
    end: '2026-11-18T15:15:00.000Z',
  }),
  ev('ev-allday', {
    title: 'Kerstavond',
    all_day: true,
    start: new Date(2026, 11, 24).toISOString(),
    end: new Date(2026, 11, 25).toISOString(),
  }),
  ev('ev-weekly', {
    title: 'Sport',
    ical_uid: 'sport-123@example.com',
    start: '2026-11-16T18:00:00.000Z',
    end: '2026-11-16T19:00:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
    ics_exdates: ['20261130T180000Z'],
    ics_occurrence_overrides: {
      '20261123T180000Z': { title: 'Sport (verplaatst)', start: '2026-11-24T18:00:00.000Z', end: '2026-11-24T19:00:00.000Z' },
      '20261207T180000Z': { cancelled: true },
    },
  }),
];

const baseArgs = {
  notes: [note('n1', { title: 'Plain', content: 'body' }), note('n2', { title: 'Second', content: 'x\ny' })],
  getAttachment: () => null,
  getAttachmentBytes: async () => null,
  now: new Date('2026-11-18T12:00:00Z'),
};
const unzip = async (result) => new Map((await Zip.readZip(result.bytes)).map((e) => [e.name, dec(e.bytes)]));

/** Split the ICS into VEVENT blocks of unfolded "NAME;PARAMS:VALUE" lines. */
function vevents(ics) {
  const logical = ics.replace(/\r\n[ \t]/g, '').split('\r\n');
  const out = [];
  let cur = null;
  for (const line of logical) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT') { out.push(cur); cur = null; } else if (cur) cur.push(line);
  }
  return out;
}
const prop = (block, name) => block.filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

(async () => {
  global.fetch = () => { throw new Error('network used'); };
  global.XMLHttpRequest = function Xhr() { throw new Error('network used'); };

  const plain = await unzip(await Export.build(baseArgs));
  assert.ok(![...plain.keys()].some((n) => n.startsWith('agenda/')), 'no agenda/ when the agenda is empty');

  const result = await Export.build({ ...baseArgs, agendaEvents: events });
  assert.deepStrictEqual(result.counts, { notes: 2, attachments: 0, events: 3 });
  const files = await unzip(result);
  assert.deepStrictEqual([...files.keys()].sort(), [...plain.keys(), 'agenda/agenda.ics'].sort());

  // Notes are byte-identical to an export without agenda.
  for (const [name, text] of plain) if (name.startsWith('notes/')) assert.strictEqual(files.get(name), text, name);
  const readme = files.get('README.txt');
  assert.ok(readme.includes('Agenda events: 3\n'));
  assert.ok(readme.includes('- agenda reminders and agenda tasks\n'));
  assert.ok(!readme.includes('calendar\n'));

  const ics = files.get('agenda/agenda.ics');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(ics), 'every line ends in CRLF');

  // Folding: no physical line over 75 octets, continuations start with a space,
  // and at least one line (the long DESCRIPTION) was actually folded.
  const physical = ics.slice(0, -2).split('\r\n');
  for (const line of physical) assert.ok(octets(line) <= 75, `line over 75 octets: ${line}`);
  const continuations = physical.filter((l) => l.startsWith(' '));
  assert.ok(continuations.length >= 3, 'long description is folded over several lines');
  assert.ok(!/�/.test(ics), 'folding never splits a UTF-8 character');

  const blocks = vevents(ics);
  assert.strictEqual(blocks.length, 4, '3 events + 1 edited occurrence; the cancelled one is not written');

  const timed = blocks.find((b) => prop(b, 'UID')[0] === 'UID:ev-timed');
  assert.deepStrictEqual(prop(timed, 'SUMMARY'), ['SUMMARY:Overleg\\, team\\; Q1']);
  assert.deepStrictEqual(prop(timed, 'LOCATION'), ['LOCATION:Kamer 1\\, gebouw B']);
  assert.deepStrictEqual(prop(timed, 'DTSTART'), ['DTSTART:20261118T143000Z']);
  assert.deepStrictEqual(prop(timed, 'DTEND'), ['DTEND:20261118T151500Z']);
  const description = prop(timed, 'DESCRIPTION')[0];
  assert.ok(description.startsWith('DESCRIPTION:Agenda\\, punt\\; één\\nTweede regel met back\\\\slash. Héél'), description);
  assert.ok(!/[^\\][,;]/.test(description.slice('DESCRIPTION:'.length).replace(/\\\\/g, '')), 'no unescaped , or ;');

  const allDay = blocks.find((b) => prop(b, 'UID')[0] === 'UID:ev-allday');
  assert.deepStrictEqual(prop(allDay, 'DTSTART'), ['DTSTART;VALUE=DATE:20261224']);
  assert.deepStrictEqual(prop(allDay, 'DTEND'), ['DTEND;VALUE=DATE:20261225']);
  assert.deepStrictEqual(prop(allDay, 'SUMMARY'), ['SUMMARY:Kerstavond']);
  assert.deepStrictEqual(prop(allDay, 'DESCRIPTION'), []);

  const series = blocks.filter((b) => prop(b, 'UID')[0] === 'UID:sport-123@example.com');
  assert.strictEqual(series.length, 2);
  const master = series.find((b) => !prop(b, 'RECURRENCE-ID').length);
  assert.deepStrictEqual(prop(master, 'RRULE'), ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4']);
  assert.deepStrictEqual(prop(master, 'DTSTART'), ['DTSTART;TZID=Europe/Amsterdam:20261116T190000']);
  assert.deepStrictEqual(prop(master, 'EXDATE'), ['EXDATE;TZID=Europe/Amsterdam:20261130T190000']);
  const moved = series.find((b) => prop(b, 'RECURRENCE-ID').length);
  assert.deepStrictEqual(prop(moved, 'RECURRENCE-ID'), ['RECURRENCE-ID;TZID=Europe/Amsterdam:20261123T190000']);
  assert.deepStrictEqual(prop(moved, 'SUMMARY'), ['SUMMARY:Sport (verplaatst)']);
  assert.deepStrictEqual(prop(moved, 'RRULE'), []);
  assert.ok(ics.includes('BEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\n'));

  // The app's own ICS parser reads the escaped, folded text back to the original values.
  const parsed = global.NotesAgendaIcs.parseIcsFile(ics).events;
  const back = parsed.find((e) => e.title === 'Overleg, team; Q1');
  assert.ok(back, 'timed event parses back');
  assert.strictEqual(back.notes, LONG_NOTES);
  assert.strictEqual(back.location, 'Kamer 1, gebouw B');
  assert.ok(parsed.some((e) => e.title === 'Kerstavond' && e.all_day));

  // Agenda only, no notes: the ZIP still holds the calendar.
  const agendaOnly = await unzip(await Export.build({ ...baseArgs, notes: [], agendaEvents: [events[1]] }));
  assert.deepStrictEqual([...agendaOnly.keys()].sort(), ['README.txt', 'agenda/agenda.ics']);
  assert.strictEqual(vevents(agendaOnly.get('agenda/agenda.ics')).length, 1);

  // Agenda items without a start or end are left out of the calendar and named in README "Not exported".
  const untimedEvents = [ev('ev-nodate', { title: 'Zonder tijd' }), ev('ev-nostart', { title: 'Half', end: events[0].end })];
  const withUntimed = await unzip(await Export.build({ ...baseArgs, agendaEvents: [...events, ...untimedEvents] }));
  assert.ok(withUntimed.get('README.txt').includes('- 2 agenda event(s) without a start or end time\n'));
  assert.strictEqual(vevents(withUntimed.get('agenda/agenda.ics')).length, 4);
  assert.ok(!withUntimed.get('agenda/agenda.ics').includes('Zonder tijd'));
  const untimedOnly = await unzip(await Export.build({ ...baseArgs, agendaEvents: untimedEvents }));
  assert.ok(![...untimedOnly.keys()].some((n) => n.startsWith('agenda/')), 'no agenda/ when every event is untimed');
  assert.ok(untimedOnly.get('README.txt').includes('- 2 agenda event(s) without a start or end time\n'));
  assert.ok(!readme.includes('without a start or end time'));

  // Without the iCalendar module the export fails loudly instead of dropping the agenda.
  const realIcs = global.NotesAgendaIcs;
  global.NotesAgendaIcs = {};
  await assert.rejects(Export.build({ ...baseArgs, agendaEvents: events }), /Agenda export unavailable/);
  global.NotesAgendaIcs = realIcs;

  // An error inside the ICS builder is passed on, not swallowed.
  global.NotesAgendaIcs = { ...realIcs, buildIcsCalendarFromEvents: () => { throw new Error('boom'); } };
  await assert.rejects(Export.build({ ...baseArgs, agendaEvents: events }), /boom/);
  global.NotesAgendaIcs = realIcs;

  console.log('readable export agenda ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
