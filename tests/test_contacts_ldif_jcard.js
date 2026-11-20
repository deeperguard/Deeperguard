// LDIF and jCard import parsers for contacts (docs/CONTACTS_SPEC.md 6.4, 6.5, 2.4, 9.4): the spec samples,
// folding, base64 with its Windows-1252 fallback, skipped and group records, hostile keys, depth, hang-proofing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = (name) => path.join(__dirname, '..', 'app', 'static', 'js', name);
const L = require(js('contacts-ldif.js'));
const J = require(js('contacts-jcard.js'));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'contacts', name));
const plain = (x) => JSON.parse(JSON.stringify(x));
const vals = (list) => list.map((e) => e.value);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function protoSnapshot() {
  return JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort().map((k) => [k, typeof Object.getOwnPropertyDescriptor(Object.prototype, k).value]))
    + Object.getPrototypeOf(Object.prototype) + Object.keys(Array.prototype).length;
}

// --- LDIF -------------------------------------------------------------------------------------------
(() => {
  const r = L.parse(fixture('ldif-6.4.1-thunderbird.ldif'));
  assert.strictEqual(r.contacts.length, 2);
  assert.deepStrictEqual(r.skipped, [{ index: 3, reason: 'not a contact: groupOfNames' }]);
  assert.strictEqual(r.stats.encoding, 'utf-8');
  const [anne, zoe] = r.contacts;
  assert.deepStrictEqual(plain(anne.name), { prefix: '', given: 'Anne', additional: '', family: 'Veldhuis', suffix: '', formatted: 'Anne Veldhuis' });
  assert.strictEqual(anne.nickname, 'Annie');
  assert.deepStrictEqual(vals(anne.emails), ['anne@example.nl', 'anne.v@work.example']);
  assert.deepStrictEqual(anne.emails.map((e) => e.pref), [true, false]);
  assert.deepStrictEqual(anne.phones.map((p) => [p.type, p.value]), [['work', '+31 30 5550101'], ['home', '+31 30 5550102'], ['mobile', '+31 6 44556677']]);
  assert.strictEqual(anne.addresses.length, 1);
  assert.deepStrictEqual(plain(anne.addresses[0]), {
    po_box: '', extended: '', street: 'Lange Nieuwstraat 7', city: 'Utrecht', region: '', postal: '3512 PA', country: 'Nederland', type: 'home', label: '', pref: false,
  });
  assert.deepStrictEqual(anne.org, { name: 'Veldhuis Advies', unit: '' });
  assert.strictEqual(anne.title, 'Adviseur');
  assert.deepStrictEqual(plain(anne.dates), [{ type: 'birthday', label: '', value: '1988-09-23' }]);
  assert.strictEqual(anne.note, 'Regel een van de notitie, die zo lang is dat Thunderbird hem op een nieuwe regel voortzet.');
  assert.strictEqual(anne.extra.ldif.mozillaCustom1, 'VIP');
  assert.strictEqual(anne.extra.ldif.modifytimestamp, '0');
  assert.deepStrictEqual(anne.extra.ldif.objectclass, ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'mozillaAbPersonAlpha']);
  assert.strictEqual(anne.extra.ldif.dn, 'cn=Anne Veldhuis,mail=anne@example.nl');
  assert.strictEqual(anne.extra.ldif.mail, undefined, 'mapped attributes are not repeated in extra');
  assert.strictEqual(Object.getPrototypeOf(anne.extra.ldif), null);
  assert.strictEqual(anne.extra.source.format, 'ldif');

  assert.strictEqual(zoe.name.formatted, 'Zoë Åkerström');
  assert.strictEqual(zoe.name.given, 'Zoë');
  assert.strictEqual(zoe.name.family, 'Åkerström');
  assert.strictEqual(zoe.extra.ldif.dn, 'cn=Zoë Åkerström,mail=zoe@example.se');
  assert.deepStrictEqual(vals(zoe.emails), ['zoe@example.se']);
})();

(() => {
  // Latin-1 inside `::` is not valid UTF-8 and is read as Windows-1252; a Latin-1 file is read the same way.
  const cn = b64([0x5a, 0x6f, 0xeb]);
  const r = L.parse(`version: 1\n# a comment\n#  folded comment\n continues\n\ndn: cn=x\nobjectclass: person\ncn:: ${cn}\nmail: z@example.org\n`);
  assert.strictEqual(r.contacts.length, 1);
  assert.strictEqual(r.contacts[0].name.formatted, 'Zoë');
  assert.strictEqual(r.contacts[0].extra.ldif.version, undefined);
  assert.strictEqual(Object.keys(r.contacts[0].extra.ldif).join(), 'dn,objectclass');
  const latin1 = L.parse(Buffer.from('dn: cn=a\r\nobjectclass: person\r\ncn: Zo\xeb Smith\r\n\r\n', 'latin1'));
  assert.strictEqual(latin1.stats.encoding, 'windows-1252');
  assert.strictEqual(latin1.contacts[0].name.formatted, 'Zoë Smith');
  assert.strictEqual(latin1.contacts[0].name.given, 'Zoë');
  assert.strictEqual(L.parse(Buffer.from('﻿dn: cn=a\nobjectclass: person\ncn: Bo Li\n', 'utf8')).contacts.length, 1);
})();

