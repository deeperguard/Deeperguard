/**
 * Scale guard: a big agenda (3000 events, 150 repeating series) must stay cheap to expand for
 * every view. Budgets are ~50x the measured times (tests/bench_agenda_scale.js), so only an
 * accidental quadratic loop or a per-event heavy parse trips them, not a slow CI machine.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
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

const rules = ['FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'];
const events = [];
for (let i = 0; i < 3000; i += 1) {
  const series = i < 150;
  // Deterministic spread instead of Math.random(): the counts below are exact.
  const start = new Date(2026, 0, 1 + (series ? 0 : (i * 7) % 700), 8 + (i % 10), 0).getTime();
  events.push({
    id: `e${i}`,
    type: 'agenda_event',
    title: `Event ${i}`,
    start: new Date(start).toISOString(),
    end: new Date(start + 3600000).toISOString(),
    all_day: false,
    rrule: series ? rules[i % rules.length] : '',
    ics_exdates: [],
    ics_occurrence_overrides: {},
  });
}

function expandAll(a, b) {
  let n = 0;
  for (const ev of events) n += A.expandEventOccurrences(ev, a, b).length;
  return n;
}
function timed(fn) {
  const t = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

const cases = [
  ['week', new Date(2026, 5, 1), new Date(2026, 5, 8), 300],
  ['month grid', new Date(2026, 4, 25), new Date(2026, 6, 6), 300],
  ['list (31 days)', new Date(2026, 5, 1), new Date(2026, 6, 2), 300],
  ['year', new Date(2026, 0, 1), new Date(2027, 0, 1), 1500],
];
for (const [name, a, b, budgetMs] of cases) {
  expandAll(a, b); // warm up
  const { out, ms } = timed(() => expandAll(a, b));
  assert.ok(out > 0, `${name}: some occurrences`);
  assert.ok(ms < budgetMs, `${name}: ${ms.toFixed(1)} ms is over the ${budgetMs} ms budget`);
}

// Repeating events must not be expanded beyond the asked range (daily series, one week = 7 each).
const dailyOnly = events.filter((e) => e.rrule === 'FREQ=DAILY');
const weekCount = dailyOnly.reduce((n, e) => n + A.expandEventOccurrences(e, new Date(2026, 5, 1), new Date(2026, 5, 8)).length, 0);
assert.strictEqual(weekCount, dailyOnly.length * 7, 'a daily series yields exactly 7 occurrences in a week');

console.log('agenda scale ok');
