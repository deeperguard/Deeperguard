/**
 * Closing the event editor (Cancel, backdrop, Escape) asks first when there are unsaved edits.
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
const { formSignature, editorHasUnsavedChanges } = global.NotesAgendaScroll;

const form = (over = {}) => [
  { key: 'agenda-edit-title', type: 'text', value: over.title ?? 'Standup' },
  { key: 'agenda-edit-start', type: 'datetime-local', value: '2026-11-12T09:00' },
  { key: 'agenda-edit-allday', type: 'checkbox', value: 'on', checked: !!over.allDay },
  { key: 'agenda-edit-notes', type: 'textarea', value: over.notes ?? '' },
  { key: 'color', type: 'radio', value: '#ff0000', checked: over.color === '#ff0000' },
  { key: 'color', type: 'radio', value: '#00ff00', checked: over.color === '#00ff00' },
  { key: 'agenda-ics-input', type: 'file', value: 'C:\\x.ics' },
  { key: 'agenda-edit-save', type: 'button', value: 'Save' },
];

const opened = formSignature(form());
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form())), false, 'untouched form is clean');
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form({ title: 'Standup 2' }))), true, 'text edit');
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form({ allDay: true }))), true, 'checkbox');
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form({ color: '#00ff00' }))), true, 'radio choice');
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form({ notes: 'x' }))), true, 'textarea');
// Typing and deleting the same text again is not a change.
assert.strictEqual(editorHasUnsavedChanges(opened, formSignature(form({ title: 'Standup' }))), false);
// No snapshot (editor not open): never ask.
assert.strictEqual(editorHasUnsavedChanges(null, formSignature(form({ title: 'x' }))), false);

// Wiring: every way of dismissing goes through the guarded close; save/delete close directly.
const js = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
assert.ok(js.includes("getElementById('agenda-edit-cancel')?.addEventListener('click', requestCloseEditor)"));
assert.ok(js.includes("getElementById('agenda-editor-backdrop')?.addEventListener('click', requestCloseEditor)"));
const esc = js.slice(js.indexOf('function handleEscapeKey'), js.indexOf('function saveEditor'));
assert.ok(esc.includes('requestCloseEditor()'));
assert.ok(!/agenda-editor-open[\s\S]*closeEditor\(\);\s*return true/.test(esc), 'Escape does not close the editor directly');
assert.ok(js.includes('state.editorSnapshot = editorFormSignature()'));
assert.ok(js.includes("title: 'Discard changes'"));
assert.ok(js.includes('state.editorSnapshot = null;'));

console.log('agenda dirty guard ok');
