/**
 * Phone month day list: full-date heading, multi-day / all-day bars first with an "x/y" counter.
 * Renders the real day list (agenda.js) for a 4-day event across a month boundary, a one-day
 * all-day event, a timed event spanning midnight, and a plain timed event.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

global.window = global;
global.matchMedia = (q) => ({ matches: /max-width:\s*768px/.test(q), addEventListener() {}, removeEventListener() {} });
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
vm.runInThisContext(read('app/static/js/vendor/noble-crypto.js'));
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda-reminders', 'agenda-tasks', 'agenda']) {
  vm.runInThisContext(read(`app/static/js/${f}.js`), { filename: `${f}.js` });
}
const A = global.NotesAgenda;

// All-day ends are exclusive: Nov 28 – Dec 1 2026 is stored as end = Dec 2 00:00.
const iso = (y, m, d, h = 0) => new Date(y, m, d, h).toISOString();
const enRoute = { id: 'route', title: 'En Route', color: '#3b82f6', all_day: true, start: iso(2026, 10, 28), end: iso(2026, 11, 2) };
const oneDay = { id: 'one', title: 'Holiday', color: '#10b981', all_day: true, start: iso(2026, 10, 30), end: iso(2026, 11, 1) };
const night = { id: 'night', title: 'Night shift', color: '#f59e0b', all_day: false, start: iso(2026, 10, 30, 22), end: iso(2026, 11, 1, 6) };
const meet = { id: 'meet', title: 'Meeting', color: '#ef4444', all_day: false, start: iso(2026, 10, 30, 9), end: iso(2026, 10, 30, 10) };
const events = [meet, night, oneDay, enRoute];

A._state.view = 'month';
/** Day list for the picked day, with the month grid of `gridMonth` (0-based) as the visible range. */
function render(y, m, d, gridMonth, nowMs) {
  A._state.anchor = new Date(y, gridMonth, 15);
  A._state.monthPickDay = new Date(y, m, d).getTime();
  const range = A.rangeForView();
  const occ = events.flatMap((ev) => A.expandEventOccurrences(ev, range.start, range.end));
  return A._renderMonthDayList(occ, [], nowMs);
}
/** Text of the bar button of one event, or null. */
const bar = (html, id) => {
  const m = new RegExp(`<button type="button" class="agenda-month-bar" data-agenda-id="${id}"[^>]*>(.*?)</button>`).exec(html);
  return m && m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

// First day 1/4, with the full date as heading and the calendar colour on the bar.
let html = render(2026, 10, 28, 10);
assert.strictEqual(bar(html, 'route'), 'En Route 1/4');
assert.ok(/Saturday,? 28 November 2026/.test(html),'full date heading incl. year');
assert.ok(html.includes('--agenda-bar:#3b82f6'), 'calendar colour on the bar');

// Day 3/4 (Nov 30).
html = render(2026, 10, 30, 10);
assert.strictEqual(bar(html, 'route'), 'En Route 3/4');

// Last day 4/4 is Dec 1; viewed from the December grid the occurrence is clipped at the month boundary.
html = render(2026, 11, 1, 11);
assert.strictEqual(bar(html, 'route'), 'En Route 4/4', 'last day, across the month boundary');
assert.strictEqual(bar(html, 'night'), 'Night shift 2/2');

// One-day all-day: a bar without counter. Timed event across midnight: 1/2 on its first day.
html = render(2026, 10, 30, 10);
assert.strictEqual(bar(html, 'one'), 'Holiday');
assert.strictEqual(bar(html, 'night'), 'Night shift 1/2');

// Bars come before the time rows; the plain timed event stays a row that opens the event.
assert.ok(!bar(html, 'meet'), 'timed single-day event is not a bar');
assert.ok(html.lastIndexOf('agenda-month-bar"') < html.indexOf('agenda-list-row'), 'bars above rows');
assert.ok(/class="agenda-list-row[^"]*" data-agenda-id="meet"/.test(html), 'row keeps data-agenda-id to open the event');

// Timed rows: colour dot, "from – to", sorted by start, past ones dimmed (fixed "now" 2026-11-30 12:00).
events.push(
  { id: 'late', title: 'Dinner', color: '#8b5cf6', all_day: false, start: iso(2026, 10, 30, 18), end: iso(2026, 10, 30, 20) },
  { id: 'noon', title: 'Lunch', color: '#14b8a6', all_day: false, start: iso(2026, 10, 30, 11), end: iso(2026, 10, 30, 13) },
);
html = render(2026, 10, 30, 10, new Date(2026, 10, 30, 12).getTime());
const rowOf = (id) => new RegExp(`<button type="button" class="([^"]*)" data-agenda-id="${id}"[^>]*aria-label="([^"]*)"[^>]*--agenda-dot:([^"]*)">(.*?)</button>`).exec(html);
const order = ['meet', 'noon', 'late'].map((id) => html.indexOf(`data-agenda-id="${id}"`));
assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'rows sorted by start time');
const r = rowOf('meet');
assert.ok(r[1].includes('agenda-list-row') && r[1].includes('is-past'), 'ended event is dimmed');
assert.strictEqual(r[2], 'Meeting, 09:00 to 10:00');
assert.strictEqual(r[3], '#ef4444', 'dot takes the event colour');
assert.ok(r[4].includes('agenda-month-dot') && r[4].includes('09:00 – 10:00') && r[4].includes('Meeting'));
assert.ok(!rowOf('noon')[1].includes('is-past'), 'event still running is not dimmed');
assert.ok(!rowOf('late')[1].includes('is-past'), 'future event is not dimmed');

// The day after the event has no bar for it.
assert.strictEqual(bar(render(2026, 11, 2, 11), 'route'), null);

// A day without events still shows the heading and the empty line.
html = render(2026, 10, 5, 10);
assert.ok(/Thursday,? 5 November 2026/.test(html) &&html.includes('No events this day.'));

console.log('test_agenda_month_day_bars.js: ok');
