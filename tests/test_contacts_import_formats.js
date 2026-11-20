// Contacts import: the format is decided by the content (docs/CONTACTS_SPEC.md 7.1), whatever the file is called,
// and a CSV that is not a named dialect waits for its column mapping (6.3.2).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = (name) => path.join(__dirname, '..', 'app', 'static', 'js', name);
global.NotesContacts = require(js('contacts.js'));
global.NotesContactsVcard = require(js('contacts-vcard.js'));
const Csv = require(js('contacts-csv.js'));
const I = require(js('contacts-import.js'));

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'contacts', name));
const fakeFile = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

(async () => {
  // Every file below has the wrong name for what it holds.
  const state = await I.readFiles([
    fakeFile('a.csv', fixture('apple-3.0.vcf')),
    fakeFile('b.vcf', fixture('ldif-6.4.1-thunderbird.ldif')),
    fakeFile('c.txt', fixture('csv-6.2.1-google.csv')),
    fakeFile('d.csv', fixture('jcard-6.5.1-hostile.json')),
  ]);
  assert.deepStrictEqual(state.files.map((f) => f.ok), [true, true, true, true]);
  assert.deepStrictEqual([...new Set(state.contacts.map((c) => c.sourceFormat))].sort(), ['csv', 'jcard', 'ldif', 'vcard']);
  assert.deepStrictEqual(state.files.map((f) => f.label.split(',')[0]), ['vCard 3.0', 'LDIF', 'CSV', 'jCard']);
  assert.strictEqual(state.pending.length, 0);
  assert.strictEqual(({}).polluted, undefined);

  // Unsupported files say what is supported; JSON that is not a jCard and a one-column text are not CSV.
  const bad = await I.readFiles([
    fakeFile('x.json', Buffer.from('{"a": 1, "b": 2}\n{"a": 3, "b": 4}\n')),
    fakeFile('y.csv', Buffer.from('just one column\nanother line\n')),
    fakeFile('z.txt', Buffer.from('<html><body>a,b\n1,2</body></html>\n')),
  ]);
  assert.deepStrictEqual(bad.files.map((f) => f.ok), [false, false, false]);
  for (const f of bad.files) for (const word of ['vCard', 'CSV', 'LDIF', 'jCard']) assert.ok(f.reason.includes(word), f.reason);
  assert.strictEqual(bad.contacts.length, 0);

  // An unknown CSV is held for the mapping step: no contact exists until the targets are confirmed.
  const generic = await I.readFiles([fakeFile('people.csv', fixture('csv-6.3.3-semicolon-cp1252.csv'))]);
  assert.strictEqual(generic.contacts.length, 0);
  assert.strictEqual(generic.pending.length, 1);
  assert.strictEqual(generic.pending[0].rows.length, 3);

  // The suggestions, and the refusals of a mapping that cannot be used.
  const targets = generic.pending[0].rows[0].map(Csv.suggestTarget);
  assert.deepStrictEqual(targets, ['given', 'family', 'phone:mobile', 'email:other', 'street', 'note']);
  assert.strictEqual(Csv.checkMapping(targets), '');
  assert.ok(Csv.checkMapping(['given', 'given', 'phone:main']).startsWith('Two columns are mapped'));
  assert.ok(Csv.checkMapping(['note', 'extra']).startsWith('Map at least one column'));
  assert.strictEqual(Csv.checkMapping(['phone:work', 'phone:home', 'email:work', 'email:home', 'extra', 'ignore', 'ignore']), '');
  assert.strictEqual(Csv.suggestTarget('Geburtstag'), 'birthday');
  assert.strictEqual(Csv.suggestTarget('Prénom'), 'given');
  assert.strictEqual(Csv.suggestTarget('Something else'), 'extra');

  // Confirming it: the contacts appear with their values, unmapped columns are kept as extra.csv.
  const withExtra = targets.slice();
  withExtra[5] = 'extra';
  I.finishMapping(generic, generic.pending[0], withExtra);
  assert.strictEqual(generic.pending.length, 0);
  assert.strictEqual(generic.contacts.length, 2);
  const [unal, fieke] = generic.contacts;
  assert.strictEqual(unal.name.given, 'Ünal');
  assert.strictEqual(unal.name.family, 'Çelik');
  assert.strictEqual(unal.phones[0].type, 'mobile');
  assert.ok(unal.addresses[0].street.includes('3511 AB Utrecht'));
  assert.strictEqual(unal.extra.csv.Opmerking, 'zei: "bel mij"');
  assert.strictEqual(fieke.phones[0].value, '=+31 6 11');
  assert.strictEqual(unal.sourceFormat, 'csv');
  assert.strictEqual(generic.files[0].found, 2);

  // A "Family, Given" full name and a repeated email column.
  const rows = Csv.readCsv('Name,Mail,Mail 2\n"Bos, Fieke",a@x.nl,b@x.nl\nJan Smit,,\n').rows;
  const mapped = Csv.mapGeneric(rows, ['formatted', 'email:work', 'email:home']);
  assert.strictEqual(mapped.contacts.length, 2);
  assert.deepStrictEqual([mapped.contacts[0].name.given, mapped.contacts[0].name.family], ['Fieke', 'Bos']);
  assert.deepStrictEqual(mapped.contacts[0].emails.map((e) => e.value), ['a@x.nl', 'b@x.nl']);
  assert.deepStrictEqual([mapped.contacts[1].name.given, mapped.contacts[1].name.family], ['Jan', 'Smit']);

  console.log('contacts import formats ok');
})().catch((err) => { console.error(err); process.exit(1); });
