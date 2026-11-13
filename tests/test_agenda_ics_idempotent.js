/** Idempotent .ics import: diffImport keys, UID fallback, source labels. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'app/static/js/agenda-ics.js'), 'utf8'));
const Ics = global.NotesAgendaIcs;

const ev = (uid, summary, extra) => 'BEGIN:VEVENT\r\n' + (uid ? 'UID:' + uid + '\r\n' : '') + 'SUMMARY:' + summary
  + '\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\n' + (extra || '') + 'END:VEVENT\r\n';
const cal = (b) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + b + 'END:VCALENDAR\r\n';
const stored = (rows, source) => rows.map((r, i) => ({ id: 'id' + i, ...r, source }));
const counts = (d) => [d.new.length, d.changed.length, d.unchanged.length];

// re-import same file: zero new
const file = cal(ev('a', 'One') + ev('b', 'Two') + ev(null, 'No uid'));
const first = Ics.parseIcsFile(file).events;
assert.strictEqual(Ics.diffImport([], first).new.length, 3);
const existing = stored(first, 'f.ics (2026-11-13)');
assert.deepStrictEqual(counts(Ics.diffImport(existing, Ics.parseIcsFile(file).events)), [0, 0, 3]);
assert.ok(first[2].ical_uid.startsWith('nouid-'));

// changed SUMMARY
const edited = cal(ev('a', 'One!') + ev('b', 'Two') + ev(null, 'No uid'));
assert.deepStrictEqual(counts(Ics.diffImport(existing, Ics.parseIcsFile(edited).events)), [0, 1, 2]);

// recurrence overrides
const series = ev('r', 'Weekly', 'RRULE:FREQ=WEEKLY\r\n');
const over = (s) => 'BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20260108T100000Z\r\nSUMMARY:' + s
  + '\r\nDTSTART:20260108T120000Z\r\nDTEND:20260108T130000Z\r\nEND:VEVENT\r\n';
const rows = Ics.parseIcsFile(cal(series + over('Moved'))).events;
const master = { id: 'm', ...rows[0], ics_occurrence_overrides: { [rows[1].ics_recurrence_id]: rows[1] } };
assert.deepStrictEqual(counts(Ics.diffImport([master], rows)), [0, 0, 2]);
assert.deepStrictEqual(counts(Ics.diffImport([master], Ics.parseIcsFile(cal(series + over('Moved again'))).events)), [0, 1, 1]);
assert.deepStrictEqual(counts(Ics.diffImport([{ id: 'm', ...rows[0] }], rows)), [1, 0, 1]);

// bulk removal by source; legacy events without source untouched
const mixed = [...existing, { id: 'legacy', ical_uid: 'z', title: 'L' }, { id: 'other', source: 'x.ics (2026-01-01)' }];
assert.deepStrictEqual(Ics.idsWithSource(mixed, 'f.ics (2026-11-13)'), ['id0', 'id1', 'id2']);
assert.deepStrictEqual(Ics.idsWithSource(mixed, ''), []);
assert.strictEqual(Ics.makeSourceLabel('a.ics', new Date('2026-11-13T10:00:00Z')), 'a.ics (2026-11-13)');
console.log('ok');
