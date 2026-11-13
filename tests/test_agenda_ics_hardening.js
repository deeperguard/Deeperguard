/** Untrusted .ics hardening: size, binary, event count, RRULE caps, links, no network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let fetchCalls = 0;
let xhrCalls = 0;
global.fetch = () => { fetchCalls += 1; throw new Error('network'); };
global.XMLHttpRequest = function X() { xhrCalls += 1; throw new Error('network'); };
for (const f of ['agenda-ics.js', 'agenda-recurrence.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'app/static/js', f), 'utf8'));
}
const Ics = global.NotesAgendaIcs;
const Rec = global.NotesAgendaRecurrence;

const vevent = (i, extra) => 'BEGIN:VEVENT\r\nUID:u' + i + '\r\nSUMMARY:E' + i
  + '\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\n' + (extra || '') + 'END:VEVENT\r\n';
const cal = (body) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + body + 'END:VCALENDAR\r\n';

// oversized file
assert.throws(() => Ics.validateIcsFile({ name: 'a.ics', size: 10 * 1024 * 1024 + 1, type: 'text/calendar' }), /10 MB/);
assert.throws(() => Ics.parseIcsFile('x'.repeat(10 * 1024 * 1024 + 1)), /10 MB/);
Ics.validateIcsFile({ name: 'a.ics', size: 100, type: 'text/calendar' });
// non-text by MIME / extension
assert.throws(() => Ics.validateIcsFile({ name: 'a.png', size: 10, type: 'image/png' }), /\.ics/);
assert.throws(() => Ics.validateIcsFile({ name: 'a.ics', size: 10, type: 'application/zip' }), /\.ics/);
// binary sniff
assert.throws(() => Ics.parseIcsFile('BEGIN:VCALENDAR\u0000\u0000' + vevent(1)), /not a text/);
assert.throws(() => Ics.parseIcsFile('\u0001\u0002\u0003\u0004\u0005\u0006'.repeat(50)), /not a text/);
assert.strictEqual(Ics.parseIcsFile(cal(vevent(1))).events.length, 1);
// event count
let many = '';
for (let i = 0; i < 10000; i += 1) many += vevent(i);
assert.strictEqual(Ics.parseIcsFile(cal(many)).events.length, 10000);
assert.throws(() => Ics.parseIcsFile(cal(many + vevent(10000))), /more than 10,000 events/);
// endless RRULE bounded
const t0 = Date.now();
const out = Rec.expandSeries(
  { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z', rrule: 'FREQ=DAILY;INTERVAL=1' },
  new Date(2000, 0, 1), new Date(9999, 0, 1),
);
assert.ok(Date.now() - t0 < 2000);
assert.ok(out.length <= Rec.MAX_OCCURRENCES_PER_RULE);
assert.ok(out.length > 0);
// links
assert.strictEqual(Ics.sanitizeHttpsUrl('javascript:alert(1)'), '');
assert.strictEqual(Ics.sanitizeHttpsUrl('http://example.com/x'), '');
assert.strictEqual(Ics.sanitizeHttpsUrl('https://example.com/x'), 'https://example.com/x');
const ev = Ics.parseIcsFile(cal(vevent(1, 'URL:javascript:alert(1)\r\nATTACH:https://evil.example/a\r\nCONFERENCE:http://evil.example/c\r\n'))).events[0];
assert.strictEqual(ev.webcall_url, '');
// no network
assert.strictEqual(fetchCalls, 0);
assert.strictEqual(xhrCalls, 0);
console.log('ok test_agenda_ics_hardening');
