/**
 * Tests shipped agenda-scroll-core.js (same module the PWA loads before agenda.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const corePath = path.join(root, 'app/static/js/agenda-scroll-core.js');
vm.runInThisContext(fs.readFileSync(corePath, 'utf8'), { filename: 'agenda-scroll-core.js' });
const Core = global.NotesAgendaScroll;
assert.ok(Core && typeof Core.scheduleFingerprint === 'function');

const {
  scheduleFingerprint,
  earliestVisibleMinutesInPeriod,
  preferredTimeGridScrollTop,
  clampTimeGridScrollTop,
  pickTimeGridScrollTop,
  startOfDay,
  addDays,
} = Core;

const PX = 52;
const VIEW_H = 400;

function startOfWeekMonday(d) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  return addDays(x, -diff);
}

function rangeWeek(anchor) {
  const s = startOfWeekMonday(anchor);
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(s, i));
  return { start: s, end: addDays(s, 7), days };
}

const anchor = new Date(2026, 10, 10);
const range = rangeWeek(anchor);
const mon = range.days[0];

const mon14 = { ev: { all_day: false, id: 'a' }, start: new Date(2026, 10, 9, 14, 0, 0), end: new Date(2026, 10, 9, 15, 0, 0) };
const wed08 = { ev: { all_day: false, id: 'b' }, start: new Date(2026, 10, 11, 8, 0, 0), end: new Date(2026, 10, 11, 9, 0, 0) };

let m = earliestVisibleMinutesInPeriod([mon14, wed08], range.days, range.start, range.end);
assert.strictEqual(m, 8 * 60, `expected Wed 08:00 = ${8 * 60} min, got ${m}`);

const sun2300 = new Date(2026, 10, 8, 23, 0, 0);
const mon1000 = new Date(2026, 10, 9, 10, 0, 0);
const overnight = { ev: { all_day: false, id: 'c' }, start: sun2300, end: mon1000 };
m = earliestVisibleMinutesInPeriod([overnight], range.days, range.start, range.end);
assert.strictEqual(m, 0, `overnight on Monday column should count 00:00, got ${m}`);

const dayRange = { start: startOfDay(mon), end: addDays(startOfDay(mon), 1), days: [mon] };
m = earliestVisibleMinutesInPeriod([mon14], dayRange.days, dayRange.start, dayRange.end);
assert.strictEqual(m, 14 * 60);

const w = new Date(2026, 10, 11);
const d3 = { start: startOfDay(w), end: addDays(startOfDay(w), 3), days: [w, addDays(w, 1), addDays(w, 2)] };
const th08 = { ev: { all_day: false, id: 'd' }, start: new Date(2026, 10, 12, 8, 0, 0), end: new Date(2026, 10, 12, 9, 0, 0) };
const w15 = { ev: { all_day: false, id: 'e' }, start: new Date(2026, 10, 11, 15, 0, 0), end: new Date(2026, 10, 11, 16, 0, 0) };
m = earliestVisibleMinutesInPeriod([w15, th08], d3.days, d3.start, d3.end);
assert.strictEqual(m, 8 * 60);

const weekStart = new Date(2026, 10, 9);
const range2 = {
  start: weekStart,
  end: addDays(weekStart, 7),
  days: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
};
const fp0 = scheduleFingerprint([mon14], range2.start, range2.end);
const fp1 = scheduleFingerprint([mon14, wed08], range2.start, range2.end);
assert.notStrictEqual(fp0, fp1);

let top = pickTimeGridScrollTop({
  currentFingerprint: fp0,
  storedFingerprint: fp0,
  storedScrollTop: 900,
  displayOcc: [mon14],
  range: range2,
});
assert.strictEqual(top, 900, 'matching fp uses saved scroll');

const fpFull = scheduleFingerprint([mon14, wed08], range2.start, range2.end);
const fpSearchFiltered = scheduleFingerprint([mon14], range2.start, range2.end);
assert.notStrictEqual(fpFull, fpSearchFiltered, 'filtered occ must differ from full schedule');

top = pickTimeGridScrollTop({
  currentFingerprint: fpFull,
  storedFingerprint: fpFull,
  storedScrollTop: 1200,
  displayOcc: [mon14],
  range: range2,
});
assert.strictEqual(top, 1200, 'search filter must not bust scroll fp');

const scrollOpts = { pxPerHour: PX, viewportHeight: VIEW_H };
const frozenNow = new Date(2020, 0, 1);
const scrollOptsFrozen = { ...scrollOpts, now: frozenNow };
top = pickTimeGridScrollTop({
  currentFingerprint: fpFull,
  storedFingerprint: fpFull,
  storedScrollTop: 446,
  displayOcc: [mon14, wed08],
  range: range2,
  opts: scrollOpts,
});
assert.strictEqual(top, 446, 'view-hop snapshot: matching fp restores exact saved scroll');

top = pickTimeGridScrollTop({
  currentFingerprint: '',
  storedFingerprint: '',
  storedScrollTop: 416,
  displayOcc: [mon14, wed08],
  range: range2,
  opts: scrollOptsFrozen,
});
const anchorNoToday = new Date(2030, 0, 6);
const rangeNoToday = {
  start: anchorNoToday,
  end: addDays(anchorNoToday, 7),
  days: Array.from({ length: 7 }, (_, i) => addDays(anchorNoToday, i)),
};
const wantEmptyFp = preferredTimeGridScrollTop([mon14, wed08], range2, scrollOptsFrozen);
assert.strictEqual(top, wantEmptyFp, 'empty fingerprint must not restore stale scrollTop');

top = pickTimeGridScrollTop({
  currentFingerprint: fp1,
  storedFingerprint: fp0,
  storedScrollTop: 900,
  displayOcc: [mon14, wed08],
  range: range2,
  opts: scrollOptsFrozen,
});
const want = preferredTimeGridScrollTop([mon14, wed08], range2, scrollOptsFrozen);
assert.strictEqual(top, want, 'schedule change invalidates saved scroll');

const ev2030 = { ev: { all_day: false, id: 'z' }, start: new Date(2030, 0, 7, 8, 0, 0), end: new Date(2030, 0, 7, 9, 0, 0) };
const nearTop = preferredTimeGridScrollTop([ev2030], rangeNoToday, { pxPerHour: PX, viewportHeight: VIEW_H });
assert.strictEqual(nearTop, 8 * PX - 72, 'earliest event near top of viewport (08:00)');

const noEvents = preferredTimeGridScrollTop([], rangeNoToday, {
  pxPerHour: PX,
  viewportHeight: VIEW_H,
  defaultDayStartHour: 8,
  now: new Date(2020, 0, 1),
});
assert.strictEqual(noEvents, 8 * PX, 'empty schedule uses default morning band');

const clamped = clampTimeGridScrollTop(9000, 1200, VIEW_H);
assert.strictEqual(clamped, 1200 - VIEW_H, 'clamp scroll top to max');

assert.ok(Core.isTimeGridLayoutReady);
assert.strictEqual(Core.isTimeGridLayoutReady(0, VIEW_H), false, 'clientHeight 0 → not ready');
assert.strictEqual(Core.isTimeGridLayoutReady(1200, 0), false, 'scrollHeight 0 → not ready');
assert.strictEqual(Core.isTimeGridLayoutReady(1200, VIEW_H), true);
assert.strictEqual(Core.isTimeGridLayoutReady(VIEW_H, VIEW_H), false, 'not scrollable until sh > ch');

const wronglyEarly = clampTimeGridScrollTop(446, 0, 0);
assert.strictEqual(wronglyEarly, 0, 'layout-not-ready clamp would zero scroll — defer placement instead');

console.log('test_agenda_scroll_core ok');
