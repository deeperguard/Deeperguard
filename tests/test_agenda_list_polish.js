/**
 * Agenda PR B: list grouping, overlap columns, chip polish contracts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

assert.ok(agendaJs.includes('function listDayHeading'));
assert.ok(agendaJs.includes('agendaUiLocale'));
assert.ok(agendaJs.includes('agenda-list-empty'));
assert.ok(agendaJs.includes('function listEmptyMessage'));
assert.ok(agendaJs.includes('agenda-list-day-head'));
const listHeadingBlock = agendaJs.slice(
  agendaJs.indexOf('function listDayHeading'),
  agendaJs.indexOf('function listEmptyMessage'),
);
assert.ok(!listHeadingBlock.includes("weekday: 'long'"));
assert.ok(agendaJs.includes('agenda-list-when'));
assert.ok(agendaJs.includes('agenda-list-loc'));
assert.ok(agendaJs.includes('layoutAllDayLanes'));
assert.ok(agendaJs.includes('clusterMax'));
assert.ok(agendaJs.includes('is-compact'));
assert.ok(agendaJs.includes('grid-row:${lane + 1}'));
assert.ok(css.includes('.agenda-list-day-head'));
assert.ok(css.includes('.agenda-list-when'));
assert.ok(css.includes('html:not([data-theme="dark"]) .agenda-chip-time'));
assert.ok(css.includes('--agenda-allday-lanes'));

console.log('agenda list polish ok');
