/**
 * New appointment: end defaults to start + 1 h on the same date (capped at 23:59) and follows
 * the start until the user edits the end. Existing appointments and all-day events never move.
 * Tests the real helpers in agenda-tz.js and the real editor hook in agenda.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'app/static/js/agenda-tz.js'), 'utf8'), { filename: 'agenda-tz.js' });
const agendaSrc = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
vm.runInThisContext(agendaSrc, { filename: 'agenda.js' });
const Tz = global.NotesAgendaTz;
const Agenda = global.NotesAgenda;
const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

// --- defaultEndInput: wall-clock + 1 h, same date, capped at 23:59 -----------------------
const d = Tz.defaultEndInput;
assert.strictEqual(d('2026-11-14T10:00'), '2026-11-14T11:00');
assert.strictEqual(d('2026-11-14T22:15'), '2026-11-14T23:15');
assert.strictEqual(d('2026-11-14T23:30'), '2026-11-14T23:59', 'past midnight -> 23:59 same date');
assert.strictEqual(d('2026-11-14T23:00'), '2026-11-14T23:59');
assert.strictEqual(d('2026-11-14T22:59'), '2026-11-14T23:59');
assert.strictEqual(d('2026-11-14T00:00'), '2026-11-14T01:00');
assert.strictEqual(d(''), '');
assert.strictEqual(d('2026-11-14'), '');
// DST: Amsterdam springs forward 2026-03-29 02:00 and falls back 2026-10-25 03:00;
// the end is the same wall clock + 1 h, and saved in the zone it is exactly what the user sees.
for (const [start, end, zone] of [
  ['2026-03-29T01:30', '2026-03-29T02:30', AMS],
  ['2026-03-29T10:00', '2026-03-29T11:00', AMS],
  ['2026-10-25T02:30', '2026-10-25T03:30', AMS],
  ['2026-10-25T10:00', '2026-10-25T11:00', AMS],
  ['2026-03-08T10:00', '2026-03-08T11:00', NYC],
  ['2026-11-01T10:00', '2026-11-01T11:00', NYC],
]) {
  assert.strictEqual(d(start), end, `${start} ${zone}`);
}
// On the DST days a normal daytime start/end stays a 1 h event and round-trips unchanged.
for (const [day, zone] of [['2026-03-29', AMS], ['2026-10-25', AMS], ['2026-03-08', NYC], ['2026-11-01', NYC]]) {
  const s = Tz.fromLocalInput(`${day}T10:00`, zone);
  const e = Tz.fromLocalInput(d(`${day}T10:00`), zone);
  assert.strictEqual(e - s, 3600000, `${day} ${zone}: 1 h`);
  assert.strictEqual(Tz.toLocalInput(e, zone), `${day}T11:00`);
}

// --- followEndInput: the decision the editor uses ----------------------------------------
const f = Tz.followEndInput;
const fresh = { isNew: true, allDay: false, endTouched: false };
assert.strictEqual(f({ ...fresh, start: '2026-11-14T10:00', end: '2026-11-14T10:00' }), '2026-11-14T11:00');
assert.strictEqual(f({ ...fresh, start: '2026-11-20T23:30', end: '2026-11-14T11:00' }), '2026-11-20T23:59');
assert.strictEqual(f({ ...fresh, endTouched: true, start: '2026-11-14T15:00', end: '2026-11-14T12:45' }), '2026-11-14T12:45', 'user end kept');
assert.strictEqual(f({ ...fresh, isNew: false, start: '2026-11-14T15:00', end: '2026-11-14T12:45' }), '2026-11-14T12:45', 'existing kept');
assert.strictEqual(f({ ...fresh, allDay: true, start: '2026-11-14', end: '2026-11-16' }), '2026-11-16', 'all-day kept');
assert.strictEqual(f({ ...fresh, start: '', end: '2026-11-14T12:00' }), '2026-11-14T12:00', 'bad start keeps end');

// --- The real editor hook in agenda.js (syncEndToStart) ----------------------------------
const els = {
  'agenda-edit-start': { value: '' },
  'agenda-edit-end': { value: '' },
  'agenda-edit-allday': { checked: false },
};
global.document = { getElementById: (id) => els[id] || null };
const state = Agenda._state;
const sync = Agenda._syncEndToStart;
assert.strictEqual(typeof sync, 'function');
const setForm = (start, end, over = {}) => {
  els['agenda-edit-start'].value = start;
  els['agenda-edit-end'].value = end;
  els['agenda-edit-allday'].checked = !!over.allDay;
  state.selectedId = over.id || '';
  state.editorEndTouched = !!over.touched;
};

// New event opened at 10:00: end prefilled 11:00 on the same date; the field stays editable.
setForm('2026-11-14T10:00', '2026-11-14T10:00');
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-14T11:00');
// The user changes the start time and the start date: the end follows.
els['agenda-edit-start'].value = '2026-11-14T13:45';
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-14T14:45');
els['agenda-edit-start'].value = '2026-11-18T23:30';
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-18T23:59');
assert.strictEqual(state.editorEndTouched, false, 'auto-fill never sets the touched flag');
// The user edits the end (the editor's input listener sets the flag): it is no longer overwritten.
els['agenda-edit-end'].value = '2026-11-19T08:00';
state.editorEndTouched = true;
els['agenda-edit-start'].value = '2026-11-18T09:00';
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-19T08:00', 'manual end kept');
// All-day: nothing changes.
setForm('2026-11-14', '2026-11-15', { allDay: true });
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-15');
// Unticking all-day on a new event (start becomes dateT09:00) gives start + 1 h again.
setForm('2026-11-14T09:00', '2026-11-14T09:00');
sync();
assert.strictEqual(els['agenda-edit-end'].value, '2026-11-14T10:00');

// Existing event: the end is never touched, and the value saved is identical to the stored one.
const stored = { start: '2026-11-14T09:00:00.000Z', end: '2026-11-14T09:30:00.000Z', tz: AMS };
setForm(Tz.toLocalInput(Date.parse(stored.start), AMS), Tz.toLocalInput(Date.parse(stored.end), AMS), { id: 'evt-1' });
sync();
els['agenda-edit-start'].value = '2026-11-14T08:00';
sync();
const endInput = els['agenda-edit-end'].value;
assert.strictEqual(endInput, '2026-11-14T10:30');
// Same conversion saveEditor uses for a zoned event: identical ISO string, same format.
const savedEnd = new Date(Tz.fromLocalInput(endInput, AMS)).toISOString();
assert.strictEqual(savedEnd, stored.end, 'existing end saved unchanged');
// New event: the default end is saved in the same ISO format as before.
const newEnd = new Date(Tz.fromLocalInput(Tz.defaultEndInput('2026-11-14T10:00'), AMS)).toISOString();
assert.strictEqual(newEnd, '2026-11-14T10:00:00.000Z');
assert.match(newEnd, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

// Wiring: the editor calls the hook on open, on start edits and after the all-day toggle,
// and only real input on the end field sets the flag.
const openSrc = agendaSrc.slice(agendaSrc.indexOf('function openEditor'), agendaSrc.indexOf('function editorFormSignature'));
assert.ok(/state\.editorEndTouched = false;\s*syncEndToStart\(\);/.test(openSrc), 'openEditor resets flag and fills end');
assert.ok(/syncEditorDatetimeMode\(!!ad\.checked\);\s*syncEndToStart\(\);/.test(agendaSrc), 'all-day toggle re-syncs end');
assert.ok(agendaSrc.includes("getElementById('agenda-edit-start')?.addEventListener(type, syncEndToStart)"));
assert.ok(agendaSrc.includes("getElementById('agenda-edit-end')?.addEventListener(type, () => { state.editorEndTouched = true; })"));
assert.strictEqual((agendaSrc.match(/editorEndTouched = true/g) || []).length, 1, 'flag only set by the end listener');

console.log('agenda default end ok');
