// vCard import and export for contacts (docs/CONTACTS_SPEC.md 6.1, 7, 8.2): the spec's sample files for 2.1, 3.0
// and 4.0 and each named flavour, folding, quoted-printable, charsets, several cards per file, the limits and
// their messages, round trip with unknown properties, and import and undo through the real NotesStore.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');

const js = (name) => path.join(__dirname, '..', 'app', 'static', 'js', name);
const C = require(js('contacts.js'));
const V = require(js('contacts-vcard.js'));
global.NotesContacts = C;
global.NotesContactsVcard = V;
const I = require(js('contacts-import.js'));
const { NotesStore } = h;

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'contacts', name));
const fakeFile = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
const only = (bytes) => { const r = V.parse(bytes); assert.strictEqual(r.contacts.length, 1, JSON.stringify(r.skipped)); return r.contacts[0]; };
const vals = (list) => list.map((e) => e.value);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function samePhoto(c) {
  assert.strictEqual(c.photoSource.mime, 'image/png');
  assert.deepStrictEqual(Array.from(c.photoSource.bytes.subarray(0, 4)), PNG_SIG);
}

// What the store keeps of a parsed contact, without ids, clocks and the source block.
function stored(c) {
  const { content } = C.buildContact({ ...c, photo: c.photo || null }, null, '2026-11-19T10:00:00.000Z');
  const strip = (list) => list.map(({ id, ...rest }) => rest);
  const out = { ...content };
  for (const f of C.LIST_FIELDS) out[f] = strip(out[f]);
  delete out.created_at; delete out.updated_at; delete out.fc; delete out.fb;
  delete out.photo;
  out.extra = { vcard: (content.extra && content.extra.vcard) || [] };
  return JSON.parse(JSON.stringify(out));
}

