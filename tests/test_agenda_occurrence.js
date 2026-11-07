/**
 * Occurrence overrides + EXDATE (agenda-occurrence.js + expansion finalize).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const load = (rel) => vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: path.basename(rel) });

load('app/static/js/agenda-ics.js');
load('app/static/js/agenda-recurrence.js');
load('app/static/js/agenda-occurrence.js');

const Occ = global.NotesAgendaOccurrence;
const Ics = global.NotesAgendaIcs;

const master = {
  id: 'ev1',
  title: 'Stand-up',
  start: '2026-04-06T10:30:00.000Z',
  end: '2026-04-06T11:00:00.000Z',
  all_day: false,
  rrule: 'FREQ=WEEKLY;INTERVAL=1',
  ics_exdates: [],
  ics_occurrence_overrides: {},
};

function expandRaw(ev, rangeStart, rangeEnd) {
  const span = { start: new Date(ev.start), end: new Date(ev.end) };
  const out = [];
  let cur = new Date(span.start);
  const duration = span.end - span.start;
  while (cur < rangeEnd) {
    const ce = new Date(cur.getTime() + duration);
    if (ce > rangeStart && cur < rangeEnd) {
      out.push({ ev, start: new Date(cur), end: ce, recurring: true });
    }
    cur = new Date(cur.getTime() + 7 * 86400000);
  }
  return Occ.finalizeOccurrences(ev, out, rangeStart, rangeEnd);
}

const rangeStart = new Date('2026-04-01T00:00:00Z');
const rangeEnd = new Date('2026-04-30T00:00:00Z');

let occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(occ.length, 4);

const instance = new Date('2026-04-20T10:30:00.000Z');
const rid = Occ.recurrenceIdForStart(instance, false);
master.ics_occurrence_overrides[rid] = {
  title: 'Stand-up (guest)',
  start: instance.toISOString(),
  end: '2026-04-20T11:00:00.000Z',
  all_day: false,
};
occ = expandRaw(master, rangeStart, rangeEnd);
const april20 = occ.find((o) => o.start.toISOString().startsWith('2026-04-20'));
assert.ok(april20, 'Apr 20 instance exists');
assert.strictEqual(april20.displayTitle, 'Stand-up (guest)');
const unchanged = occ.find((o) => o.start.toISOString().startsWith('2026-04-06'));
assert.strictEqual(unchanged.displayTitle, 'Stand-up');

const movedStart = new Date('2026-04-21T14:00:00.000Z');
master.ics_exdates = [rid];
master.ics_occurrence_overrides[rid] = {
  title: 'Stand-up moved',
  start: movedStart.toISOString(),
  end: '2026-04-21T14:30:00.000Z',
  all_day: false,
};
occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(
  occ.filter((o) => o.start.toISOString().startsWith('2026-04-20T10:30')).length,
  0,
);
const moved = occ.find((o) => o.displayTitle === 'Stand-up moved');
assert.ok(moved);
assert.strictEqual(moved.start.toISOString(), movedStart.toISOString());

master.ics_exdates.push(Occ.recurrenceIdForStart(new Date('2026-04-13T10:30:00.000Z'), false));
occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(occ.filter((o) => o.start.toISOString().startsWith('2026-04-13')).length, 0);

const exported = Ics.buildIcsCalendarFromEvents([
  master,
  {
    ...master,
    rrule: '',
    ics_exdates: [],
    ics_recurrence_id: rid,
    title: master.ics_occurrence_overrides[rid].title,
    start: master.ics_occurrence_overrides[rid].start,
    end: master.ics_occurrence_overrides[rid].end,
  },
]);
assert.ok(exported.includes('RECURRENCE-ID:'));
assert.ok(exported.includes('EXDATE:'));
assert.ok(exported.includes('FREQ=WEEKLY'));

const reimport = Ics.parseIcsFile(exported);
assert.ok(reimport.events.length >= 2);

console.log('test_agenda_occurrence ok');
