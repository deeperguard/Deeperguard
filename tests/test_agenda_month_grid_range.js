/**
 * Agenda month view: grid day range must include every calendar day in the
 * anchor month, including when the month ends on a Monday (Nov 2026).
 */
const assert = require('assert');

const MS_DAY = 86400000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * MS_DAY);
}

function startOfWeekMonday(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  return addDays(x, -diff);
}

/** Mirrors app/static/js/agenda.js rangeForView() month branch (grid days only). */
function monthGridDays(anchor) {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const gridStart = startOfWeekMonday(first);
  const gridEndWeekExclusive = addDays(startOfWeekMonday(last), 7);
  const weekStarts = [];
  let cur = gridStart;
  while (cur < gridEndWeekExclusive) {
    weekStarts.push(cur);
    cur = addDays(cur, 7);
  }
  const nWeeks = Math.max(1, weekStarts.length);
  const out = [];
  for (let i = 0; i < nWeeks * 7; i += 1) out.push(addDays(gridStart, i));
  return out;
}

// --- Nov 2026: last day is Monday 30; must appear in the month grid.
const nov2026 = new Date(2026, 10, 15);
const daysNov = monthGridDays(nov2026);
const nov30 = daysNov.filter(
  (d) => d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 30,
);
assert.strictEqual(nov30.length, 1, 'Nov 2026 must include Mon 30');
assert.strictEqual(nov30[0].getDay(), 1, 'Nov 30 2026 should be Monday');
const lastNovDay = daysNov[daysNov.length - 1];
assert.strictEqual(lastNovDay.getMonth(), 11, 'trailing week should extend into December');
assert.strictEqual(lastNovDay.getDate(), 6, 'last grid cell should be Sun Dec 6');

// --- Dec 2025: month starts on Monday; first week is wholly in-month.
const dec2025 = new Date(2025, 11, 10);
const daysDec = monthGridDays(dec2025);
assert.strictEqual(daysDec[0].getTime(), new Date(2025, 11, 1).getTime(), 'grid starts Mon Dec 1');
assert.ok(
  daysDec.some((d) => d.getFullYear() === 2025 && d.getMonth() === 11 && d.getDate() === 31),
  'Dec 2025 must include Wed 31',
);

// Sanity: February 2026 (non-leap) still has full month coverage
const feb2026 = new Date(2026, 1, 1);
const daysFeb = monthGridDays(feb2026);
assert.ok(
  daysFeb.some((d) => d.getFullYear() === 2026 && d.getMonth() === 1 && d.getDate() === 28),
  'Feb 2026 must include the 28th',
);
