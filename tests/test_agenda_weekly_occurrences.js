/**
 * Weekly/biweekly expansion + inclusive UNTIL (mirrors agenda.js expandEventOccurrences).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'app/static/js/agenda-recurrence.js'), 'utf8'), {
  filename: 'agenda-recurrence.js',
});
const R = global.NotesAgendaRecurrence;

const MS_DAY = 86400000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * MS_DAY);
}

function parseInstant(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

function eventSpan(ev) {
  const a = parseInstant(ev.start);
  const b = parseInstant(ev.end);
  if (!a || !b) return null;
  return { start: a, end: b };
}

/** Keep aligned with app/static/js/agenda.js expandEventOccurrences (timed + RRULE). */
function expandEventOccurrences(ev, rangeStart, rangeEnd) {
  const span = eventSpan(ev);
  if (!span) return [];
  const out = [];
  if (ev.all_day) {
    const ds = startOfDay(span.start).getTime();
    const de = startOfDay(span.end).getTime();
    const rs = startOfDay(rangeStart).getTime();
    const re = rangeEnd.getTime();
    if (de <= rs || ds >= re) return out;
    const clipStart = Math.max(ds, rs);
    const clipEnd = Math.min(de, re);
    if (clipEnd <= clipStart) return out;
    out.push({ ev, start: new Date(clipStart), end: new Date(clipEnd), recurring: false });
    return out;
  }
  if (!ev.rrule || !String(ev.rrule).trim()) {
    if (span.end <= rangeStart || span.start >= rangeEnd) return out;
    out.push({ ev, start: span.start, end: span.end, recurring: false });
    return out;
  }
  const rule = String(ev.rrule).toUpperCase();
  const freqDaily = /FREQ=DAILY/.test(rule);
  const freqWeekly = /FREQ=WEEKLY/.test(rule);
  const intervalMatch = rule.match(/INTERVAL=(\d+)/);
  const interval = intervalMatch ? Math.max(1, Number(intervalMatch[1]) || 1) : 1;
  const untilMatch = rule.match(/UNTIL=([^;:]+)/);
  let until = untilMatch ? R.parseUntil(untilMatch[1]) : null;
  const countMatch = rule.match(/COUNT=(\d+)/);
  const maxCount = countMatch ? Math.max(1, Number(countMatch[1]) || 50) : 400;

  let curStart = new Date(span.start);
  const duration = new Date(span.end) - curStart;
  let n = 0;
  while (n < maxCount && curStart < rangeEnd) {
    if (until && curStart > until) break;
    const ce = new Date(curStart.getTime() + duration);
    if (ce > rangeStart && curStart < rangeEnd) {
      out.push({ ev, start: new Date(curStart), end: ce, recurring: true });
    }
    n += 1;
    if (freqDaily) curStart = addDays(curStart, interval);
    else if (freqWeekly) curStart = addDays(curStart, 7 * interval);
    else break;
  }
  return out;
}

const start = new Date(2026, 2, 4, 9, 30, 0); // Wed
const evWeekly = {
  start: start.toISOString(),
  end: new Date(2026, 2, 4, 10, 30, 0).toISOString(),
  all_day: false,
  rrule: 'FREQ=WEEKLY;INTERVAL=1;UNTIL=20260318T235959Z',
};
const range = { start: startOfDay(new Date(2026, 2, 1)), end: addDays(startOfDay(new Date(2026, 3, 1)), 0) };
const weekly = expandEventOccurrences(evWeekly, range.start, range.end);
assert.strictEqual(weekly.length, 3, 'three Wednesday instances through inclusive until week');

const biStart = new Date(2026, 2, 4, 14, 0, 0);
const evBi = {
  ...evWeekly,
  start: biStart.toISOString(),
  end: new Date(2026, 2, 4, 15, 0, 0).toISOString(),
  rrule: 'FREQ=WEEKLY;INTERVAL=2',
};
const biOcc = expandEventOccurrences(evBi, range.start, range.end);
assert.ok(biOcc.length >= 2);
assert.strictEqual(biOcc[1].start.getTime() - biOcc[0].start.getTime(), 14 * MS_DAY);

const allDay = {
  start: new Date(2026, 2, 10).toISOString(),
  end: new Date(2026, 2, 12).toISOString(),
  all_day: true,
  rrule: '',
};
const adOcc = expandEventOccurrences(allDay, range.start, range.end);
assert.strictEqual(adOcc.length, 1);
assert.strictEqual(adOcc[0].start.getDate(), 10);

const { spawnSync } = require('child_process');
const tzScript = `
  process.env.TZ = 'America/New_York';
  const fs = require('fs');
  const vm = require('vm');
  const root = ${JSON.stringify(root)};
  vm.runInThisContext(fs.readFileSync(root + '/app/static/js/agenda-recurrence.js', 'utf8'));
  const R = global.NotesAgendaRecurrence;
  const built = R.buildAgendaRrule('weekly', new Date(2026, 2, 15, 12, 0, 0));
  if (!built.includes('UNTIL=20260315')) process.exit(1);
  const p = R.parseAgendaRrule(built);
  if (!p.until || p.until.getUTCDate() !== 15) process.exit(2);
`;
const tz = spawnSync(process.execPath, ['-e', tzScript], { encoding: 'utf8' });
if (tz.status !== 0) {
  throw new Error(`DST/TZ occurrence helper failed: ${tz.status} ${tz.stderr}`);
}

console.log('test_agenda_weekly_occurrences ok');