(() => {
  // `attr:<` is never followed; a bad base64 value is left out; both are counted.
  const r = L.parse('dn: cn=a\nobjectclass: person\ncn: Ann Lee\njpegPhoto:< file:///etc/passwd\ndescription:: !!!\nmail: a@example.org\n');
  assert.strictEqual(r.contacts.length, 1);
  assert.strictEqual(JSON.stringify(r.contacts[0]).includes('passwd'), false);
  assert.ok(r.warnings.some((w) => /URL value were not followed/.test(w)));
  assert.ok(r.warnings.some((w) => /base64/.test(w)));
  assert.strictEqual(r.contacts[0].photoSource, null);
})();

(() => {
  // A photo as base64 is decided by its bytes; a repeated unknown attribute keeps all values; names are case-insensitive.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const r = L.parse(`dn: cn=a\nObjectClass: inetOrgPerson\nGIVENNAME: Eva\nSN: Bakker\njpegPhoto:: ${b64(png)}\nxfoo: 1\nXFoo: 2\nxfoo: 3\ntelephoneNumber: 555\n`);
  const c = r.contacts[0];
  assert.strictEqual(c.photoSource.mime, 'image/png');
  assert.strictEqual(c.photoSource.bytes.length, png.length);
  assert.strictEqual(r.stats.photos, 1);
  assert.deepStrictEqual(c.extra.ldif.xfoo, ['1', '2', '3']);
  assert.strictEqual(c.name.formatted, 'Eva Bakker');
  const bad = L.parse(`dn: cn=a\nobjectclass: person\ncn: Eva Bakker\nphoto:: ${b64(Buffer.alloc(40, 7))}\n`);
  assert.strictEqual(bad.contacts[0].photoSource, null);
  assert.ok(bad.warnings.some((w) => /not a PNG/.test(w)));
})();

(() => {
  // Other record kinds are skipped with a reason; a record without an object class but with a mail is a contact;
  // a list with member entries becomes a label on the members whose mail matches.
  const r = L.parse([
    'dn: cn=Book', 'objectclass: top', 'objectclass: addressbook', 'cn: Book', '',
    'dn: x=1', 'description: just a note', '',
    'dn: cn=Bo Li,mail=bo@example.org', 'mail: Bo@Example.org', '',
    'dn: cn=Team', 'objectclass: top', 'objectclass: mozillaAbList', 'cn: Team', 'member: cn=Bo Li,mail=bo@example.org', 'member: cn=Gone,mail=gone@example.org', '',
    'dn: cn=Empty list', 'objectclass: groupOfNames', 'cn: Empty list', '',
  ].join('\n'));
  assert.deepStrictEqual(r.contacts.map((c) => c.name.formatted), ['Bo@Example.org']);
  assert.deepStrictEqual(r.contacts[0].labels, ['Team']);
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['not a contact: addressbook', 'not a contact: no object class', 'not a contact: groupOfNames']);
})();

(() => {
  // Hostile attribute names never become keys; mapped fields are fine.
  const r = L.parse('dn: cn=a\nobjectclass: person\ncn: Ann Lee\n__proto__: x\nconstructor: y\nprototype: z\nxok: fine\n');
  const ldif = r.contacts[0].extra.ldif;
  assert.deepStrictEqual(Object.keys(ldif).sort(), ['dn', 'objectclass', 'xok']);
  assert.strictEqual(Object.getPrototypeOf(ldif), null);
  assert.strictEqual(({}).x, undefined);
  assert.ok(r.warnings.some((w) => /3 attribute\(s\) named __proto__/.test(w)));
})();

