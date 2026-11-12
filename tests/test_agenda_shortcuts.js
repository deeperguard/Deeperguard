/**
 * Agenda keyboard shortcuts and "Go to date": the key mapper only reacts when the Agenda has the
 * keyboard (no dialog, no text field, no modifier), and the dialog is wired.
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
const { agendaShortcutAction } = global.NotesAgendaScroll;

const free = { paneVisible: true, blocked: false };
const key = (k, over = {}) => ({ key: k, target: { tagName: 'BODY' }, ...over });
const map = {
  t: 'today', T: 'today', ArrowLeft: 'prev', ArrowRight: 'next', n: 'new',
  d: 'view:day', 3: 'view:3day', w: 'view:week', m: 'view:month', l: 'view:agenda',
  g: 'goto', '/': 'search', '?': 'help',
};
for (const [k, action] of Object.entries(map)) {
  assert.strictEqual(agendaShortcutAction(key(String(k)), free), action, `key ${k}`);
}
assert.strictEqual(agendaShortcutAction(key('x'), free), '', 'unknown key');
assert.strictEqual(agendaShortcutAction(key('Escape'), free), '', 'Escape is handled elsewhere');

// Not ours: other tab, open dialog, typing, modifier keys, IME composition.
assert.strictEqual(agendaShortcutAction(key('t'), { paneVisible: false, blocked: false }), '');
assert.strictEqual(agendaShortcutAction(key('t'), { paneVisible: true, blocked: true }), '');
for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
  assert.strictEqual(agendaShortcutAction({ key: 't', target: { tagName: tag } }, free), '', tag);
}
assert.strictEqual(agendaShortcutAction({ key: 't', target: { tagName: 'DIV', isContentEditable: true } }, free), '');
for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
  assert.strictEqual(agendaShortcutAction(key('t', { [mod]: true }), free), '', mod);
}
assert.strictEqual(agendaShortcutAction(key('t', { isComposing: true }), free), '');
assert.strictEqual(agendaShortcutAction(null, free), '');
assert.strictEqual(agendaShortcutAction(key('t'), null), '');

// Wiring in agenda.js and the template.
const js = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
assert.ok(js.includes('wireAgendaShortcutsOnce();') && js.includes('wireAgendaSheetOnce();'));
assert.ok(js.includes('data-agenda-goto'), 'the title opens Go to date');
assert.ok(/function handleEscapeKey[\s\S]*agendaSheetOpen\(\)[\s\S]*closeAgendaSheet\(\)/.test(js), 'Escape closes the sheet');
assert.ok(/function shortcutsBlocked[\s\S]*agenda-editor-open[\s\S]*agenda-sheet-open/.test(js));
assert.ok(html.includes('id="agenda-sheet"') && html.includes('id="agenda-goto-date"') && html.includes('type="date"'));
for (const k of ['Today', 'Previous / next', 'New event', 'Go to date', 'Search']) assert.ok(html.includes(k), k);

console.log('agenda shortcuts ok');
