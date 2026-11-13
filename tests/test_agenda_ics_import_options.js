/** Import options: field stripping and multi-file handling. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'app/static/js/agenda-ics.js'), 'utf8'));
const Ics = global.NotesAgendaIcs;

const ev = (uid, desc) => 'BEGIN:VEVENT\r\nUID:' + uid + '\r\nSUMMARY:S' + uid
  + '\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nDESCRIPTION:' + (desc || 'Secret notes')
  + '\r\nLOCATION:Room 1\r\nATTENDEE:mailto:a@example.com\r\nEND:VEVENT\r\n';
const cal = (b) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + b + 'END:VCALENDAR\r\n';

const rows = Ics.parseIcsFile(cal(ev('a'))).events;
assert.ok(rows[0].notes && rows[0].location && rows[0].attendees.length);

const none = Ics.stripImportFields(rows, {})[0];
assert.deepStrictEqual([none.notes, none.location, none.attendees.length], ['Secret notes', 'Room 1', 1]);
const d = Ics.stripImportFields(rows, { description: true })[0];
assert.strictEqual(d.notes, '');
assert.strictEqual(d.location, 'Room 1');
const at = Ics.stripImportFields(rows, { attendees: true })[0];
assert.deepStrictEqual(at.attendees, []);
assert.strictEqual(at.notes, 'Secret notes');
const lo = Ics.stripImportFields(rows, { locations: true })[0];
assert.strictEqual(lo.location, '');
assert.strictEqual(lo.attendees.length, 1);
assert.strictEqual(rows[0].notes, 'Secret notes', 'input not mutated');

// dropped description also drops a join link taken only from it
const link = Ics.parseIcsFile(cal(ev('l', 'Join https://meet.example.com/x'))).events;
assert.ok(link[0].webcall_url);
assert.strictEqual(Ics.stripImportFields(link, { description: true })[0].webcall_url, '');

// nothing dropped is present in what would be saved
const stripped = Ics.stripImportFields(rows, { description: true, attendees: true, locations: true })[0];
assert.ok(!/Secret notes|Room 1|a@example\.com/.test(JSON.stringify(stripped)));

// multi-file: each file is parsed independently; a bad file does not stop the others
const files = Ics.parseIcsEntries([
  { name: 'a.ics', text: cal(ev('a')) },
  { name: 'bin.ics', text: 'BEGIN:VCALENDAR\u0000\u0000' },
  { name: 'big.ics', text: 'x'.repeat(Ics.MAX_ICS_BYTES + 1) },
  { name: 'b.ics', text: cal(ev('b') + ev('c')) },
]);
assert.deepStrictEqual(files.map((f) => f.events.length), [1, 0, 0, 2]);
assert.deepStrictEqual(files.map((f) => !!f.error), [false, true, true, false]);
const all = files.flatMap((f) => f.events);
assert.strictEqual(Ics.diffImport([], all).new.length, 3);
assert.strictEqual(Ics.diffImport(all.map((r, i) => ({ id: 'i' + i, ...r })), all).unchanged.length, 3);
console.log('ok');
