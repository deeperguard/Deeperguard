/**
 * Agenda month grid on phone width: at most 3 dots per day and a '+' when the day has more items.
 * Renders the real month grid (agenda.js) with 0, 1, 2, 3, 4 and 5 items on a day, with tasks
 * mixed in, and checks that the desktop grid keeps its chips and "+N more" button.
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

// Five of the event colours the editor offers; an event with such a colour keeps it as its dot colour.
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const dayMs = (d) => new Date(2026, 5, d).getTime();
/** Event on `d` June 2026: one hour from `hour`:00, or the whole day. */
const ev = (d, hour, color, allDay) => ({
  ev: { id: `e-${d}-${hour}`, title: `Event ${hour}`, color, all_day: !!allDay },
  start: allDay ? new Date(2026, 5, d) : new Date(2026, 5, d, hour),
  end: allDay ? new Date(2026, 5, d + 1) : new Date(2026, 5, d, hour + 1),
});
const task = (d, id) => ({
  task: { id, title: `Task ${id}`, due_date: `2026-06-${String(d).padStart(2, '0')}`, due_time: '', done_at: '' },
  dayMs: dayMs(d),
  overdue: false,
});

// Later start times first on purpose: the grid must sort, not just take input order.
const occ = [
  ev(2, 9, COLORS[0]),
  ev(3, 15, COLORS[1]), ev(3, 9, COLORS[0]),
  ev(4, 15, COLORS[2]), ev(4, 11, COLORS[1]), ev(4, 9, COLORS[0]),
  ev(5, 13, COLORS[3]), ev(5, 12, COLORS[2]), ev(5, 11, COLORS[1]), ev(5, 9, COLORS[0]),
  ev(8, 16, COLORS[4]), ev(8, 14, COLORS[3]), ev(8, 12, COLORS[2]), ev(8, 10, COLORS[1]), ev(8, 0, COLORS[0], true),
  ev(9, 9, COLORS[0]),
  ev(10, 9, COLORS[0]), ev(10, 10, COLORS[1]), ev(10, 11, COLORS[2]),
  ev(12, 9, COLORS[0]),
];
const placed = [
  task(9, 't9'),
  task(10, 't10a'), task(10, 't10b'),
  task(11, 't11a'), task(11, 't11b'), task(11, 't11c'), task(11, 't11d'),
  task(12, 't12a'), task(12, 't12b'),
];

function renderMonth() {
  A._state.view = 'month';
  A._state.anchor = new Date(2026, 5, 15);
  A._state.monthPickDay = dayMs(1);
  const range = A.rangeForView();
  return A._renderMonthGrid(range.days, occ, placed);
}

/** Markup of one day cell. */
function cell(html, d) {
  const at = html.indexOf(`data-agenda-month-day="${dayMs(d)}"`);
  assert.ok(at >= 0, `cell for ${d} June`);
  const next = html.indexOf('data-agenda-month-day="', at + 30);
  return html.slice(at, next < 0 ? undefined : next);
}

/** Marks of a day in document order: 'task', an event colour, or '+'. */
function marks(html, d) {
  const list = [];
  const re = /<span class="(agenda-month-dot(?: agenda-month-dot--task)?|agenda-month-dot-more)"(?: style="--agenda-dot:([^"]+)")? aria-hidden="true">(\+?)<\/span>/g;
  let m = re.exec(cell(html, d));
  while (m) {
    if (m[1] === 'agenda-month-dot-more') list.push(m[3]);
    else list.push(m[1].endsWith('--task') ? 'task' : m[2]);
    m = re.exec(cell(html, d));
  }
  return list;
}

// --- Phone ---------------------------------------------------------------------------
phoneWidth = true;
const phone = renderMonth();
assert.deepStrictEqual(marks(phone, 1), [], 'empty day: no dots, no plus');
assert.deepStrictEqual(marks(phone, 2), [COLORS[0]], '1 item: 1 dot');
assert.deepStrictEqual(marks(phone, 3), [COLORS[0], COLORS[1]], '2 items: 2 dots, no plus');
assert.deepStrictEqual(marks(phone, 4), [COLORS[0], COLORS[1], COLORS[2]], '3 items: 3 dots, no plus');
assert.deepStrictEqual(marks(phone, 5), [COLORS[0], COLORS[1], COLORS[2], '+'], '4 items: 3 dots, then a plus');
assert.deepStrictEqual(marks(phone, 8), [COLORS[0], COLORS[1], COLORS[2], '+'],
  '5 items: the first 3 in month order (all-day first, then by start), then one plus');

// Tasks keep their own dot style (task class, no event colour) and count towards the limit.
assert.deepStrictEqual(marks(phone, 9), ['task', COLORS[0]], 'task + event: task dot, then coloured dot');
assert.deepStrictEqual(marks(phone, 12), ['task', 'task', COLORS[0]], '2 tasks + 1 event: exactly 3, no plus');
assert.deepStrictEqual(marks(phone, 10), ['task', 'task', COLORS[0], '+'], '2 tasks + 3 events: 3 dots and a plus');
assert.deepStrictEqual(marks(phone, 11), ['task', 'task', 'task', '+'], '4 tasks: 3 task dots and a plus');

// No day in the whole grid exceeds 3 dots or has more than one plus.
const cells = phone.split('<div class="agenda-month-cell ').slice(1);
assert.ok(cells.length >= 28, 'grid covers the month');
cells.forEach((c) => {
  assert.ok((c.match(/class="agenda-month-dot[ "]/g) || []).length <= 3, 'never more than 3 dots in a cell');
  assert.ok((c.match(/agenda-month-dot-more/g) || []).length <= 1, 'at most one plus in a cell');
});
// The plus is decorative; the day button still names the full counts.
assert.ok(/aria-label="[^"]*5 events"/.test(cell(phone, 8)), 'day button counts all 5 events');
assert.ok(/aria-label="[^"]*3 events, 2 tasks"/.test(cell(phone, 10)), 'day button counts events and tasks');
assert.ok(!phone.includes('agenda-month-more-btn'), 'phone grid has no "+N more" button');

// Rendering twice gives the same markup.
assert.strictEqual(renderMonth(), phone);

// --- Desktop: chips and "+N more" as before, no dots and no plus mark ------------------
phoneWidth = false;
const desk = renderMonth();
assert.ok(!desk.includes('agenda-month-dot'), 'desktop grid has no dots and no plus mark');
const chips = (d) => (cell(desk, d).match(/class="agenda-month-ev"/g) || []).length;
assert.strictEqual(chips(3), 2, 'desktop: 2 events, 2 chips');
assert.strictEqual(chips(4), 3, 'desktop: 3 events, 3 chips');
assert.strictEqual(chips(8), 3, 'desktop: 5 events, 3 chips');
assert.ok(!cell(desk, 4).includes('agenda-month-more-btn'), 'desktop: 3 events fit without a more button');
assert.ok(cell(desk, 8).includes('>+2 more</button>'), 'desktop: 5 events show 3 chips and "+2 more"');
assert.ok(cell(desk, 9).includes('data-agenda-task="t9"'), 'desktop: task chip as before');

console.log('test_agenda_month_dot_limit.js: ok');
