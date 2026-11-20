/**
 * Phone month grid: fold to the selected day's week, and keep the selected day when the
 * month (unfolded) or the week (folded) changes. Runs the real agenda.js render/shift code.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let phoneWidth = true;
global.window = global;
global.matchMedia = (q) => ({
  matches: phoneWidth && /max-width:\s*768px/.test(q),
  addEventListener() {},
  removeEventListener() {},
});
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
const st = A._state;

function setup(y, m, d, collapsed) {
  st.view = 'month';
  st.anchor = new Date(y, m, d);
  st.monthPickDay = new Date(y, m, d).getTime();
  st.monthCollapsed = collapsed;
}
const day = (ms) => { const x = new Date(ms); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };
const grid = () => { const r = A.rangeForView(); return A._renderMonthGrid(r.days, [], []); };
const cellDays = (html) => [...html.matchAll(/data-agenda-month-day="(\d+)"/g)].map((x) => Number(x[1]));

// Folded: one row, the week (Mon-Sun) of the selected day (Wed 18 Nov 2026).
setup(2026, 10, 18, true);
let html = grid();
assert.strictEqual((html.match(/class="agenda-month-row"/g) || []).length, 1);
assert.deepStrictEqual(cellDays(html).map(day), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
// Unfolded: the whole month again.
st.monthCollapsed = false;
assert.strictEqual((grid().match(/class="agenda-month-row"/g) || []).length, 6);

// Month change keeps the day: 31 Jan -> 28 Feb (2027 is not a leap year), then back to 28 Jan.
setup(2027, 0, 31, false);
A._shiftAnchor(1);
assert.strictEqual(day(st.monthPickDay), '2027-2-28');
assert.strictEqual(st.anchor.getMonth(), 1);
A._shiftAnchor(-1);
assert.strictEqual(day(st.monthPickDay), '2027-1-28');
// Leap year clips to the 29th.
setup(2028, 0, 31, false);
A._shiftAnchor(1);
assert.strictEqual(day(st.monthPickDay), '2028-2-29');
// Year boundary.
setup(2026, 11, 15, false);
A._shiftAnchor(1);
assert.strictEqual(day(st.monthPickDay), '2027-1-15');

// Folded: the day moves 7 days and the grid follows into the next month.
setup(2027, 0, 31, true);
A._shiftAnchor(1);
assert.strictEqual(day(st.monthPickDay), '2027-2-7');
assert.strictEqual(st.anchor.getMonth(), 1);
let weekDays = cellDays(grid()).map(day);
assert.strictEqual(weekDays.length, 7);
assert.ok(weekDays.includes('2027-2-7'));
A._shiftAnchor(-1);
A._shiftAnchor(-1);
assert.strictEqual(day(st.monthPickDay), '2027-1-24');

// Selected day outside the shown month (spill-over cell): unfolded step starts from the anchor month.
setup(2026, 10, 18, false);
st.monthPickDay = new Date(2026, 11, 2).getTime();
A._shiftAnchor(1);
assert.strictEqual(day(st.monthPickDay), '2026-12-18');

// Desktop: unchanged behaviour (the anchor steps by month, no selected day involved).
phoneWidth = false;
setup(2027, 0, 31, true);
st.monthPickDay = 0;
A._shiftAnchor(1);
assert.strictEqual(day(st.anchor.getTime()), '2027-2-28');
assert.strictEqual(st.monthPickDay, 0);
assert.strictEqual((grid().match(/class="agenda-month-row"/g) || []).length >= 4, true, 'desktop ignores the folded flag');

console.log('test_agenda_month_collapse.js: ok');
