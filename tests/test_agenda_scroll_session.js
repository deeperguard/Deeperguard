/**
 * Session scroll pairing: saved position applies only when schedule fingerprint matches;
 * new/earlier event changes fingerprint → scroll to earliest visible minute.
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

function scrollPeriodKey(view, anchor, range) {
  if (!range) return '';
  if (view === 'week') return `${view}|${range.start.getTime()}`;
  if (view === 'day') return `${view}|${range.start.getTime()}`;
  if (view === '3day') return `${view}|${range.start.getTime()}`;
  return '';
}

function scheduleFingerprint(occ, rangeStart, rangeEnd) {
  const parts = [];
  for (const o of occ || []) {
    if (!o || !o.ev) continue;
    if (o.end <= rangeStart || o.start >= rangeEnd) continue;
    const id = String(o.ev.id || '');
    parts.push(`${id}|${o.start.getTime()}|${o.end.getTime()}|${!!o.ev.all_day}`);
  }
  parts.sort();
  return parts.join(';');
}

function earliestVisibleMinutesInPeriod(occ, days, rangeStart, rangeEnd) {
  let minMin = null;
  for (const d of days || []) {
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

const PX_PER_HOUR = 52;
const SCROLL_LEAD_HOURS = 1;
const DEFAULT_DAY_START_HOUR = 8;

function preferredTimeGridScrollTop(occ, range) {
  const minMin = earliestVisibleMinutesInPeriod(occ, range.days, range.start, range.end);
  if (minMin === null) return DEFAULT_DAY_START_HOUR * PX_PER_HOUR;
  const h = minMin / 60;
  return Math.max(0, (h - SCROLL_LEAD_HOURS) * PX_PER_HOUR);
}

function pickScrollTop({ view, range, occ, session }) {
  const pk = scrollPeriodKey(view, null, range);
  const sk = pk ? `notes_agenda_scroll_${pk}` : '';
  const fk = pk ? `notes_agenda_scroll_fp_${pk}` : '';
  const fp = scheduleFingerprint(occ, range.start, range.end);
  const storedFp = session[fk];
  const raw = session[sk];
  let top = null;
  if (storedFp === fp && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) top = n;
  }
  if (top === null) top = preferredTimeGridScrollTop(occ, range);
  return top;
}

// Week of Mon Nov 9 2026
const weekStart = new Date(2026, 10, 9);
const range = {
  start: weekStart,
  end: addDays(weekStart, 7),
  days: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
};
const mon14 = { ev: { id: 'a', all_day: false }, start: new Date(2026, 10, 9, 14, 0, 0), end: new Date(2026, 10, 9, 15, 0, 0) };
const wed08 = { ev: { id: 'b', all_day: false }, start: new Date(2026, 10, 11, 8, 0, 0), end: new Date(2026, 10, 11, 9, 0, 0) };

let session = {};
let fp0 = scheduleFingerprint([mon14], range.start, range.end);
session[`notes_agenda_scroll_fp_${scrollPeriodKey('week', null, range)}`] = fp0;
session[`notes_agenda_scroll_${scrollPeriodKey('week', null, range)}`] = '900';
let top = pickScrollTop({ view: 'week', range, occ: [mon14], session });
assert.strictEqual(top, 900, 'matching fp uses saved scroll');

const occ2 = [mon14, wed08];
let fp1 = scheduleFingerprint(occ2, range.start, range.end);
assert.notStrictEqual(fp0, fp1);
session[`notes_agenda_scroll_fp_${scrollPeriodKey('week', null, range)}`] = fp0;
session[`notes_agenda_scroll_${scrollPeriodKey('week', null, range)}`] = '900';
top = pickScrollTop({ view: 'week', range, occ: occ2, session });
const want = preferredTimeGridScrollTop(occ2, range);
assert.strictEqual(top, want, 'fp mismatch → scroll to earliest visible (Wed 08)');

console.log('test_agenda_scroll_session ok');