(() => {
  // Birthday forms, an impossible one is kept as text with a warning; postalAddress is split on `$`; several ou.
  const r = L.parse('dn: a\nobjectclass: person\ncn: Ann Lee\nbirthmonth: 02\nbirthday: 30\nou: Sales\nou: EMEA\npostalAddress: Street 1$Room 2$1000 AA Town\nc: NL\n'
    + '\ndn: b\nobjectclass: person\ncn: Bo Li\nbirthyear: 1990\n'
    + '\ndn: c\nobjectclass: person\ncn: Cy Do\nbirthmonth: 3\nbirthday: 9\n');
  const [a, b, c] = r.contacts;
  assert.deepStrictEqual(a.dates, []);
  assert.strictEqual(a.extra.ldif.birthmonth, '02');
  assert.ok(r.warnings.some((w) => /birthday could not be read/.test(w)));
  assert.strictEqual(a.org.unit, 'Sales / EMEA');
  assert.strictEqual(a.addresses[0].street, 'Street 1\nRoom 2\n1000 AA Town');
  assert.strictEqual(a.addresses[0].country, 'NL');
  assert.strictEqual(b.dates[0].value, '1990');
  assert.strictEqual(c.dates[0].value, '--03-09');
})();

(() => {
  // Every loop advances: a line folded 200,000 times, many records and many blank/garbage lines finish quickly.
  const t0 = Date.now();
  let fold = 'dn: cn=a\nobjectclass: person\ncn: Ann Lee\ndescription: x\n';
  fold += ' y\n'.repeat(200000);
  assert.strictEqual(L.parse(fold).contacts[0].note.length, 1 + 200000);
  const many = [];
  for (let i = 0; i < 20000; i += 1) many.push(`dn: cn=${i}`, 'objectclass: person', `cn: Name${i} Family`, `mail: m${i}@example.org`, '', '', '#c', 'garbage line');
  const r = L.parse(many.join('\n'));
  assert.strictEqual(r.contacts.length, 20000);
  assert.ok(r.warnings.some((w) => /20000 line\(s\) were not attribute lines/.test(w)));
  assert.strictEqual(L.parse('').contacts.length, 0);
  assert.strictEqual(L.parse('\n\n\n').contacts.length, 0);
  assert.strictEqual(L.parse(' \n \n').contacts.length, 0);
  assert.ok(Date.now() - t0 < 20000);
})();

