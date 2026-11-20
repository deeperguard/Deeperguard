// Duplicate detection and merge (docs/CONTACTS_SPEC.md 7.4 and 7.10): the pure functions in contacts.js.
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'app', 'static', 'js', 'contacts.js'));

let seq = 0;
function contact(input, uuid = `c${seq += 1}`) {
  return { uuid, ...C.buildContact(input).content };
}
const ids = (groups) => groups.map((g) => [...g.ids].sort().join(','));

// --- email -------------------------------------------------------------------------------------
{
  const a = contact({ name: { given: 'A' }, emails: [{ value: 'Jan.Visser@Example.NL' }] }, 'a');
  const b = contact({ name: { given: 'B' }, emails: [{ value: '  jan.visser@example.nl ' }] }, 'b');
  const c = contact({ name: { given: 'C' }, emails: [{ value: 'jan.visser@example.com' }] }, 'c');
  const d = contact({ name: { given: 'D' }, emails: [{ value: 'janvisser@example.nl' }] }, 'd');
  const groups = C.findDuplicateGroups([a, b, c, d]);
  assert.deepStrictEqual(ids(groups), ['a,b'], 'case and spaces are ignored, other addresses do not match');
  assert.strictEqual(groups[0].kind, 'exact');
  assert.deepStrictEqual(groups[0].reasons, ['email']);
}

// --- phone -------------------------------------------------------------------------------------
{
  const phone = (value, uuid) => contact({ name: { given: uuid }, phones: [{ value }] }, uuid);
  const same = C.findDuplicateGroups([phone('+31 6 1234-5678', 'a'), phone('+31(6)12.34.56.78', 'b')]);
  assert.deepStrictEqual(ids(same), ['a,b'], 'spaces, dashes, dots and brackets are ignored');
  const zeros = C.findDuplicateGroups([phone('0031 6 12345678', 'a'), phone('+31612345678', 'b')]);
  assert.deepStrictEqual(ids(zeros), ['a,b'], '00 is the same as +');
  const national = C.findDuplicateGroups([phone('06 12345678', 'a'), phone('+31 6 12345678', 'b')]);
  assert.deepStrictEqual(ids(national), ['a,b'], 'national and international match when one international number fits');
  assert.deepStrictEqual(national[0].reasons, ['phone']);
  const ambiguous = C.findDuplicateGroups([phone('06 12345678', 'a'), phone('+31 6 12345678', 'b'), phone('+32 6 12345678', 'c')]);
  assert.deepStrictEqual(ids(ambiguous), [], 'a national number that fits two countries matches neither');
  assert.deepStrictEqual(ids(C.findDuplicateGroups([phone('+31 6 12345678', 'a'), phone('+32 6 12345678', 'b')])), [], 'different country codes differ');
  assert.deepStrictEqual(ids(C.findDuplicateGroups([phone('12345', 'a'), phone('12345', 'b')])), [], 'fewer than 6 digits never match');
  assert.deepStrictEqual(ids(C.findDuplicateGroups([phone('0612345678', 'a'), phone('0612345679', 'b')])), []);
  assert.deepStrictEqual(C.phoneKey('0031 6 12345678'), { kind: 'intl', digits: '31612345678' });
  assert.deepStrictEqual(C.phoneKey('06-12345678'), { kind: 'national', digits: '612345678' });
}

// --- name --------------------------------------------------------------------------------------
{
  const named = (given, family, uuid, extra = {}) => contact({ name: { given, family }, ...extra }, uuid);
  const groups = C.findDuplicateGroups([
    named('José', 'GARCÍA', 'a'), named('jose', '  garcia ', 'b'), named('Jose', 'Garcia-Lopez', 'c'), named('Anna', 'Berg', 'd'),
  ]);
  assert.deepStrictEqual(ids(groups), ['a,b'], 'case, accents and whitespace are ignored; a longer name is not the same');
  assert.strictEqual(groups[0].kind, 'possible', 'a name-only match is only possible');
  assert.deepStrictEqual(groups[0].reasons, ['name']);
  assert.deepStrictEqual(ids(C.findDuplicateGroups([named('Jan', 'Visser', 'a'), named('Visser', 'Jan', 'b')])), ['a,b'], 'order of given and family does not matter');
  const noName = C.findDuplicateGroups([contact({ org: { name: 'Acme' } }, 'a'), contact({ org: { name: 'Acme' } }, 'b')]);
  assert.deepStrictEqual(ids(noName), [], 'a contact without a name is not matched by name');
  // A contact in an exact group is not offered again by name.
  const mixed = C.findDuplicateGroups([
    named('Jan', 'Visser', 'a', { emails: [{ value: 'j@x.nl' }] }), named('Jan', 'Visser', 'b', { emails: [{ value: 'J@X.nl' }] }), named('Jan', 'Visser', 'c'),
  ]);
  assert.deepStrictEqual(mixed.map((g) => g.kind), ['exact']);
}