(async () => {
  // --- vCard 2.1 from Outlook / old Android: quoted-printable, ISO-8859-1, soft breaks, folded photo, cut-off card
  {
    const r = V.parse(fixture('outlook-android-2.1.vcf'));
    assert.strictEqual(r.contacts.length, 2);
    assert.deepStrictEqual(r.warnings, ['card 2 was not closed']);
    const [a, b] = r.contacts;
    assert.deepStrictEqual([a.name.prefix, a.name.given, a.name.family], ['Dr.', 'Jürgen', 'Müller']);
    assert.deepStrictEqual(a.org, { name: 'Müller & Söhne GmbH', unit: 'Einkauf' });
    assert.deepStrictEqual(a.phones.map((p) => [p.type, p.pref]), [['mobile', true], ['home', false], ['work', false]]);
    assert.deepStrictEqual(vals(a.phones), ['+49 170 1234567', '+49 30 123456', '+49 30 123457']);
    assert.deepStrictEqual(a.emails.map((e) => [e.type, e.value]), [['home', 'juergen@example.de']]);
    assert.strictEqual(a.addresses[0].street, 'Straße des 17. Juni 1');
    assert.strictEqual(a.addresses[0].country, 'Deutschland'); // QP soft break without leading space
    assert.strictEqual(a.note.replace(/\r/g, ''), 'Erste Zeile\nZweite Zeile, lang genug für einen weichen Umbruch');
    assert.deepStrictEqual(a.dates, [{ type: 'birthday', label: '', value: '1964-05-12' }]);
    samePhoto(a); // folded base64 photo, empty line after it
    assert.strictEqual(b.name.family, 'Koch');
    assert.deepStrictEqual(b.phones.map((p) => [p.type, p.value]), [['mobile', '+49 171 7654321']]);
  }

  // --- vCard 3.0 Apple: groups, X-ABLabel, folded note, 1604 birthday, unknown properties
  {
    const c = only(fixture('apple-3.0.vcf'));
    assert.deepStrictEqual([c.name.prefix, c.name.given, c.name.additional, c.name.family], ['Mevr.', 'Sanne', 'Marie', 'Visser']);
    assert.strictEqual(c.nickname, 'San');
    assert.deepStrictEqual(c.org, { name: 'Visser Bouw B.V.', unit: 'Inkoop' });
    assert.deepStrictEqual(c.emails.map((e) => [e.type, e.pref, e.value]), [['work', true, 'sanne@visserbouw.example'], ['home', false, 'sanne.visser@example.org']]);
    assert.deepStrictEqual(c.phones.map((p) => [p.type, p.value]), [['mobile', '+31 6 12 34 56 78'], ['home', '+31 30 555 0199']]);
    assert.deepStrictEqual([c.urls[0].type, c.urls[0].label], ['custom', 'Bedrijfssite']);
    assert.strictEqual(c.addresses[0].street, 'Wilhelminastraat 5');
    assert.strictEqual(c.addresses[0].postal, '8011 AB');
    assert.deepStrictEqual(c.dates.map((d) => [d.type, d.value]), [['birthday', '--03-09'], ['anniversary', '2016-06-01']]);
    assert.deepStrictEqual(c.ims, [{ service: 'twitter', value: 'sannev' }]);
    assert.deepStrictEqual(c.labels, ['Werk', 'Bouw']);
    assert.strictEqual(c.note, 'Lunch op 12 mei, vraag naar de offerte voor de nieuwbouw in Zwolle en bel na 17:00 terug.\nTweede regel van de notitie.');
    assert.strictEqual(c.uid, 'A1B2C3D4-0000-4000-8000-123456789ABC');
    samePhoto(c);
    assert.deepStrictEqual(c.extra.vcard.map((e) => [e.g, e.n, e.v]), [['item5', 'X-ABRELATEDNAMES', 'Jan Visser'], ['item5', 'X-ABLabel'.toUpperCase(), '_$!<Spouse>!$_']]);
    assert.strictEqual(V.parse(fixture('apple-3.0.vcf')).stats.flavour, 'apple');
  }

  // --- Google: JPEG label on PNG bytes (bytes decide), custom label, myContacts dropped
  {
    const c = only(fixture('google-3.0.vcf'));
    assert.deepStrictEqual(c.labels, ["Collega's"]);
    assert.deepStrictEqual([c.phones[1].type, c.phones[1].label, c.phones[1].value], ['custom', 'Thuis kantoor', '+31 20 5551234']);
    assert.deepStrictEqual(c.org, { name: 'Dam Transport', unit: '' });
    assert.strictEqual(c.dates[0].value, '1979-11-30');
    assert.strictEqual(c.note, 'Eerste contact via beurs.\nVoorkeur: e-mail');
    assert.deepStrictEqual(c.emails.map((e) => e.type), ['home', 'work']); // repeated TYPE= parameters
    samePhoto(c);
    assert.strictEqual(V.parse(fixture('google-3.0.vcf')).stats.flavour, 'google');
  }

  // --- Android
  {
    const c = only(fixture('android-3.0.vcf'));
    assert.strictEqual(c.nickname, 'Keesie');
    assert.strictEqual(c.phones[0].value, '0612345678');
    assert.deepStrictEqual(c.dates, [{ type: 'birthday', label: '', value: '1985-07-04' }, { type: 'other', label: 'Eerste kus', value: '2012-09-01' }]);
    assert.strictEqual(c.phones[1].type, 'work');
    assert.strictEqual(c.extra.vcard, undefined); // every property was mapped
    assert.strictEqual(V.parse(fixture('android-3.0.vcf')).stats.flavour, 'android');
  }

  // --- Outlook desktop: LABEL twin is not a second address
  {
    const c = only(fixture('outlook-2.1.vcf'));
    assert.strictEqual(c.addresses.length, 1);
    assert.deepStrictEqual([c.addresses[0].city, c.addresses[0].region, c.addresses[0].postal], ['Redmond', 'WA', '98052']);
    assert.deepStrictEqual(vals(c.phones), ['+1 (425) 555-0100', '+1 (425) 555-0111']);
    assert.deepStrictEqual(c.org, { name: 'Contoso Ltd.', unit: 'Sales' });
    assert.deepStrictEqual(c.extra.vcard.map((e) => e.n), ['LABEL', 'X-MS-OL-DEFAULT-POSTAL-ADDRESS']);
    assert.strictEqual(V.parse(fixture('outlook-2.1.vcf')).stats.flavour, 'outlook');
  }

  // --- Nextcloud 4.0: quoted multi-valued TYPE, tel: URI, year-less birthday, data: URI photo
  {
    const c = only(fixture('nextcloud-4.0.vcf'));
    assert.deepStrictEqual([c.phones[0].type, c.phones[0].pref, c.phones[0].value], ['mobile', true, '+31-6-22334455']);
    assert.deepStrictEqual(c.dates.map((d) => [d.type, d.value]), [['birthday', '--02-14'], ['anniversary', '2010-06-05']]);
    assert.deepStrictEqual(c.ims, [{ service: 'matrix', value: 'u/lotte:matrix.example' }]);
    assert.deepStrictEqual(c.extra.vcard.map((e) => e.n), ['GENDER', 'KIND']);
    assert.deepStrictEqual(c.labels, ['Familie', 'Vrienden']);
    samePhoto(c);
  }

  // --- Proton 4.0 (unverified sample): no N, two-word FN, PREF=1
  {
    const c = only(fixture('proton-4.0.vcf'));
    assert.deepStrictEqual([c.name.given, c.name.family, c.name.formatted], ['Noor', 'Hendriks', 'Noor Hendriks']);
    assert.deepStrictEqual(c.emails.map((e) => e.pref), [true, false]);
    assert.deepStrictEqual(c.labels, ['Friends']);
  }

  // --- a whole file in windows-1252, a UTF-16 file with BOM, a UTF-8 BOM, CR-only line ends, mixed several cards
  {
    const latin = Buffer.from('BEGIN:VCARD\nVERSION:3.0\nFN:Jürgen Müller\nN:Müller;Jürgen;;;\nNOTE:Café\nEND:VCARD\n', 'latin1');
    assert.strictEqual(V.decodeBytes(latin).encoding, 'windows-1252');
    const c = only(latin);
    assert.deepStrictEqual([c.name.given, c.name.family, c.note], ['Jürgen', 'Müller', 'Café']);
    const forced = V.decodeBytes(Buffer.from('é', 'utf8'), 'windows-1252');
    assert.strictEqual(forced.text, 'Ã©');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Zoë Smit\r\nEND:VCARD\r\n', 'utf16le')]);
    assert.strictEqual(only(utf16).name.formatted, 'Zoë Smit');
    const cr = Buffer.from('﻿BEGIN:VCARD\rVERSION:3.0\rFN:A B\rTEL:1234567\rEND:VCARD\rBEGIN:VCARD\rVERSION:4.0\rFN:C D\rEMAIL:c@d.example\rEND:VCARD\r');
    const r = V.parse(cr);
    assert.deepStrictEqual(r.contacts.map((x) => x.name.formatted), ['A B', 'C D']);
    assert.deepStrictEqual(r.stats.versions, ['3.0', '4.0']);
    // per-property CHARSET with quoted-printable in a UTF-8 file
    const qp = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen\r\nN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:=C5ngstr=F6m;=D8yvind;;;\r\nEND:VCARD\r\n';
    const q = only(Buffer.from(qp));
    assert.strictEqual(q.name.formatted, 'Jürgen');
    assert.deepStrictEqual([q.name.family, q.name.given], ['Ångström', 'Øyvind']);
    // folding in the middle of a multi-byte character's neighbours and tab folding of 2.1
    const folded = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Anna\r\n\tvan Dijk\r\nNOTE:one\r\n two\r\nEND:VCARD\r\n';
    const f = only(Buffer.from(folded));
    assert.strictEqual(f.name.formatted, 'Annavan Dijk');
    assert.strictEqual(f.note, 'onetwo');
  }

  // --- a broken entry is reported and skipped, the rest is imported; hostile keys and limits
  {
    const text = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Goed Een', 'TEL:0612345678', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'NOTE:geen naam of nummer', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Goed Twee', 'EMAIL:twee@example.com', 'PHOTO;ENCODING=b;TYPE=JPEG:bm90IGFuIGltYWdl', 'X-__PROTO__:1', '__proto__.X-EVIL;__proto__=1:2', 'END:VCARD', '',
    ].join('\r\n');
    const r = V.parse(text);
    assert.deepStrictEqual(r.contacts.map((c) => c.name.formatted), ['Goed Een', 'Goed Twee']);
    assert.deepStrictEqual(r.skipped, [{ index: 2, reason: 'card 2 has no name, phone or email' }]);
    assert.ok(r.warnings.some((w) => /card 3: photo is not a PNG/.test(w)));
    assert.strictEqual(r.contacts[1].photoSource, null);
    assert.strictEqual(Object.prototype.polluted, undefined);
    const many = Array.from({ length: 60 }, (_, i) => `TEL:+3161000${String(i).padStart(4, '0')}`);
    const big = V.parse(['BEGIN:VCARD', 'FN:Veel', ...many, 'END:VCARD'].join('\n'));
    assert.strictEqual(big.contacts[0].phones.length, 50);
    assert.ok(big.warnings.includes('card 1: kept 50 of 60 phones'));
    assert.strictEqual(V.parse('BEGIN:VCARD\nKIND:group\nFN:Team\nMEMBER:urn:uuid:x\nEND:VCARD\n').skipped[0].reason, 'card 1 is a group card, not a contact');
  }

  // --- import flow messages and limits (nothing is read for a refused file)
  {
    const good = fakeFile('a.vcf', fixture('apple-3.0.vcf'));
    let read = false;
    const huge = { name: 'huge.vcf', size: 64 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } };
    const state = await I.readFiles([fakeFile('empty.vcf', Buffer.alloc(0)), huge, fakeFile('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), fakeFile('notes.txt', Buffer.from('just some text\n')), fakeFile('broken.vcf', Buffer.from('BEGIN:VCARD\nVERSION:3.0\nNOTE:x\nEND:VCARD\nBEGIN:VCARD\nFN:Ok\nTEL:123456\nEND:VCARD\n')), good, fakeFile('b.vcf', fixture('outlook-android-2.1.vcf'))]);
    assert.strictEqual(read, false);
    assert.strictEqual(state.contacts.length, 4);
    assert.deepStrictEqual(state.files.map((f) => f.ok), [false, false, false, false, true, true, true]);
    assert.strictEqual(state.problems[0], 'empty.vcf: this file is empty.');
    assert.ok(/^huge\.vcf: this file is larger than 64 MiB\. .*without photos\.$/.test(state.problems[1]), state.problems[1]);
    assert.strictEqual(state.problems[2], 'photo.png: This is not a contact file. Export your contacts as vCard (.vcf) and choose that file.');
    assert.ok(state.problems[3].startsWith('notes.txt: This is not a contact file'));
    assert.ok(state.problems.includes('broken.vcf: card 1 has no name, phone or email'));
    assert.ok(state.problems.includes('b.vcf: card 2 was not closed'));
    assert.strictEqual(state.files[0].label, '');
    assert.strictEqual(state.files[5].label, 'vCard 3.0, Apple, utf-8');
    assert.strictEqual(I.previewSummary(state, 1), 'Found 4 contacts in 7 files. 1 look like contacts you already have. 1 skipped. 4 files not read. 8 problems found. 2 with a photo.'.replace('8 problems', `${state.problems.length} problems`));
    const total = await I.readFiles([{ name: 'x.vcf', size: 60 * 1024 * 1024, arrayBuffer: async () => Buffer.from('BEGIN:VCARD\nFN:A B\nTEL:123456\nEND:VCARD') }, { name: 'y.vcf', size: 60 * 1024 * 1024, arrayBuffer: async () => Buffer.from('BEGIN:VCARD\nFN:A B\nTEL:123456\nEND:VCARD') }, { name: 'z.vcf', size: 60 * 1024 * 1024, arrayBuffer: async () => Buffer.alloc(1) }]);
    assert.ok(/together are larger than 128 MiB/.test(total.problems[0]), total.problems.join('|'));
    // a plug-in format uses the same preview and summary
    I.registerFormat({ id: 'demo', label: 'Demo', sniff: (t) => t.startsWith('DEMO'), parse: () => ({ contacts: [{ name: { formatted: 'Demo' }, phones: [{ type: 'other', label: '', value: '555 0100 55' }], emails: [] }], skipped: [], warnings: [], stats: {} }) });
    const demo = await I.readFiles([fakeFile('d.txt', Buffer.from('DEMO file'))]);
    assert.strictEqual(demo.contacts[0].sourceFormat, 'demo');
    assert.strictEqual(demo.files[0].label, 'Demo');
    // contacts per import
    const cards = Array.from({ length: 10005 }, (_, i) => `BEGIN:VCARD\nFN:C ${i}\nTEL:+316${String(i).padStart(8, '0')}\nEND:VCARD`).join('\n');
    const lim = await I.readFiles([fakeFile('many.vcf', Buffer.from(cards))]);
    assert.strictEqual(lim.contacts.length, 10000);
    assert.ok(lim.problems.includes('Too many contacts: 10,000 is the most per import, 5 were left out. Import the rest in a second run.'));
  }

  // --- export: line length, folding, escaping, version differences
  {
    const note = `Regel één, met komma; en puntkomma\\ en nieuwe\nregel ${'é'.repeat(80)}`;
    const text = V.write([{ uid: 'urn:uuid:1', name: { prefix: '', given: 'Eva', additional: '', family: 'Bakker', suffix: '', formatted: 'Eva Bakker' }, org: { name: 'A;B', unit: '' }, phones: [{ type: 'custom', label: 'Thuis kantoor', value: '020 555', pref: true }], emails: [], addresses: [], urls: [], ims: [], dates: [{ type: 'birthday', value: '--03-09' }], note, labels: ['X,Y'], extra: {}, updated_at: '2026-11-19T10:00:00.000Z' }], { version: '3.0' });
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
    assert.ok(text.includes('BDAY:--0309\r\n'));
    assert.ok(text.includes('item1.TEL;TYPE=PREF:020 555\r\nitem1.X-ABLabel:Thuis kantoor\r\n'));
    assert.ok(text.includes('REV:20261119T100000Z\r\n'));
    assert.ok(text.includes('ORG:A\\;B\r\n'));
    assert.ok(V.write([{ name: { formatted: 'Eva' }, dates: [{ type: 'birthday', value: '--03-09' }], phones: [{ type: 'mobile', value: '+31 6 123', pref: true }, { type: 'work', value: '+31612' }] }], { version: '4.0' }).includes('BDAY:--03-09\r\n'));
    const v4 = V.write([{ name: { formatted: 'Eva' }, phones: [{ type: 'mobile', value: '+31 6 123', pref: true }, { type: 'work', value: '+31612' }] }], { version: '4.0' });
    assert.ok(v4.includes('TEL;TYPE=cell;PREF=1;VALUE=text:+31 6 123\r\n'), v4);
    assert.ok(v4.includes('TEL;TYPE=work;VALUE=uri:tel:+31612\r\n'), v4);
    const back = only(Buffer.from(text));
    assert.strictEqual(back.note, note);
    assert.deepStrictEqual(back.labels, ['X,Y']);
    assert.deepStrictEqual([back.org.name, back.phones[0].label, back.phones[0].pref], ['A;B', 'Thuis kantoor', true]);
  }

  // --- import, export, import again: same contacts, unknown properties included
  {
    const files = ['outlook-android-2.1.vcf', 'apple-3.0.vcf', 'google-3.0.vcf', 'android-3.0.vcf', 'outlook-2.1.vcf', 'nextcloud-4.0.vcf', 'proton-4.0.vcf'];
    const first = files.flatMap((f) => V.parse(fixture(f)).contacts);
    assert.strictEqual(first.length, 8);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
    const asModel = (list) => list.map((c) => ({ ...C.buildContact({ ...c, photo: c.photoSource ? { mime: 'image/jpeg', data: jpeg.toString('base64'), w: 1, h: 1 } : null }, null, '2026-11-19T10:00:00.000Z').content }));
    for (const version of ['3.0', '4.0']) {
      const models = asModel(first);
      const second = V.parse(Buffer.from(V.write(models, { version })));
      assert.strictEqual(second.skipped.length, 0, JSON.stringify(second.skipped));
      assert.strictEqual(second.contacts.length, first.length);
      first.forEach((c, i) => {
        const a = stored({ ...c, uid: models[i].uid });
        const b = stored(second.contacts[i]);
        assert.deepStrictEqual(b, a, `${version} contact ${i}`);
        if (c.photoSource) assert.deepStrictEqual(Buffer.from(second.contacts[i].photoSource.bytes), jpeg);
        else assert.strictEqual(second.contacts[i].photoSource, null);
      });
      const unknown = models[2].extra.vcard;
      assert.ok(unknown.length >= 2 && V.write(models, { version }).includes('item5.X-ABRELATEDNAMES;TYPE=pref:Jan Visser'));
    }
    // a PHOTO given as a URL is not fetched and not a photo, but kept in extra and written back on export
    for (const line of ['PHOTO;VALUE=uri:https://example.com/eva.jpg', 'PHOTO;VALUE=URL;TYPE=JPEG:http://example.com/e.jpg']) {
      const pc = only(Buffer.from(`BEGIN:VCARD\nVERSION:3.0\nFN:Eva Url\n${line}\nEND:VCARD\n`));
      assert.strictEqual(pc.photoSource, null);
      assert.strictEqual(pc.extra.vcard.length, 1, JSON.stringify(pc.extra));
      const out = V.write([C.buildContact(pc, null).content], { version: '3.0' });
      assert.ok(out.includes(`${line}\r\n`), out);
      assert.deepStrictEqual(only(Buffer.from(out)).extra.vcard, pc.extra.vcard);
    }
    // multi-unit ORG survives
    const org = only(Buffer.from('BEGIN:VCARD\nFN:X\nORG:Acme;Sales;EMEA\nEND:VCARD\n'));
    assert.deepStrictEqual(org.org, { name: 'Acme', unit: 'Sales / EMEA' });
    const again = only(Buffer.from(V.write([C.buildContact(org, null).content])));
    assert.deepStrictEqual(again.extra.vcard, org.extra.vcard);
    assert.ok(V.write([C.buildContact(org, null).content]).includes('ORG:Acme;Sales;EMEA\r\n'));
  }

  // --- the store: import writes ciphertext only, undo removes exactly the last import
  {
    // a locked vault refuses to import or undo
    await assert.rejects(() => NotesStore.importContacts([{ name: { given: 'X' } }]), /Unlock the vault first/);
    assert.throws(() => NotesStore.restoreContacts({ created: [] }), /Unlock the vault first/);
    await h.unlockFresh();
    h.resetServer();
    const existing = NotesStore.addContact({ name: { given: 'Sanne', family: 'Oud' }, emails: [{ type: 'work', value: 'sanne@visserbouw.example' }] });
    const fileA = await I.readFiles([fakeFile('a.vcf', Buffer.concat([fixture('apple-3.0.vcf'), fixture('proton-4.0.vcf')]))]);
    assert.strictEqual(fileA.contacts.length, 2);
    const hits = C.matchIncoming(fileA.contacts, NotesStore.listContacts()).map((m) => !!m);
    assert.deepStrictEqual(hits, [true, false]); // the first has the same email as the contact already in the vault
    const first = await NotesStore.importContacts([fileA.contacts[1]], { batch: 'b-1' });
    assert.strictEqual(first.created.length, 1);
    const fileB = await I.readFiles([fakeFile('b.vcf', Buffer.concat([fixture('android-3.0.vcf'), fixture('google-3.0.vcf'), fixture('nextcloud-4.0.vcf')]))]);
    const second = await NotesStore.importContacts(fileB.contacts, { batch: 'b-2', source: { flavour: 'mixed' } });
    assert.strictEqual(second.created.length, 3);
    assert.strictEqual(NotesStore.listContacts().length, 5);
    const imported = NotesStore.listContacts().find((c) => c.name.family === 'Jansen');
    assert.strictEqual(imported.extra.source.batch, 'b-2');
    assert.strictEqual(imported.extra.source.format, 'vcard');
    assert.strictEqual(imported.phones[0].value, '0612345678');
    // one contact edited after the import is kept by the undo
    const edited = NotesStore.listContacts().find((c) => c.name.family === 'van Dam');
    await new Promise((r) => setTimeout(r, 5));
    NotesStore.updateContact(edited.uuid, { title: 'Baas' });
    const undone = NotesStore.restoreContacts(second);
    assert.deepStrictEqual(undone, { removed: 2, restored: 0, kept: 1 });
    const left = NotesStore.listContacts().map((c) => c.name.family).sort();
    assert.deepStrictEqual(left, ['Hendriks', 'Oud', 'van Dam']);
    assert.ok(NotesStore.listContacts().some((c) => c.uuid === existing.uuid));
    assert.deepStrictEqual(NotesStore.restoreContacts(second), { removed: 0, restored: 0, kept: 1 }); // twice: nothing more to remove
    // the server only ever saw ciphertext
    h.stopPushTimer();
    await NotesStore.pushDirty({ quiet: true });
    const pushedUuids = new Set(h.pushCalls().flatMap((c) => (c.body.items || []).map((r) => r.item_uuid)));
    assert.ok(second.created.every((id) => pushedUuids.has(id)), 'the imported contacts were pushed');
    const wire = JSON.stringify(h.pushCalls().map((c) => c.body));
    for (const secret of ['Jansen', 'Kees', 'van Dam', '0612345678', 'Hendriks']) assert.ok(!wire.includes(secret), `${secret} reached the server in plaintext`);
  }

  console.log('contacts vcard ok');
})().catch((err) => { console.error(err); process.exit(1); });
