// CSV byte decoding and RFC 4180 reader for contacts (docs/CONTACTS_SPEC.md 6.0, 6.3.1, 6.3.3, 7.8).
// The pathological inputs run in a child process with a 10 s kill, so a scanner that stops advancing fails
// the test instead of hanging the suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'app', 'static', 'js', 'contacts-csv.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'contacts', 'csv-6.3.3-semicolon-cp1252.csv');
const C = require(SCRIPT);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (err) { failures += 1; console.log('FAIL ' + name + '\n' + err.stack); }
}

const bytes = (...a) => Uint8Array.from(a);
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const utf16 = (s, be) => {
  const b = Buffer.from(s, 'utf16le');
  if (be) b.swap16();
  return new Uint8Array(b);
};
const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));

test('decode: UTF-8 BOM is stripped', () => {
  assert.deepStrictEqual(C.decodeBytes(cat(bytes(0xef, 0xbb, 0xbf), enc('a;ü'))), { text: 'a;ü', encoding: 'utf-8' });
});
test('decode: UTF-16 LE and BE with BOM', () => {
  assert.deepStrictEqual(C.decodeBytes(cat(bytes(0xff, 0xfe), utf16('a\tü'))), { text: 'a\tü', encoding: 'utf-16le' });
  assert.deepStrictEqual(C.decodeBytes(cat(bytes(0xfe, 0xff), utf16('a\tü', true))), { text: 'a\tü', encoding: 'utf-16be' });
});
test('decode: UTF-16 without BOM (NUL in every second position)', () => {
  assert.deepStrictEqual(C.decodeBytes(utf16('name,mail\nx,y')), { text: 'name,mail\nx,y', encoding: 'utf-16le' });
  assert.deepStrictEqual(C.decodeBytes(utf16('name,mail\nx,y', true)), { text: 'name,mail\nx,y', encoding: 'utf-16be' });
});
test('decode: strict UTF-8 without BOM, else windows-1252', () => {
  assert.deepStrictEqual(C.decodeBytes(enc('Ünal')), { text: 'Ünal', encoding: 'utf-8' });
  assert.deepStrictEqual(C.decodeBytes(bytes(0xdc, 0x6e, 0x61, 0x6c)), { text: 'Ünal', encoding: 'windows-1252' });
  assert.strictEqual(C.decodeBytes(bytes(0x80, 0x41)).text, '€A'); // windows-1252, not ISO-8859-1
});
test('decode: NUL, C0 controls and lone surrogates are removed; tab, CR and LF stay', () => {
  const r = C.decodeBytes(enc('a\u0000b\u0001c\td\re\nf\u001fg'));
  assert.strictEqual(r.text, 'abc\td\re\nfg');
  // TextDecoder already replaces lone surrogates in the bytes it reads; the text clean-up removes any that remain.
  assert.strictEqual(C.cleanText('x\ud800y\udc00z😀'), 'xyz😀');
  assert.strictEqual(C.decodeBytes(cat(bytes(0xff, 0xfe), utf16('😀'))).text, '😀');
});

