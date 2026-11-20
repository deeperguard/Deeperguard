/**
 * Agenda month grid: ISO week number column on phone width only.
 * Renders the real month grid (agenda.js) for December 2026 and January 2027
 * and checks the week label of every row around the year boundary
 * (week 53 of 2026, 1 January 2027 still in week 53, week 1 from 4 January 2027).
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
assert.ok(A && A._renderMonthGrid);

/** Month grid as rangeForView() builds it: Monday-start weeks covering the month. */
function renderMonth(year, month) {
  A._state.view = 'month';
  A._state.anchor = new Date(year, month, 15);
  A._state.monthPickDay = new Date(year, month, 1).getTime();
  const range = A.rangeForView();
  return { html: A._renderMonthGrid(range.days, [], []), days: range.days };
}

/** Per row: [week label or null, first day "D/M" of that row]. */
function rows(html) {
  return html.split('<div class="agenda-month-row">').slice(1).map((row) => {
    const wk = /<span class="agenda-month-week" aria-hidden="true">(\d+)<\/span>/.exec(row);
    const first = /data-agenda-month-day="(\d+)"/.exec(row);
    const d = new Date(Number(first[1]));
    return [wk ? Number(wk[1]) : null, `${d.getDate()}/${d.getMonth() + 1}`];
  });
}

// --- Phone: December 2026 ends in ISO week 53 (Mon 28 Dec 2026 – Sun 3 Jan 2027).
phoneWidth = true;
const dec = renderMonth(2026, 11);
assert.ok(dec.html.includes('agenda-month-grid--weeks'), 'phone grid gets the week column modifier');
assert.deepStrictEqual(rows(dec.html), [
  [49, '30/11'],
  [50, '7/12'],
  [51, '14/12'],
  [52, '21/12'],
  [53, '28/12'],
], 'December 2026 week numbers, ending in week 53');
const decHead = dec.html.slice(dec.html.indexOf('agenda-month-head'), dec.html.indexOf('agenda-month-row'));
assert.strictEqual((decHead.match(/agenda-month-week-head/g) || []).length, 1, 'header has one spacer above the week column');

// --- Phone: January 2027 starts on Friday 1 Jan, which still belongs to 2026-W53; week 1 starts Mon 4 Jan.
const jan = renderMonth(2027, 0);
const janRows = rows(jan.html);
assert.deepStrictEqual(janRows[0], [53, '28/12'], '1 January 2027 row is week 53 of 2026');
assert.deepStrictEqual(janRows[1], [1, '4/1'], 'first full week of 2027 is week 1');
assert.deepStrictEqual(janRows.map((r) => r[0]), [53, 1, 2, 3, 4], 'January 2027 week numbers');
// Week label is decorative: not a button, not a pickable day, hidden from assistive tech.
assert.ok(!/<button[^>]*agenda-month-week/.test(jan.html), 'week number is not a button');
assert.strictEqual(
  (jan.html.match(/data-agenda-month-pick=/g) || []).length,
  janRows.length * 7,
  'only the 7 day buttons per row are pickable',
);

// --- Phone: a year whose 1 January falls in week 52 of the previous year (Sat 1 Jan 2022 -> 2021-W52).
const jan22 = rows(renderMonth(2022, 0).html);
assert.deepStrictEqual(jan22[0], [52, '27/12'], '1 January 2022 row is week 52 of 2021');
assert.deepStrictEqual(jan22[1], [1, '3/1'], 'week 1 of 2022 starts Mon 3 Jan');

// --- Phone: a year where 1 January is itself in week 1 (Thu 1 Jan 2026 -> 2026-W01).
const jan26 = rows(renderMonth(2026, 0).html);
assert.deepStrictEqual(jan26[0], [1, '29/12'], 'row with Thu 1 Jan 2026 is week 1');

// --- Desktop: grid unchanged, no week column.
phoneWidth = false;
const decDesk = renderMonth(2026, 11).html;
assert.ok(!decDesk.includes('agenda-month-week'), 'desktop month grid has no week column');
assert.ok(!decDesk.includes('agenda-month-grid--weeks'), 'desktop grid keeps the 7-column layout');
assert.ok(rows(decDesk).every((r) => r[0] === null), 'no week labels on desktop rows');

console.log('test_agenda_month_week_numbers.js: ok');
