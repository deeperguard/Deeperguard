/**
 * Agenda interactions PR: detail card, colors, copy, empty-slot create hooks.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

assert.ok(agendaJs.includes('EVENT_COLORS'));
assert.ok(agendaJs.includes('openDetailCard'));
assert.ok(agendaJs.includes('renderColorSwatches'));
assert.ok(agendaJs.includes("dblclick"));
assert.ok(agendaJs.includes("Delete this event?"));
assert.ok(html.includes('Meeting link'));
assert.ok(html.includes('Guests'));
assert.ok(html.includes('id="agenda-detail-card"'));
assert.ok(html.includes('btn danger" id="agenda-edit-delete'));
assert.ok(css.includes('.agenda-color-swatch'));

assert.ok(agendaJs.includes('function findOccurrenceForDetail'));
const detailBlock = agendaJs.slice(
  agendaJs.indexOf('function openDetailCard'),
  agendaJs.indexOf('function beginEditFromClick'),
);
assert.ok(detailBlock.includes('occDisplayTitle(occ)'));
assert.ok(detailBlock.includes('occ ? occ.end'));
assert.ok(!/title\.textContent = ev\.title/.test(detailBlock));

console.log('agenda interactions ok');
