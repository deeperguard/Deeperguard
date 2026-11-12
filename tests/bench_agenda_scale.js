// Manual benchmark (not part of the test suite): node tests/bench_agenda_scale.js [events] [series]
// Builds a large agenda and prints timings for the work done on every view change and every save.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const N = Number(process.argv[2]) || 5000;
const SERIES = Number(process.argv[3]) || 200;

global.window = global;
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'app/static/js', `${f}.js`), 'utf8'));
}
const A = global.NotesAgenda;

function build(n, series) {
  const events = [];
  const base = new Date(2026, 0, 1, 8, 0).getTime();
  const rules = ['FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'];
  for (let i = 0; i < n; i += 1) {
    const isSeries = i < series;
    const start = base + (isSeries ? i * 3600000 : Math.floor(Math.random() * 700) * 86400000 + (i % 10) * 3600000);
    events.push({
      id: `e${i}`,
      type: 'agenda_event',
      title: `Event ${i}`,
      location: i % 3 ? 'Room ' + (i % 40) : '',
      notes: i % 5 ? '' : 'Some longer note text about the meeting agenda and follow-ups',
      start: new Date(start).toISOString(),
      end: new Date(start + 3600000).toISOString(),
      all_day: i % 17 === 0,
      rrule: isSeries ? rules[i % rules.length] : '',
      ics_exdates: [],
      ics_occurrence_overrides: {},
      updated_at: new Date(start).toISOString(),
    });
  }
  return events;
}

function time(label, fn, runs = 5) {
  fn(); // warm up
  const t = [];
  let result;
  for (let i = 0; i < runs; i += 1) {
    const s = process.hrtime.bigint();
    result = fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  console.log(`${label.padEnd(44)} median ${t[Math.floor(t.length / 2)].toFixed(1).padStart(7)} ms   worst ${t[t.length - 1].toFixed(1).padStart(7)} ms`);
  return result;
}

const events = build(N, SERIES);
console.log(`${N} events, ${SERIES} repeating series\n`);

const day = (y, m, d) => new Date(y, m, d);
const ranges = {
  'week (7 days)': [day(2026, 5, 1), day(2026, 5, 8)],
  'month grid (6 weeks)': [day(2026, 4, 25), day(2026, 6, 6)],
  'list (31 days)': [day(2026, 5, 1), day(2026, 6, 2)],
  'year (stress)': [day(2026, 0, 1), day(2027, 0, 1)],
};
for (const [name, [a, b]] of Object.entries(ranges)) {
  const n = time(`expand all events: ${name}`, () => {
    let count = 0;
    for (const ev of events) count += A.expandEventOccurrences(ev, a, b).length;
    return count;
  });
  console.log(`${' '.repeat(44)} -> ${n} occurrences`);
}

time('JSON size of the pack (what is encrypted)', () => JSON.stringify({ type: 'agenda_pack', events: Object.fromEntries(events.map((e) => [e.id, e])) }).length);
const bytes = JSON.stringify({ events }).length;
console.log(`${' '.repeat(44)} -> ${(bytes / 1024).toFixed(0)} KiB`);

time('copy events object + add one (per save)', () => {
  const map = Object.fromEntries(events.map((e) => [e.id, e]));
  const next = { ...map };
  next.new = { ...events[0], id: 'new' };
  return Object.keys(next).length;
});

time('search "Room 7" over all events', () => {
  const q = 'room 7';
  return events.filter((e) => [e.title, e.location, e.notes].join(' ').toLowerCase().includes(q)).length;
});