// --- ignore, empty, one ------------------------------------------------------------------------
{
  const a = contact({ name: { given: 'A' }, emails: [{ value: 'x@y.nl' }] }, 'a');
  const b = contact({ name: { given: 'B' }, emails: [{ value: 'x@y.nl' }] }, 'b');
  const [group] = C.findDuplicateGroups([a, b]);
  assert.strictEqual(group.key, C.groupKey(['b', 'a']));
  assert.deepStrictEqual(C.findDuplicateGroups([a, b], { ignore: new Set([group.key]) }), []);
  assert.deepStrictEqual(C.findDuplicateGroups([]), []);
  assert.deepStrictEqual(C.findDuplicateGroups([a]), []);
}

// --- keeper ------------------------------------------------------------------------------------
{
  const thin = contact({ name: { given: 'A' } }, 'thin');
  const full = contact({ name: { given: 'A', family: 'B' }, phones: [{ value: '1' }], emails: [{ value: 'a@b.c' }], note: 'x' }, 'full');
  assert.strictEqual(C.pickKeeper([thin, full]).uuid, 'full');
  assert.strictEqual(C.pickKeeper([full, thin]).uuid, 'full');
}

// --- merge -------------------------------------------------------------------------------------
{
  const a = contact({
    name: { given: 'Jan', family: 'Visser' }, org: { name: 'Acme' }, title: 'CEO',
    phones: [{ type: 'mobile', value: '+31 6 12345678' }, { type: 'work', value: '020 1234567' }],
    emails: [{ type: 'home', value: 'jan@x.nl' }], urls: [{ value: 'https://x.nl' }],
    dates: [{ type: 'birthday', value: '1980-02-03' }], labels: ['Family', 'Work'], note: 'Same note', favorite: false,
    extra: { vcard: [{ g: 'item1', n: 'X-ABRELATEDNAMES', p: {}, v: 'Piet' }, { g: 'item1', n: 'X-ABLabel', p: {}, v: 'Spouse' }], csv: { Hobby: 'sailing' } },
  }, 'a');
  const b = contact({
    name: { given: 'Johan', family: 'Visser' }, org: { name: 'Acme BV' }, nickname: 'Joh',
    phones: [{ type: 'home', value: '0031 6 1234 5678' }, { type: 'home', value: '+44 20 7946 0000' }],
    emails: [{ value: 'JAN@x.nl' }, { value: 'johan@y.nl' }], urls: [{ value: 'https://X.nl/' }, { value: 'https://y.nl' }],
    dates: [{ type: 'birthday', value: '1981-02-03' }, { type: 'anniversary', value: '2005-06-07' }],
    addresses: [{ type: 'home', street: 'Dam 1', city: 'Amsterdam' }], ims: [{ service: 'signal', value: 'janv' }],
    labels: ['work', 'Friends'], note: 'Same note\n\n', favorite: true,
    extra: { vcard: [{ g: 'item1', n: 'X-ABRELATEDNAMES', p: {}, v: 'Kees' }, { g: 'item1', n: 'X-ABLabel', p: {}, v: 'Boss' }], csv: { Hobby: 'chess', Club: 'RV' } },
  }, 'b');
  const c = contact({ name: { given: 'Jan', family: 'Visser' }, note: 'Other note', phones: [{ value: '020-1234567' }] }, 'c');

  const choices = C.mergeChoices([a, b, c], 'a');
  assert.deepStrictEqual(choices.map((ch) => ch.field), ['name', 'org', 'birthday'], 'only differing single-value fields are offered');
  const name = choices.find((ch) => ch.field === 'name');
  assert.strictEqual(name.options.length, 2);
  assert.deepStrictEqual(name.options[0].from, ['a', 'c'], 'the kept contact wins by default; equal values are one option');

  const plan = C.planMerge([a, b, c], 'a');
  assert.strictEqual(plan.error, '');
  assert.deepStrictEqual(plan.removeIds, ['b', 'c']);
  const p = plan.patch;
  assert.deepStrictEqual(p.phones.map((x) => x.value), ['+31 6 12345678', '020 1234567', '+44 20 7946 0000'], 'formatting-only duplicates are not doubled');
  assert.deepStrictEqual(p.emails.map((x) => x.value), ['jan@x.nl', 'johan@y.nl']);
  assert.deepStrictEqual(p.urls.map((x) => x.value), ['https://x.nl', 'https://y.nl']);
  assert.strictEqual(p.addresses.length, 1);
  assert.strictEqual(p.ims.length, 1);
  assert.deepStrictEqual(p.dates.map((d) => [d.type, d.value]), [['birthday', '1980-02-03'], ['other', '1981-02-03'], ['anniversary', '2005-06-07']], 'a birthday that lost stays as a date');
  assert.deepStrictEqual(p.labels, ['Family', 'Work', 'Friends']);
  assert.strictEqual(p.note, 'Same note\n\nOther note', 'notes joined by a blank line, the same note once');
  assert.strictEqual(p.favorite, true);
  assert.strictEqual(p.nickname, 'Joh', 'an empty field is filled from the other contact');
  assert.strictEqual(p.name.given, 'Jan');
  assert.strictEqual(p.org.name, 'Acme');
  assert.strictEqual(p.extra.vcard.length, 4);
  assert.deepStrictEqual(p.extra.vcard.map((e) => e.g), ['item1', 'item1', 'item1-2', 'item1-2'], 'property groups of different contacts stay apart');
  assert.deepStrictEqual(p.extra.csv, { Hobby: 'sailing', 'Hobby (2)': 'chess', Club: 'RV' });

  const picked = C.planMerge([a, b, c], 'a', { name: 1, org: 1, birthday: 1 });
  assert.strictEqual(picked.patch.name.given, 'Johan');
  assert.strictEqual(picked.patch.org.name, 'Acme BV');
  assert.deepStrictEqual(picked.patch.dates.map((d) => [d.type, d.value]).slice(0, 2), [['birthday', '1981-02-03'], ['other', '1980-02-03']]);

  // The patch goes through buildContact unchanged in content, and the old state can be put back.
  const built = C.buildContact(p, a).content;
  assert.strictEqual(built.phones.length, 3);
  const back = C.buildContact(C.restorePatch(a), built).content;
  for (const f of C.MERGE_FIELDS) assert.deepStrictEqual(back[f], a[f], `restore ${f}`);
  assert.deepStrictEqual(back.extra, a.extra);
}

