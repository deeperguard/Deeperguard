/**
 * Agenda clock: the now-line moves every minute, "today" changes at midnight,
 * and nothing runs while the page is hidden.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
vm.runInThisContext(
  fs.readFileSync(path.join(root, 'app/static/js/agenda-scroll-core.js'), 'utf8'),
  { filename: 'agenda-scroll-core.js' },
);
const Core = global.NotesAgendaScroll;

// nowLineTop: 52 px per hour
assert.strictEqual(Core.nowLineTop(new Date(2026, 10, 12, 0, 0, 0), 52), 0);
assert.strictEqual(Core.nowLineTop(new Date(2026, 10, 12, 12, 0, 0), 52), 12 * 52);
assert.strictEqual(Core.nowLineTop(new Date(2026, 10, 12, 9, 30, 0), 52), 9.5 * 52);

function fakeEnv(startDate) {
  let current = startDate;
  let handler = null;
  let handle = 0;
  return {
    set now(d) { current = d; },
    deps: {
      now: () => current,
      setInterval: (fn, ms) => { assert.strictEqual(ms, 60000); handler = fn; handle += 1; return handle; },
      clearInterval: () => { handler = null; },
      isVisible: () => env.visible,
    },
    fire: () => { if (handler) handler(); },
    get active() { return handler !== null; },
  };
}
const env = fakeEnv(new Date(2026, 10, 12, 23, 58, 0));
env.visible = true;

const events = [];
const clock = Core.createMinuteClock(
  {
    onMinute: (n) => events.push(['minute', n.getHours() * 60 + n.getMinutes()]),
    onNewDay: (n) => events.push(['day', n.getDate()]),
  },
  env.deps,
);
assert.strictEqual(clock.running, false);
clock.start();
clock.start(); // second start is a no-op
assert.strictEqual(clock.running, true);

env.now = new Date(2026, 10, 12, 23, 59, 0);
env.fire();
assert.deepStrictEqual(events, [['minute', 23 * 60 + 59]], 'minute tick moves the line');

env.now = new Date(2026, 10, 13, 0, 0, 0);
env.fire();
assert.deepStrictEqual(events[1], ['day', 13], 'midnight reports a new day instead of a minute tick');

env.now = new Date(2026, 10, 13, 0, 1, 0);
env.fire();
assert.deepStrictEqual(events[2], ['minute', 1], 'back to minute ticks on the new day');

// Hidden page: no callbacks; catch-up when visible again (after several days away: one new-day).
env.visible = false;
env.now = new Date(2026, 10, 16, 8, 0, 0);
env.fire();
assert.strictEqual(events.length, 3, 'nothing happens while hidden');
env.visible = true;
clock.tick();
assert.deepStrictEqual(events[3], ['day', 16], 'catch-up tick after returning reports the new day once');

clock.stop();
assert.strictEqual(env.active, false);
assert.strictEqual(clock.running, false);

// Source wiring
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
assert.ok(agendaJs.includes('startMinuteClock()'));
assert.ok(agendaJs.includes("addEventListener('visibilitychange'"));
assert.ok(agendaJs.includes('NotesAgendaScroll.nowLineTop'));

console.log('agenda clock ok');
