// CSV byte decoding, RFC 4180 reader and named dialects for contacts (docs/CONTACTS_SPEC.md 6.0, 6.2, 6.3.1, 6.3.3, 7.8).
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

// --- 6.2 named dialects: each spec sample is a fixture --------------------------------------------
const FIXTURES = path.join(__dirname, 'fixtures', 'contacts');
function load(name) {
  const raw = new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
  const decoded = C.decodeBytes(raw);
  const read = C.readCsv(decoded.text);
  const dialect = C.detectDialect(read.rows[0]);
  return { raw, decoded, read, dialect, mapped: C.mapRows(read.rows, dialect) };
}
const sansIds = (list) => list.map(({ id, ...rest }) => rest);
const nullProto = (o) => Object.getPrototypeOf(o) === null;

test('sample 6.2.1: Google current', () => {
  const { decoded, read, dialect, mapped } = load('csv-6.2.1-google.csv');
  assert.strictEqual(decoded.encoding, 'utf-8');
  assert.strictEqual(dialect, 'google');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(read.rows.length, 2);
  assert.strictEqual(mapped.contacts.length, 1);
  const c = mapped.contacts[0];
  assert.strictEqual(c.name.given, 'Marieke');
  assert.strictEqual(c.name.family, 'Smit');
  assert.strictEqual(c.nickname, 'Mies');
  assert.deepStrictEqual(c.org, { name: 'Smit & Zn', unit: '' });
  assert.strictEqual(c.title, 'Eigenaar');
  assert.strictEqual(c.note, 'Eerste regel\nTweede regel');
  assert.deepStrictEqual(sansIds(c.emails), [
    { value: 'marieke@smit.example', type: 'work', label: '', pref: false },
    { value: 'm.smit@smit.example', type: 'work', label: '', pref: false },
  ]);
  assert.deepStrictEqual(sansIds(c.phones).map((p) => [p.type, p.value]), [['mobile', '+31 6 55512345'], ['home', '+31 20 5550000']]);
  assert.strictEqual(c.addresses.length, 1);
  const a = c.addresses[0];
  assert.deepStrictEqual([a.street, a.city, a.postal, a.country, a.type], ['Damrak 1', 'Amsterdam', '1012 LG', 'Netherlands', 'home']);
  assert.deepStrictEqual(c.labels, ['Klanten']);
  assert.deepStrictEqual(sansIds(c.urls), [{ value: 'https://smit.example', type: 'custom', label: 'Homepage' }]);
  assert.deepStrictEqual(sansIds(c.dates), [{ value: '1990-04-21', type: 'birthday', label: '' }]);
  assert.strictEqual(c.extra.csv, undefined); // every non-empty column was mapped
});

test('sample 6.2.2: older Google', () => {
  const { dialect, mapped } = load('csv-6.2.2-google-old.csv');
  assert.strictEqual(dialect, 'google-old');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(mapped.contacts.length, 1);
  const c = mapped.contacts[0];
  assert.deepStrictEqual(c.labels, ['Voetbal']);
  assert.strictEqual(c.name.formatted, 'Bram Kok');
  assert.strictEqual(c.name.given, 'Bram');
  assert.strictEqual(c.name.family, 'Kok');
  assert.deepStrictEqual(sansIds(c.emails), [{ value: 'bram@example.nl', type: 'home', label: '', pref: true }]);
  assert.deepStrictEqual(sansIds(c.phones), [{ value: '0687654321', type: 'mobile', label: '', pref: false }]);
  assert.deepStrictEqual(c.org, { name: 'FC Utrecht', unit: '' });
  assert.strictEqual(c.title, 'Trainer');
  assert.deepStrictEqual(sansIds(c.dates), [{ value: '1975-12-24', type: 'birthday', label: '' }]);
});

