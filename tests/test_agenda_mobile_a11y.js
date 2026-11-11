const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');

assert.ok(css.includes('.agenda-icon-btn {') && css.includes('min-width: var(--touch)'));
assert.ok(css.includes('.agenda-seg {') && css.includes('min-height: var(--touch)'));
assert.ok(css.includes('body.agenda-editor-open'));
assert.ok(css.includes('@media (max-width: 768px)'));
assert.ok(css.includes('@media (max-width: 430px)'));

assert.ok(html.includes('id="agenda-calendar-settings"'));
assert.match(html, /agenda-calendar-settings[^>]*role="dialog"/);
assert.match(html, /agenda-calendar-settings[^>]*aria-modal="true"/);
assert.ok(html.includes('id="agenda-calendar-settings-close" aria-label="Close calendar settings"'));
assert.ok(html.includes('id="agenda-editor"') && html.includes('role="dialog"'));

assert.ok(agendaJs.includes('editorReturnFocus'));
assert.ok(agendaJs.includes('calendarSettingsReturnFocus'));
assert.ok(agendaJs.includes("document.body.classList.add('agenda-editor-open')"));
assert.ok(agendaJs.includes("document.body.classList.remove('agenda-editor-open')"));
assert.ok(agendaJs.includes('aria-label="Search events"'));
assert.ok(agendaJs.includes('function handleEscapeKey'));
const escFn = agendaJs.slice(agendaJs.indexOf('function handleEscapeKey'), agendaJs.indexOf('function handleEscapeKey') + 1200);
assert.ok(escFn.includes('agenda-scope-chooser') && escFn.includes('closeScopeChooser()'));
const scopeEscape = escFn.indexOf('agenda-scope-chooser');
const detailEscape = escFn.indexOf('agenda-detail');
const editorEscape = escFn.indexOf("getElementById('agenda-editor')");
assert.ok(
  scopeEscape >= 0 && detailEscape > scopeEscape && editorEscape > detailEscape,
  'Escape: scope chooser, then detail card, then editor',
);
assert.ok(agendaJs.includes('applyEditorScopeUi'));
assert.ok(agendaJs.includes('focusEditorReturnTarget'));
assert.ok(agendaJs.includes('#agenda-search') && css.includes('min-height: 44px'));

console.log('agenda mobile a11y ok');
