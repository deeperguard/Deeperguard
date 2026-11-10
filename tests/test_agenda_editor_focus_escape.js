/**
 * Agenda editor: return focus to opening chip; Escape stack vs notes filters.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

assert.ok(agendaJs.includes('function rememberEditorReturnFocus'));
assert.ok(agendaJs.includes('rememberEditorReturnFocus(btn, id, occurrenceMs)'));
assert.ok(agendaJs.includes('openScopeChooser'));
assert.ok(
  agendaJs.indexOf('rememberEditorReturnFocus') < agendaJs.indexOf('openScopeChooser'),
  'chip remembers focus before scope chooser',
);
assert.ok(agendaJs.includes('if (!editorReturnFocus)'));
assert.ok(agendaJs.includes('function queryEditorReturnFocusChip'));
assert.ok(agendaJs.includes('function focusEditorReturnTarget'));
assert.ok(agendaJs.includes('closeScopeChooser({ restoreFocus: false })'));
assert.ok(agendaJs.includes('function handleEscapeKey'));
assert.ok(agendaJs.includes("addEventListener('keydown', handleEscapeKey, true)"));
assert.ok(agendaJs.includes('agenda-scope-chooser'));
assert.match(appJs, /NotesAgenda\.handleEscapeKey\(event\)/);
const escapeBlock = appJs.slice(appJs.lastIndexOf("if (event.key !== 'Escape') return;"));
const escIdx = escapeBlock.indexOf('NotesAgenda.handleEscapeKey');
const filterIdx = escapeBlock.indexOf("search-filters-open");
assert.ok(escIdx > 0 && filterIdx > escIdx, 'app Escape runs agenda stack before search-filters');

console.log('test_agenda_editor_focus_escape.js: ok');