test('sample 6.2.3: Outlook desktop, windows-1252, day-first decided by the file, 0/0/00', () => {
  const { raw, decoded, dialect, mapped } = load('csv-6.2.3-outlook-desktop.csv');
  assert.ok(raw.includes(0xfc), 'fixture must hold the cp1252 byte for u-umlaut');
  assert.strictEqual(decoded.encoding, 'windows-1252');
  assert.strictEqual(dialect, 'outlook');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(mapped.dateOrder, 'dmy');
  assert.strictEqual(mapped.dateOrderAsk, '');
  assert.strictEqual(mapped.contacts.length, 2);
  const [jos, eva] = mapped.contacts;
  assert.strictEqual(jos.name.family, 'Müller');
  assert.strictEqual(jos.name.prefix, 'Dhr.');
  assert.deepStrictEqual(sansIds(jos.dates), [{ value: '1970-03-02', type: 'birthday', label: '' }]); // 0/0/00 anniversary: none
  assert.deepStrictEqual(jos.labels, ['Business', 'VIP']);
  assert.strictEqual(jos.note, 'Zeile 1\nZeile 2');
  assert.strictEqual(jos.addresses.length, 1);
  assert.deepStrictEqual([jos.addresses[0].type, jos.addresses[0].street, jos.addresses[0].city, jos.addresses[0].postal], ['work', 'Hauptstr. 5', 'Berlin', '10115']);
  assert.deepStrictEqual(sansIds(jos.phones).map((p) => [p.type, p.value]), [['home', '+49 30 111'], ['work', '+49 30 222'], ['mobile', '+49 170 333']]);
  assert.deepStrictEqual(jos.org, { name: 'Müller GmbH', unit: 'Einkauf' });
  assert.strictEqual(jos.title, 'Leiter');
  assert.deepStrictEqual(sansIds(jos.urls), [{ value: 'http://mueller.example', type: 'other', label: '' }]);
  assert.strictEqual(eva.name.given, 'Eva');
  assert.deepStrictEqual(sansIds(eva.dates), [{ value: '1981-04-13', type: 'birthday', label: '' }]);
  assert.strictEqual(eva.addresses.length, 1);
  assert.deepStrictEqual([eva.addresses[0].type, eva.addresses[0].street, eva.addresses[0].city, eva.addresses[0].country], ['home', 'Dorpsstraat 3', 'Utrecht', 'Netherlands']);
  assert.deepStrictEqual(eva.labels, []);
});

