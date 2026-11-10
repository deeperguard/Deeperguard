/**
 * Agenda PR A: phone header, FAB, list label, range title, month dots contract.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

assert.ok(agendaJs.includes('agenda-top-row-phone'));
assert.ok(agendaJs.includes('agenda-phone-menu'));
assert.ok(agendaJs.includes('agenda-fab-add'));
assert.ok(agendaJs.includes('agenda-month-dot'));
assert.ok(agendaJs.includes('agenda-month-more-btn'));
assert.ok(agendaJs.includes('agenda-month-daylist'));
assert.ok(agendaJs.includes("label: 'List'"));
assert.ok(agendaJs.includes('formatRangeTitle'));
assert.ok(agendaJs.includes('agenda-title-week'));
assert.ok(agendaJs.includes('defaultAgendaView'));
assert.ok(html.includes('id="agenda-fab-add"'));
assert.ok(css.includes('.agenda-top-phone'));
assert.ok(css.includes('.agenda-fab-add'));
assert.ok(css.includes('.agenda-month-dot'));
assert.ok(css.includes('#app[data-app-tab="agenda"] .fab-stack'));

console.log('agenda phone layout ok');
