/**
 * Unit tests for earliest-visible-minute scroll helper (mirrors agenda.js logic).
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

/** Same logic as agenda.js earliestVisibleMinutesInPeriod */
function earliestVisibleMinutesInPeriod(occ, days, rangeStart, rangeEnd) {
  let minMin = null;
  for (const d of days) {
    const ds = startOfDay(d);
    const de = addDays(ds, 1);
    if (de <= rangeStart || ds >= rangeEnd) continue;
    for (const o of occ || []) {
      if (!o || !o.ev || o.ev.all_day) continue;
      if (o.end <= ds || o.start >= de) continue;
      const a = o.start < ds ? ds : o.start;
      const b = o.end > de ? de : o.end;
      if (b <= a) continue;
      const mins = (a - ds) / 60000;
      if (minMin === null || mins < minMin) minMin = mins;
    }
  }
  return minMin;
}

function rangeWeek(anchor) {
  const s = startOfWeekMonday(anchor);
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(s, i));
  return { start: s, end: addDays(s, 7), days };
}

// Monday 2026-11-09 week
const anchor = new Date(2026, 10, 10); // Tue
const range = rangeWeek(anchor);
const mon = range.days[0];

const mon14 = { ev: { all_day: false, id: 'a' }, start: new Date(2026, 10, 9, 14, 0, 0), end: new Date(2026, 10, 9, 15, 0, 0) };
const wed08 = { ev: { all_day: false, id: 'b' }, start: new Date(2026, 10, 11, 8, 0, 0), end: new Date(2026, 10, 11, 9, 0, 0) };

let m = earliestVisibleMinutesInPeriod([mon14, wed08], range.days, range.start, range.end);
assert.strictEqual(m, 8 * 60, `expected Wed 08:00 = ${8 * 60} min, got ${m}`);

// Overnight Sun 23:00 → Mon 10:00; visible Monday column starts at 00:00
const sun2300 = new Date(2026, 10, 8, 23, 0, 0);
const mon1000 = new Date(2026, 10, 9, 10, 0, 0);
const overnight = { ev: { all_day: false, id: 'c' }, start: sun2300, end: mon1000 };
m = earliestVisibleMinutesInPeriod([overnight], range.days, range.start, range.end);
assert.strictEqual(m, 0, `overnight on Monday column should count 00:00, got ${m}`);

// Day view: single column
const dayRange = { start: startOfDay(mon), end: addDays(startOfDay(mon), 1), days: [mon] };
m = earliestVisibleMinutesInPeriod([mon14], dayRange.days, dayRange.start, dayRange.end);
assert.strictEqual(m, 14 * 60);

// 3-day Wed anchor
const w = new Date(2026, 10, 11);
const d3 = { start: startOfDay(w), end: addDays(startOfDay(w), 3), days: [w, addDays(w, 1), addDays(w, 2)] };
const th08 = { ev: { all_day: false }, start: new Date(2026, 10, 12, 8, 0, 0), end: new Date(2026, 10, 12, 9, 0, 0) };
const w15 = { ev: { all_day: false }, start: new Date(2026, 10, 11, 15, 0, 0), end: new Date(2026, 10, 11, 16, 0, 0) };
m = earliestVisibleMinutesInPeriod([w15, th08], d3.days, d3.start, d3.end);
assert.strictEqual(m, 8 * 60);

console.log('test_agenda_scroll_logic ok');
