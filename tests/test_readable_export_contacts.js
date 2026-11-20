/**
 * Readable ZIP export: contacts/contacts.vcf (docs/CONTACTS_SPEC.md 8.2, docs/HELP_CONTACTS.md).
 * The vCard is parsed back with the importer to prove the names, numbers and the unicode survive.
 */
const assert = require('assert');
const Zip = require('../app/static/js/ziplib.js');
const Contacts = require('../app/static/js/contacts.js');

global.NotesContacts = Contacts;
const Vcard = require('../app/static/js/contacts-vcard.js');
const Export = require('../app/static/js/readable-export.js');

const dec = (b) => new TextDecoder().decode(b);
const unzip = async (result) => new Map((await Zip.readZip(result.bytes)).map((e) => [e.name, e.bytes]));
const make = (input) => ({ ...Contacts.buildContact(input, null, '2026-11-19T10:00:00.000Z').content, uuid: `u-${input.name.given}` });
const base = { getAttachment: () => null, getAttachmentBytes: async () => null, now: new Date('2026-11-20T12:00:00Z') };
const note = { uuid: 'n1', content: { type: 'note', title: 'T', content: 'body', tags: [], attachments: [], created_at: '2026-11-18T10:00:00.000Z' } };

(async () => {
  const eva = make({
    name: { given: 'Eva', family: 'Bakker' },
    phones: [{ type: 'mobile', value: '+31 6 12345678' }],
    emails: [{ type: 'work', value: 'eva@example.com' }],
    note: 'Lunch; bel, na 17:00',
  });
  const zoe = make({ name: { given: 'Zoë', family: 'Ünal' }, phones: [{ type: 'home', value: '020 1234567' }] });

  // Contacts and a note: both are in the ZIP, the README counts them.
  const both = await Export.build({ ...base, notes: [note], contacts: [eva, zoe] });
  assert.strictEqual(both.counts.contacts, 2);
  const files = await unzip(both);
  assert.ok(files.has('contacts/contacts.vcf'));
  const readme = dec(files.get('README.txt'));
  assert.ok(readme.includes('Contacts: 2 (contacts/contacts.vcf, vCard 3.0)'));
  assert.ok(readme.includes('your contacts'));
  const parsed = Vcard.parse(files.get('contacts/contacts.vcf'));
  assert.strictEqual(parsed.contacts.length, 2);
  const byGiven = Object.fromEntries(parsed.contacts.map((c) => [c.name.given, c]));
  assert.strictEqual(byGiven.Eva.name.family, 'Bakker');
  assert.deepStrictEqual(byGiven.Eva.phones.map((p) => p.value), ['+31 6 12345678']);
  assert.deepStrictEqual(byGiven.Eva.emails.map((p) => p.value), ['eva@example.com']);
  assert.strictEqual(byGiven.Eva.note, 'Lunch; bel, na 17:00');
  assert.strictEqual(byGiven['Zoë'].name.family, 'Ünal');
  assert.ok(dec(files.get('contacts/contacts.vcf')).startsWith('BEGIN:VCARD\r\nVERSION:3.0'));

  // Contacts alone are enough for an export; without contacts there is no vcf and no mention.
  const only = await Export.build({ ...base, notes: [], contacts: [eva] });
  assert.ok(only && (await unzip(only)).has('contacts/contacts.vcf'));
  const noContacts = await Export.build({ ...base, notes: [note], contacts: [] });
  const noFiles = await unzip(noContacts);
  assert.ok(!noFiles.has('contacts/contacts.vcf'));
  assert.ok(!dec(noFiles.get('README.txt')).includes('Contacts:'));
  assert.strictEqual(await Export.build({ ...base, notes: [], contacts: [] }), null);

  // Items of another type in the list are not written as contacts.
  const mixed = await Export.build({ ...base, notes: [note], contacts: [{ type: 'note', title: 'x' }, null, eva] });
  assert.strictEqual(mixed.counts.contacts, 1);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