// --- merge refuses to cut data -----------------------------------------------------------------
{
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => ({ value: `${prefix}${i}@x.nl` }));
  const a = contact({ name: { given: 'A' }, emails: many('a', 40) }, 'a');
  const b = contact({ name: { given: 'A' }, emails: many('b', 40) }, 'b');
  assert.match(C.planMerge([a, b], 'a').error, /too large/);
  const la = contact({ name: { given: 'A' }, labels: Array.from({ length: 15 }, (_, i) => `a${i}`) }, 'la');
  const lb = contact({ name: { given: 'A' }, labels: Array.from({ length: 15 }, (_, i) => `b${i}`) }, 'lb');
  assert.match(C.planMerge([la, lb], 'la').error, /groups/);
  assert.match(C.planMerge([a, b], 'zzz').error, /not found/);
}

// --- 2000 contacts -----------------------------------------------------------------------------
{
  const list = [];
  for (let i = 0; i < 2000; i += 1) {
    const base = i % 4 === 0 ? i - 1 : i; // every fourth contact repeats the previous one's email/phone/name
    list.push(contact({
      name: { given: `Given${base % 700}`, family: `Family${base}` },
      emails: [{ value: `p${base}@example.com` }], phones: [{ value: `+31 6 ${String(10000000 + base)}` }],
    }, `u${i}`));
  }
  const t0 = process.hrtime.bigint();
  const groups = C.findDuplicateGroups(list);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(groups.length >= 400, `found ${groups.length} groups`);
  assert.ok(ms < 1000, `2000 contacts took ${ms} ms`);
  console.log(`2000 contacts: ${groups.length} groups in ${ms.toFixed(1)} ms`);
}

console.log('test_contacts_duplicates.js: ok');