test('read: comma, semicolon, tab and pipe are detected', () => {
  for (const d of [',', ';', '\t', '|']) {
    const r = C.readCsv(['a', 'b', 'c'].join(d) + '\n' + ['1', '2', '3'].join(d) + '\n');
    assert.strictEqual(r.delimiter, d);
    assert.deepStrictEqual(r.rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  }
});
test('read: a delimiter inside quotes does not count; a single column falls back to comma', () => {
  assert.strictEqual(C.readCsv('a,b\n"x;y;z",2\n').delimiter, ',');
  assert.strictEqual(C.readCsv('only\nvalue\n').delimiter, ',');
});
test('read: ragged comma file is still read as comma', () => {
  const r = C.readCsv('a,b,c\n1,2\n3,4,5\n');
  assert.strictEqual(r.delimiter, ',');
});
test('read: sep= first line is honoured and removed, case-insensitive; opts.delimiter overrides', () => {
  const r = C.readCsv('SEP=|\na|b,c\n1|2,3\n');
  assert.strictEqual(r.delimiter, '|');
  assert.deepStrictEqual(r.rows, [['a', 'b,c'], ['1', '2,3']]);
  assert.strictEqual(C.readCsv('a;b\n1;2\n', { delimiter: ',' }).rows[0].length, 1);
});
test('read: quoted newline (CR, LF, CRLF become LF), doubled quotes, quote inside unquoted field', () => {
  const r = C.readCsv('a,b\r\n"x\r\ny\rz\nw","he said ""hi"""\r\n5" pipe,"q"\r\n');
  assert.deepStrictEqual(r.rows, [['a', 'b'], ['x\ny\nz\nw', 'he said "hi"'], ['5" pipe', 'q']]);
  assert.deepStrictEqual(r.warnings, []);
});
test('read: empty lines are skipped, a quoted empty field line is not', () => {
  const r = C.readCsv('a,b\n\n1,2\r\n\r\n"",\n');
  assert.deepStrictEqual(r.rows, [['a', 'b'], ['1', '2'], ['', '']]);
});
test('read: short rows are padded, long rows keep surplus cells, both counted as warnings', () => {
  const r = C.readCsv('a,b,c\n1\n1,2,3,4\n');
  assert.deepStrictEqual(r.rows, [['a', 'b', 'c'], ['1', '', ''], ['1', '2', '3', '4']]);
  assert.strictEqual(r.warnings.length, 2);
});
test('read: header names are trimmed and duplicates get a numbered suffix', () => {
  const r = C.readCsv(' Name , name ,Name,x\n1,2,3,4\n');
  assert.deepStrictEqual(r.rows[0], ['Name', 'name (2)', 'Name (3)', 'x']);
});
test('read: unterminated quote closes at the end with a warning naming the record', () => {
  const r = C.readCsv('a,b\n1,"abc\ndef');
  assert.deepStrictEqual(r.rows, [['a', 'b'], ['1', 'abc\ndef']]);
  assert.deepStrictEqual(r.warnings, ['unterminated quote in record 2']);
});
test('read: record over 500 columns is skipped with a warning and the next record is read', () => {
  const r = C.readCsv('a,b\n' + ','.repeat(600) + '\n1,2\n');
  assert.deepStrictEqual(r.rows, [['a', 'b'], ['1', '2']]);
  assert.ok(/record 2 has more than 500 columns/.test(r.warnings[0]), r.warnings[0]);
});
test('read: record over 1 MiB is skipped with a warning and the next record is read', () => {
  const r = C.readCsv('a,b\n"' + 'x'.repeat(1100000) + '",1\nnext,row\n');
  assert.deepStrictEqual(r.rows, [['a', 'b'], ['next', 'row']]);
  assert.ok(/record 2 is longer than 1 MiB/.test(r.warnings[0]), r.warnings[0]);
});

test('sample 6.3.3: semicolon, windows-1252, quoted newline, doubled quotes, formula text kept', () => {
  const raw = fs.readFileSync(FIXTURE);
  assert.ok(raw.includes(0xdc) && raw.includes(0xc7), 'fixture must hold cp1252 bytes');
  const d = C.decodeBytes(new Uint8Array(raw));
  assert.strictEqual(d.encoding, 'windows-1252');
  const r = C.readCsv(d.text);
  assert.strictEqual(r.delimiter, ';');
  assert.strictEqual(r.rows.length, 3);
  assert.ok(r.rows.every((row) => row.length === 6));
  assert.deepStrictEqual(r.rows[0], ['Voornaam', 'Achternaam', 'Mobiel', 'E-mail', 'Adres', 'Opmerking']);
  assert.deepStrictEqual(r.rows[1], ['Ünal', 'Çelik', '06-12345678', 'unal@example.nl', 'Kerkstraat 1\n3511 AB Utrecht', 'zei: "bel mij"']);
  assert.deepStrictEqual(r.rows[2], ['Fieke', 'Bos', '=+31 6 11', 'fieke@example.nl', '', '']);
  assert.deepStrictEqual(r.warnings, []);
});

// --- pathological input, in a killable child process ---------------------------------------------
const CHILD = `
const C = require(process.argv[1]);
const kind = process.argv[2];
const MB = 1000000;
const inputs = {
  unterminated: () => 'a,b\\n1,"abc',
  quotedMb: () => 'a\\n"' + 'x'.repeat(MB) + '"\\n',
  unquotedMb: () => 'a,b\\n' + 'x'.repeat(MB) + ',1\\n',
  overLimit: () => 'a,b\\n"' + 'x'.repeat(2 * 1024 * 1024) + '",1\\nnext,row\\n',
  onlyQuotes: () => '"'.repeat(MB + 1),
  onlyDelimiters: () => ','.repeat(MB),
};
const text = inputs[kind]();
const t0 = Date.now();
const r = C.readCsv(text);
process.stdout.write(JSON.stringify({
  ms: Date.now() - t0, warnings: r.warnings, delimiter: r.delimiter,
  rows: r.rows.length, lens: r.rows.map((row) => row.map((c) => c.length)),
}));
`;

function runChild(kind) {
  const res = spawnSync(process.execPath, ['-e', CHILD, SCRIPT, kind], { timeout: 10000, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.ok(!res.error, kind + ': ' + (res.error && res.error.message));
  assert.strictEqual(res.status, 0, kind + ': ' + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.ms < 10000, kind + ' took ' + out.ms + ' ms');
  return out;
}

test('pathological: unterminated quote at EOF', () => {
  const r = runChild('unterminated');
  assert.deepStrictEqual(r.warnings, ['unterminated quote in record 2']);
  assert.deepStrictEqual(r.lens, [[1, 1], [1, 3]]);
});
test('pathological: 1 MB single-line quoted field', () => {
  const r = runChild('quotedMb');
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.lens, [[1], [1000000]]);
});
test('pathological: 1 MB unquoted field', () => {
  const r = runChild('unquotedMb');
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.lens, [[1, 1], [1000000, 1]]);
});
test('pathological: field over the 1 MiB record limit', () => {
  const r = runChild('overLimit');
  assert.strictEqual(r.rows, 2);
  assert.strictEqual(r.warnings.length, 1);
  assert.ok(/record 2 is longer than 1 MiB/.test(r.warnings[0]), r.warnings[0]);
});
test('pathological: a file of only quotes', () => {
  const r = runChild('onlyQuotes');
  assert.deepStrictEqual(r.warnings, ['unterminated quote in record 1']);
  assert.strictEqual(r.rows, 1);
});
test('pathological: a file of only delimiters', () => {
  const r = runChild('onlyDelimiters');
  assert.strictEqual(r.rows, 0);
  assert.ok(/record 1 has more than 500 columns/.test(r.warnings[0]), r.warnings[0]);
});

if (failures) { console.log(failures + ' test(s) failed'); process.exit(1); }
console.log('all passed');