// --- jCard ------------------------------------------------------------------------------------------
(() => {
  const before = protoSnapshot();
  const r = J.parse(fixture('jcard-6.5.1-hostile.json'));
  assert.strictEqual(r.contacts.length, 1, JSON.stringify(r.skipped));
  const c = r.contacts[0];
  assert.deepStrictEqual(plain(c.name), { prefix: 'Dr.', given: 'Eva', additional: '', family: 'Bakker', suffix: '', formatted: 'Dr. Eva Bakker' });
  assert.deepStrictEqual(c.phones.map((p) => [p.type, p.value, p.pref]), [['mobile', '+31-6-1234-5678;ext=12', true], ['work', '+31 20 5550000', false]]);
  assert.deepStrictEqual(c.emails.map((e) => [e.type, e.value]), [['work', 'eva@bakker.example']]);
  assert.strictEqual(c.addresses[0].street, 'Keizersgracht 1');
  assert.strictEqual(c.addresses[0].city, 'Amsterdam');
  assert.strictEqual(c.addresses[0].postal, '1015 AA');
  assert.strictEqual(c.addresses[0].country, 'Netherlands');
  assert.strictEqual(c.addresses[0].type, 'home');
  assert.deepStrictEqual(plain(c.dates), [{ type: 'birthday', label: '', value: '--03-09' }]);
  assert.strictEqual(c.extra.source.format, 'jcard');
  assert.deepStrictEqual(plain(c.extra.vcard), [{ g: '', n: 'X-HOBBY', p: {}, v: 'zeilen' }]);
  assert.ok(r.warnings.some((w) => /3 key\(s\) named __proto__, constructor or prototype were dropped/.test(w)));

  // Nothing leaked into any prototype, and the hostile keys are not on the copied parameter maps.
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(({}).x, undefined);
  assert.strictEqual(([]).polluted, undefined);
  assert.strictEqual(protoSnapshot(), before);
  assert.strictEqual(Object.getPrototypeOf(Object.prototype), null);
  assert.strictEqual(Object.getPrototypeOf(c.extra.vcard[0].p), null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
})();

(() => {
  // A parameter map on an unknown property keeps own keys only, with array values; group is the `group` parameter.
  const before = protoSnapshot();
  const text = '["vcard",[["fn",{},"text","Ann Lee"],["x-note",{"group":"item1","type":"a","__proto__":{"polluted":1},"prototype":"y","pref":1},"text","v"],'
    + '["x-obj",{},"unknown",{"constructor":{"prototype":{"polluted":2}},"k":["a","b"]}]]]';
  const r = J.parse(text);
  const [e1, e2] = r.contacts[0].extra.vcard;
  assert.strictEqual(e1.g, 'item1');
  assert.deepStrictEqual(plain(e1.p), { type: ['a'], pref: ['1'] });
  assert.strictEqual(e2.v, '{"k":["a","b"]}');
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(protoSnapshot(), before);
})();

(() => {
  // Several cards; a bad entry is skipped with its place; groups become labels; text and bytes both work.
  const cards = [
    ['vcard', [['version', {}, 'text', '4.0'], ['uid', {}, 'text', 'urn:uuid:1'], ['fn', {}, 'text', 'Ann Lee'], ['email', { type: ['home', 'internet'] }, 'text', 'a@example.org'], ['categories', {}, 'text', 'Work', 'work', 'Club'], ['note', {}, 'text', 'x\ny']]],
    ['vcard', [['fn', {}, 'text', 'Team'], ['kind', {}, 'text', 'group'], ['member', {}, 'text', 'urn:uuid:1']]],
    ['vcard', [['version', {}, 'text', '4.0']]],
    { not: 'a card' },
    ['vcard', [['fn', {}, 'text', 'Bo Li'], ['org', {}, 'text', ['Acme', 'Sales', 'EMEA']], ['bday', {}, 'date-and-or-time', '1990-02-30'], ['tel', {}, 'text'], 'junk']],
  ];
  const r = J.parse(Buffer.from(JSON.stringify(cards), 'utf8'));
  assert.deepStrictEqual(r.contacts.map((c) => c.name.formatted), ['Ann Lee', 'Bo Li']);
  assert.deepStrictEqual(r.contacts[0].labels, ['Work', 'Club', 'Team']);
  assert.deepStrictEqual(r.contacts[0].emails.map((e) => e.type), ['home']);
  assert.strictEqual(r.contacts[0].note, 'x\ny');
  assert.deepStrictEqual(r.skipped.map((s) => s.index), [3, 4]);
  const bo = r.contacts[1];
  assert.strictEqual(bo.org.name, 'Acme');
  assert.strictEqual(bo.org.unit, 'Sales / EMEA');
  assert.deepStrictEqual(bo.dates, []);
  assert.deepStrictEqual(bo.extra.vcard.map((e) => e.n), ['ORG', 'BDAY']);
  assert.ok(r.warnings.some((w) => /2 properties that are not/.test(w)));
})();

(() => {
  const not = (input, re) => {
    const r = J.parse(input);
    assert.strictEqual(r.contacts.length, 0);
    assert.ok(re.test(r.skipped[0].reason), r.skipped[0].reason);
  };
  not('{"a":1}', /^not a jCard$/);
  not('[]', /^not a jCard$/);
  not('"vcard"', /^not a jCard$/);
  not('42', /^not a jCard$/);
  not('', /^not a jCard: .*JSON/);
  not('[[', /^not a jCard: .*JSON/);
  // Nesting: 32 levels are read, 33 are refused before JSON.parse, and 100,000 levels do not overflow the stack.
  const nest = (n) => '['.repeat(n) + ']'.repeat(n);
  const ok = '["vcard",[["fn",{},"text","Ann Lee"],["x-deep",{},"unknown",' + nest(28) + ']]]';
  assert.strictEqual(J.parse(ok).contacts.length, 1);
  not('["vcard",[["fn",{},"text","Ann Lee"],["x-deep",{},"unknown",' + nest(30) + ']]]', /nested more than 32/);
  not(nest(100000), /nested more than 32/);
  const strings = J.parse('["vcard",[["fn",{},"text","a [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[ \\\\"]]]');
  assert.strictEqual(strings.contacts[0].name.formatted, 'a [[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[ \\');
})();

(() => {
  // One card with thousands of properties, a very long list and 20,000 cards stay fast and capped.
  const t0 = Date.now();
  const props = [['fn', {}, 'text', 'Ann Lee']];
  for (let i = 0; i < 5000; i += 1) props.push(['x-n' + i, {}, 'text', 'v'], ['tel', {}, 'text', String(i)]);
  const r = J.parse(JSON.stringify(['vcard', props]));
  const c = r.contacts[0];
  assert.strictEqual(c.phones.length, 50);
  assert.strictEqual(c.extra.vcard.length, 200);
  assert.strictEqual(r.stats.droppedExtra, 4800);
  const many = [];
  for (let i = 0; i < 20000; i += 1) many.push(['vcard', [['fn', {}, 'text', 'N' + i + ' F']]]);
  assert.strictEqual(J.parse(JSON.stringify(many)).contacts.length, 20000);
  assert.ok(Date.now() - t0 < 20000);
})();

console.log('contacts ldif and jcard: ok');
