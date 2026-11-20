/**
 * Agenda month grid: the selected day and today are marked apart on phone width.
 * Renders the real grid for the current month and checks the classes and aria attributes.
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

const todayMs = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
const today = new Date(todayMs);
// A day in the same month that is not today.
const otherMs = new Date(today.getFullYear(), today.getMonth(), today.getDate() === 15 ? 16 : 15).getTime();

function render(pickMs) {
  A._state.view = 'month';
  A._state.anchor = new Date(today.getFullYear(), today.getMonth(), 10);
  A._state.monthPickDay = pickMs;
  const range = A.rangeForView();
  return A._renderMonthGrid(range.days, [], []);
}
const cellsOf = (html) => html.split('<div class="agenda-month-cell ').slice(1);
const classesOf = (c) => c.slice(0, c.indexOf('"')).split(/\s+/).filter(Boolean);
const cellFor = (html, ms) => cellsOf(html).find((c) => c.includes(`data-agenda-month-day="${ms}"`));

// Phone, another day selected: exactly one picked cell, today separate with aria-current.
phoneWidth = true;
let html = render(otherMs);
let cells = cellsOf(html);
assert.strictEqual(cells.filter((c) => classesOf(c).includes('is-pick')).length, 1, 'exactly one selected day');
assert.ok(classesOf(cellFor(html, otherMs)).includes('is-pick'), 'the chosen day is the selected one');
assert.ok(classesOf(cellFor(html, todayMs)).includes('is-today'), 'today keeps its own class');
assert.ok(!classesOf(cellFor(html, todayMs)).includes('is-pick'), 'today is not selected');
assert.strictEqual((html.match(/aria-current="date"/g) || []).length, 1, 'one aria-current');
assert.ok(/aria-pressed="false"[^>]*aria-current="date"/.test(cellFor(html, todayMs)), 'aria-current on today');
assert.ok(/aria-pressed="true"/.test(cellFor(html, otherMs)) && !cellFor(html, otherMs).includes('aria-current'),
  'selected day is pressed and not current');
assert.strictEqual((html.match(/aria-pressed="true"/g) || []).length, 1, 'one pressed day');

// Phone, today selected: still one selected cell and today stays recognisable.
html = render(todayMs);
cells = cellsOf(html);
assert.strictEqual(cells.filter((c) => classesOf(c).includes('is-pick')).length, 1, 'one selected day');
const t = classesOf(cellFor(html, todayMs));
assert.ok(t.includes('is-pick') && t.includes('is-today'), 'today selected: both classes');
assert.ok(/aria-pressed="true"[^>]*aria-current="date"/.test(cellFor(html, todayMs)), 'pressed and current');

// Desktop: no phone-only attributes.
phoneWidth = false;
html = render(otherMs);
assert.ok(!html.includes('aria-current') && !html.includes('aria-pressed'), 'desktop grid unchanged');
console.log('ok');
