/**
 * Editor series notice: hidden for new/one-off; copy for occurrence vs series (#323 fix).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const agendaPath = path.join(root, 'app/static/js/agenda.js');
const agendaSrc = fs.readFileSync(agendaPath, 'utf8');

assert.ok(
  agendaSrc.includes('fillRecurrenceEditor') && agendaSrc.includes("notice.hidden = !String(rrule || '').trim()"),
  'fillRecurrenceEditor still hides notice when no rrule',
);
assert.ok(
  !agendaSrc.includes('applyEditorScopeUi(scope);\n'),
  'applyEditorScopeUi must receive rrule after fillRecurrenceEditor',
);

vm.runInThisContext(agendaSrc, { filename: 'agenda.js' });
const seriesNoticeForEditor = global.NotesAgenda.seriesNoticeForEditor;
assert.strictEqual(typeof seriesNoticeForEditor, 'function');

const SERIES = 'Changes apply to the entire recurring series.';
const OCC = 'Editing this occurrence only. Other dates in the series stay unchanged.';
const weekly = 'FREQ=WEEKLY;INTERVAL=1';

assert.deepStrictEqual(seriesNoticeForEditor('series', ''), { hidden: true, text: '' });
assert.deepStrictEqual(seriesNoticeForEditor('series', '   '), { hidden: true, text: '' });
assert.deepStrictEqual(seriesNoticeForEditor('occurrence', ''), { hidden: true, text: '' });

const seriesWeekly = seriesNoticeForEditor('series', weekly);
assert.strictEqual(seriesWeekly.hidden, false);
assert.strictEqual(seriesWeekly.text, SERIES);

const occWeekly = seriesNoticeForEditor('occurrence', weekly);
assert.strictEqual(occWeekly.hidden, false);
assert.strictEqual(occWeekly.text, OCC);

console.log('test_agenda_editor_scope_notice ok');
