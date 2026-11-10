/**
 * Overlap column layout: connected clusters share colCount; lone events span full width.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const agendaSrc = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const sandbox = { globalThis: {}, console, document: { documentElement: { lang: 'en' } } };
sandbox.global = sandbox.globalThis;
vm.runInThisContext(agendaSrc, { filename: 'agenda.js' });
const layout = global.NotesAgenda._layoutDayColumns;
assert.strictEqual(typeof layout, 'function');

const day = new Date(2026, 10, 12, 0, 0, 0, 0);

function occ(startH, startM, endH, endM, id) {
  const start = new Date(day);
  start.setHours(startH, startM, 0, 0);
  const end = new Date(day);
  end.setHours(endH, endM, 0, 0);
  return { ev: { id, all_day: false }, start, end };
}

const lone = layout([occ(15, 0, 16, 0, 'solo')], day);
assert.strictEqual(lone.length, 1);
assert.strictEqual(lone[0].col, 0);
assert.strictEqual(lone[0].colCount, 1);

const chain = layout(
  [
    occ(10, 0, 11, 0, 'a'),
    occ(10, 15, 11, 15, 'b'),
    occ(11, 0, 12, 0, 'c'),
  ],
  day,
);
const byId = Object.fromEntries(chain.map((p) => [p.ev.id, p]));
assert.strictEqual(byId.a.colCount, byId.b.colCount);
assert.strictEqual(byId.b.colCount, byId.c.colCount);
assert.ok(byId.a.colCount >= 2);

console.log('agenda overlap layout ok');
