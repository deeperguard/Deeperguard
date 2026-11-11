/**
 * Agenda RRULE editor helpers (agenda-recurrence.js).
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

assert.ok(R && R.parseAgendaRrule && R.buildAgendaRrule);

let p = R.parseAgendaRrule('');
assert.strictEqual(p.kind, 'none');

p = R.parseAgendaRrule('FREQ=WEEKLY;INTERVAL=1;UNTIL=20261231T235959Z');
assert.strictEqual(p.kind, 'weekly');
assert.ok(p.until);

p = R.parseAgendaRrule('FREQ=WEEKLY;INTERVAL=2');
assert.strictEqual(p.kind, 'biweekly');

p = R.parseAgendaRrule('FREQ=MONTHLY;BYDAY=2MO');
assert.strictEqual(p.kind, 'advanced');
assert.strictEqual(p.raw, 'FREQ=MONTHLY;BYDAY=2MO');

const until = new Date(2026, 11, 15, 12, 0, 0);
const built = R.buildAgendaRrule('weekly', until);
assert.ok(built.includes('FREQ=WEEKLY'));
assert.ok(built.includes('INTERVAL=1'));
assert.ok(built.includes('UNTIL='));

const bi = R.buildAgendaRrule('biweekly', until);
assert.ok(bi.includes('INTERVAL=2'));

assert.strictEqual(R.buildAgendaRrule('none', until), '');
assert.strictEqual(R.buildAgendaRrule('advanced', until), null);

p = R.parseAgendaRrule('FREQ=DAILY;INTERVAL=1');
assert.strictEqual(p.kind, 'daily');

p = R.parseAgendaRrule('FREQ=DAILY;INTERVAL=3');
assert.strictEqual(p.kind, 'advanced');
assert.strictEqual(p.raw, 'FREQ=DAILY;INTERVAL=3');

p = R.parseAgendaRrule('FREQ=MONTHLY;INTERVAL=2');
assert.strictEqual(p.kind, 'advanced');

p = R.parseAgendaRrule('FREQ=MONTHLY;INTERVAL=1');
assert.strictEqual(p.kind, 'monthly');

p = R.parseAgendaRrule('FREQ=YEARLY;INTERVAL=1');
assert.strictEqual(p.kind, 'yearly');

const daily = R.buildAgendaRrule('daily', until);
assert.ok(daily.includes('FREQ=DAILY'));

const monthly = R.buildAgendaRrule('monthly', until);
assert.ok(monthly.includes('FREQ=MONTHLY'));

const yearly = R.buildAgendaRrule('yearly', until);
assert.ok(yearly.includes('FREQ=YEARLY'));

assert.strictEqual(typeof R.addMonthsClipped, 'function');
const jan31 = new Date(2025, 0, 31, 10, 0);
const feb = R.addMonthsClipped(jan31, 1);
assert.strictEqual(feb.getFullYear(), 2025);
assert.strictEqual(feb.getMonth(), 1);
assert.strictEqual(feb.getDate(), 28);
const jan29nl = new Date(2025, 0, 29, 9, 0);
const febFrom29 = R.addMonthsClipped(jan29nl, 1);
assert.strictEqual(febFrom29.getMonth(), 1);
assert.strictEqual(febFrom29.getDate(), 28);

console.log('test_agenda_recurrence ok');