test('sample 6.2.4: outlook.com, UTF-8 with BOM, Turkish letters intact', () => {
  const { raw, decoded, read, dialect, mapped } = load('csv-6.2.4-outlook-com.csv');
  assert.deepStrictEqual(Array.from(raw.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.strictEqual(decoded.encoding, 'utf-8');
  assert.strictEqual(read.rows[0][0], 'First Name');
  assert.strictEqual(dialect, 'outlook-com');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(mapped.contacts.length, 1);
  const c = mapped.contacts[0];
  assert.strictEqual(c.name.family, 'Öztürk');
  assert.strictEqual(c.addresses[0].city, 'İstanbul');
  assert.deepStrictEqual([c.addresses[0].street, c.addresses[0].postal, c.addresses[0].country, c.addresses[0].type], ['İnönü Cd. 4', '34437', 'Türkiye', 'home']);
  assert.deepStrictEqual(c.org, { name: 'Öztürk Ltd.', unit: '' });
  assert.strictEqual(c.title, 'Müdür');
  assert.deepStrictEqual(sansIds(c.phones), [{ value: '+90 532 555 0100', type: 'mobile', label: '', pref: false }]);
  assert.deepStrictEqual(sansIds(c.dates), [{ value: '1992-08-17', type: 'birthday', label: '' }]);
});

test('sample 6.2.5: Thunderbird, birth columns, Custom 1 in extra.csv on a null prototype', () => {
  const { dialect, mapped } = load('csv-6.2.5-thunderbird.csv');
  assert.strictEqual(dialect, 'thunderbird');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(mapped.contacts.length, 1);
  const c = mapped.contacts[0];
  assert.deepStrictEqual(sansIds(c.dates), [{ value: '1988-09-23', type: 'birthday', label: '' }]);
  assert.ok(nullProto(c.extra.csv));
  assert.deepStrictEqual(Object.keys(c.extra.csv), ['Custom 1']); // Custom 2 is empty: not stored
  assert.strictEqual(c.extra.csv['Custom 1'], 'VIP');
  assert.deepStrictEqual(sansIds(c.phones).map((p) => [p.type, p.value]), [['work', '+31 30 5550101'], ['home', '+31 30 5550102'], ['mobile', '+31 6 44556677']]);
  assert.strictEqual(c.name.formatted, 'Anne Veldhuis');
  assert.strictEqual(c.nickname, 'Annie');
  assert.deepStrictEqual(sansIds(c.emails).map((e) => e.value), ['anne@example.nl', 'anne.v@work.example']);
  assert.strictEqual(c.note, 'Regel een');
  assert.deepStrictEqual(c.org, { name: 'Veldhuis Advies', unit: '' });
  assert.strictEqual(c.title, 'Adviseur');
  assert.strictEqual(c.addresses[0].street, 'Lange Nieuwstraat 7');
});

test('sample 6.2.6: Yahoo, doubled quotes, Messenger ID as IM, month-first date, Title to title', () => {
  const { dialect, mapped } = load('csv-6.2.6-yahoo.csv');
  assert.strictEqual(dialect, 'yahoo');
  assert.deepStrictEqual(mapped.warnings, []);
  assert.strictEqual(mapped.dateOrder, 'mdy');
  assert.strictEqual(mapped.contacts.length, 1);
  const c = mapped.contacts[0];
  assert.strictEqual(c.note, 'Zegt: "bel me"');
  assert.deepStrictEqual(sansIds(c.ims), [{ service: 'other', label: '', value: 'cor_dewit' }]);
  assert.deepStrictEqual(sansIds(c.dates), [{ value: '1969-03-28', type: 'birthday', label: '' }]);
  assert.strictEqual(c.title, 'Dr.');
  assert.deepStrictEqual(c.labels, ['Friends']);
  assert.strictEqual(c.nickname, 'Cootje');
  assert.deepStrictEqual(c.org, { name: 'De Wit BV', unit: '' });
  assert.deepStrictEqual(sansIds(c.phones).map((p) => [p.type, p.value]), [['home', '+31 20 5550123'], ['mobile', '+31 6 99001122']]);
  assert.strictEqual(c.addresses[0].postal, '1012 NX');
});

test('dialect: unknown headers give null; Proton-style Google/Outlook names are read as those; case and BOM ignored', () => {
  assert.strictEqual(C.detectDialect(['Voornaam', 'Achternaam', 'Mobiel']), null);
  assert.strictEqual(C.detectDialect([]), null);
  assert.strictEqual(C.detectDialect(null), null);
  assert.strictEqual(C.detectDialect(['﻿FIRST NAME', ' e-mail address ', 'Business Phone']), 'outlook');
  assert.strictEqual(C.detectDialect(['First Name', 'Organization Name', 'E-mail 1 - Value']), 'google');
});
test('dialect: Outlook with the translated headers the spec names (nl) is mapped', () => {
  const r = C.readCsv('Voornaam,Achternaam,E-mailadres,Hobby\nAnna,Bos,anna@example.nl,zeilen\n');
  assert.strictEqual(C.detectDialect(r.rows[0]), 'outlook-com');
  const c = C.mapRows(r.rows, 'outlook-com').contacts[0];
  assert.deepStrictEqual([c.name.given, c.name.family, c.emails[0].value], ['Anna', 'Bos', 'anna@example.nl']);
  assert.deepStrictEqual(Object.assign({}, c.extra.csv), { Hobby: 'zeilen' });
});

test('map: unmapped non-empty columns go to a null-prototype extra.csv; forbidden keys are dropped', () => {
  const r = C.readCsv('First Name,Organization Name,E-mail 1 - Value,Photo,__proto__,constructor,Relation 1 - Value,Empty\nA,B,a@x.example,https://p.example/1.jpg,evil,evil,Sister,\n');
  const m = C.mapRows(r.rows, 'google');
  const csv = m.contacts[0].extra.csv;
  assert.ok(nullProto(csv));
  assert.deepStrictEqual(Object.keys(csv).sort(), ['Photo', 'Relation 1 - Value']);
  assert.strictEqual(csv.Photo, 'https://p.example/1.jpg');
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.ok(m.warnings.some((w) => /dropped 2 unmapped/.test(w)), m.warnings.join('|'));
});
test('map: a long unmapped value is cut at 4096 characters and extra.csv stays under 32 KiB', () => {
  const cols = [];
  const vals = [];
  for (let i = 0; i < 20; i += 1) { cols.push('X' + i); vals.push('v'.repeat(4000)); }
  const r = C.readCsv('First Name,Organization Name,E-mail 1 - Value,Notes,' + cols.join(',') + '\nA,B,a@x.example,n,' + vals.join(',') + '\n');
  const m = C.mapRows(r.rows, 'google');
  const csv = m.contacts[0].extra.csv;
  assert.ok(JSON.stringify(csv).length <= 32 * 1024);
  assert.ok(Object.keys(csv).length < 20);
  assert.ok(m.warnings.some((w) => /dropped \d+ unmapped/.test(w)), m.warnings.join('|'));
  const long = C.mapRows(C.readCsv('First Name,Organization Name,E-mail 1 - Value,Z\nA,B,a@x.example,' + 'z'.repeat(5000) + '\n').rows, 'google');
  assert.strictEqual(long.contacts[0].extra.csv.Z.length, 4096);
});
test('map: lists over 50 entries and labels over 20 are cut and reported', () => {
  const emails = Array.from({ length: 60 }, (_, i) => 'e' + i + '@x.example').join(' ::: ');
  const labels = Array.from({ length: 25 }, (_, i) => 'L' + i).join(' ::: ');
  const r = C.readCsv('First Name,Organization Name,E-mail 1 - Value,Labels\nA,B,' + emails + ',' + labels + '\n');
  const m = C.mapRows(r.rows, 'google');
  assert.strictEqual(m.contacts[0].emails.length, 50);
  assert.strictEqual(m.contacts[0].labels.length, 20);
  assert.ok(m.warnings.some((w) => /10 emails entries over the limit of 50/.test(w)), m.warnings.join('|'));
  assert.ok(m.warnings.some((w) => /5 labels over the limit of 20/.test(w)), m.warnings.join('|'));
});
test('map: name part over 200 characters is cut; empty records are skipped and counted', () => {
  const r = C.readCsv('First Name,Organization Name,E-mail 1 - Value\n' + 'x'.repeat(300) + ',,\n,,\n');
  const m = C.mapRows(r.rows, 'google');
  assert.strictEqual(m.contacts.length, 1);
  assert.strictEqual(m.contacts[0].name.given.length, 200);
  assert.deepStrictEqual(m.warnings, ['1 empty record(s) skipped']);
});
test('map: date order. An undecided file asks and defaults to day first; month-first can be passed; impossible dates are dropped', () => {
  const head = 'First Name,E-mail Address,Business Phone,Birthday\n';
  const undecided = C.readCsv(head + 'A,a@x.example,1,2/3/1970\n').rows;
  let m = C.mapRows(undecided, 'outlook');
  assert.strictEqual(m.dateOrderAsk, '2/3/1970');
  assert.strictEqual(m.contacts[0].dates[0].value, '1970-03-02');
  m = C.mapRows(undecided, 'outlook', { dateOrder: 'mdy' });
  assert.strictEqual(m.contacts[0].dates[0].value, '1970-02-03');
  m = C.mapRows(C.readCsv(head + 'A,a@x.example,1,31/2/1970\nB,b@x.example,1,0/0/00\n').rows, 'outlook');
  assert.strictEqual(m.contacts[0].dates.length, 0);
  assert.strictEqual(m.contacts[1].dates.length, 0);
  assert.ok(m.warnings.some((w) => /1 date\(s\) could not be read/.test(w)), m.warnings.join('|'));
  m = C.mapRows(C.readCsv(head + 'A,a@x.example,1,13/4/1981\nB,b@x.example,1,4/13/1981\n').rows, 'outlook');
  assert.ok(m.warnings.some((w) => /mix day-first and month-first/.test(w)), m.warnings.join('|'));
  assert.strictEqual(m.contacts[0].dates[0].value, '1981-04-13');
  assert.strictEqual(m.contacts[1].dates.length, 0);
});
test('map: Thunderbird birthday without a year is year-less; Google events; unknown dialect and header-only file', () => {
  const t = C.mapRows(C.readCsv('Primary Email,Display Name,Birth Month,Birth Day\na@x.example,A,2,29\n').rows, 'thunderbird');
  assert.strictEqual(t.contacts[0].dates[0].value, '--02-29');
  const g = C.mapRows(C.readCsv('First Name,Organization Name,E-mail 1 - Value,Event 1 - Label,Event 1 - Value,Event 2 - Label,Event 2 - Value\nA,B,a@x.example,Anniversary,2010-05-06,Graduation,2001-01-02\n').rows, 'google');
  assert.deepStrictEqual(sansIds(g.contacts[0].dates), [
    { value: '2010-05-06', type: 'anniversary', label: '' },
    { value: '2001-01-02', type: 'other', label: 'Graduation' },
  ]);
  assert.deepStrictEqual(C.mapRows([['a']], 'google').contacts, []);
  assert.deepStrictEqual(C.mapRows(C.readCsv('a,b\n1,2\n').rows, 'nope').contacts, []);
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
