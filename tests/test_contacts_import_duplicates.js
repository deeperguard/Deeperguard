// Duplicates in the contacts import (docs/CONTACTS_SPEC.md 7.4, 7.6): matching of a file against the vault and
// against itself, and the store's import with skip, merge and keep both, including undo of the merges.
const assert = require('assert');
const path = require('path');
const h = require('./sync_harness');

const js = (name) => path.join(__dirname, '..', 'app', 'static', 'js', name);
const C = require(js('contacts.js'));
global.NotesContacts = C;
const { NotesStore } = h;

const eva = () => ({
  name: { given: 'Eva', family: 'Bakker' },
  phones: [{ type: 'mobile', value: '+31 6 1234 5678' }],
  emails: [{ type: 'work', value: 'eva@bakkerbouw.example' }],
  addresses: [{ type: 'work', street: 'Keizersgracht 1', city: 'Amsterdam' }],
});
const evaFile = () => ({
  name: { given: 'Eva', family: 'Bakker' },
  phones: [{ type: 'home', value: '0031 (6) 1234-5678' }, { type: 'work', value: '020 555 0101' }],
  emails: [{ type: 'home', value: 'EVA.privé@example.nl' }],
  addresses: [{ type: 'home', street: 'Prinsengracht 9', city: 'Amsterdam' }],
  title: 'Inkoper',
});
const incomingPlain = (list) => list.map((c) => ({ ...c, phones: c.phones || [], emails: c.emails || [] }));
const byName = (family) => NotesStore.listContacts().filter((c) => c.name.family === family);

(async () => {
  // --- matching: formatting differences do not matter, the file is also compared with itself ---
  {
    const existing = [{ uuid: 'x1', ...C.buildContact(eva()).content }];
    const incoming = incomingPlain([
      evaFile(), // same phone written differently
      { name: { given: 'Jan', family: 'Visser' }, emails: [{ value: 'jan@example.nl' }] },
      { name: { given: 'Visser', family: 'Jan' }, emails: [{ value: 'other@example.nl' }] }, // same name as the previous one
      { name: { given: 'Piet' }, phones: [{ value: '(020) 555-0101' }] }, // shares a landline with Eva's incoming entry
      { name: { given: 'Eva' }, emails: [{ value: ' EVA@bakkerbouw.example ' }] }, // same email as the vault contact
    ]);
    const m = C.matchIncoming(incoming, existing);
    assert.strictEqual(m[0].existing, true);
    assert.ok(m[0].reasons.includes('phone'));
    assert.deepStrictEqual(m[0].target, { id: 'x1' });
    assert.strictEqual(m[1], null);
    assert.deepStrictEqual([m[2].existing, m[2].kind, m[2].target], [false, 'possible', { index: 1 }]);
    assert.strictEqual(m[3].existing, true, 'the same landline as an entry that is itself a duplicate still matches the vault contact');
    assert.ok(m[4].reasons.includes('email'));
    // two people in one file who only share a landline are not duplicates of each other
    const family = C.matchIncoming(incomingPlain([
      { name: { given: 'Anna', family: 'Smit' }, phones: [{ value: '020 555 0199' }] },
      { name: { given: 'Bram', family: 'Smit' }, phones: [{ value: '+31 20 555 0199' }] },
    ]), []);
    assert.deepStrictEqual(family, [null, null]);
    // the same person twice in one file
    const twice = C.matchIncoming(incomingPlain([
      { name: { given: 'Anna', family: 'Smit' }, phones: [{ value: '020 555 0199' }] },
      { name: { given: 'Anna', family: 'Smit' }, phones: [{ value: '+31 20 555 0199' }] },
    ]), []);
    assert.strictEqual(twice[0], null);
    assert.deepStrictEqual(twice[1].target, { index: 0 });
    assert.deepStrictEqual(C.matchIncoming([], []), []);
  }

  // --- the store: skip, merge, keep both, twice, undo ---
  await h.unlockFresh();
  h.resetServer();
  NotesStore.addContact(eva());
  const vault = () => NotesStore.listContacts();
  const decide = (list, action) => {
    const m = C.matchIncoming(list, vault());
    const list2 = [];
    const merges = new Map();
    list.forEach((c, i) => {
      if (!m[i]) { list2.push(c); return; }
      if (action === 'skip') return;
      if (action === 'merge') merges.set(list2.length, m[i].target.id !== undefined ? { id: m[i].target.id } : { index: list2.length - 1 });
      list2.push(c);
    });
    return { list2, merges };
  };
  const file = () => incomingPlain([evaFile(), { name: { given: 'Jan', family: 'Visser' }, emails: [{ value: 'jan@example.nl' }] }]);

  // skip: the first run adds Jan only, the second adds nothing
  let { list2, merges } = decide(file(), 'skip');
  let r = await NotesStore.importContacts(list2, { batch: 'b1', merges });
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(vault().length, 2);
  ({ list2, merges } = decide(file(), 'skip'));
  assert.strictEqual(list2.length, 0, 'importing the same file again with skip adds nothing');
  assert.strictEqual(vault().length, 2);

  // keep both: the file doubles
  ({ list2, merges } = decide(file(), 'both'));
  r = await NotesStore.importContacts(list2, { batch: 'b2', merges });
  assert.strictEqual(r.created.length, 2);
  assert.strictEqual(vault().length, 4);
  for (const id of r.created) NotesStore.removeContact(id);
  assert.strictEqual(vault().length, 2);

  // merge: nothing is lost, existing values win, nothing is added twice
  const original = byName('Bakker')[0];
  ({ list2, merges } = decide(file(), 'merge'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  r = await NotesStore.importContacts(list2, { batch: 'b3', merges });
  assert.strictEqual(r.mergedCount, 2, 'both matching entries were merged');
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(vault().length, 2, 'merging adds no contact');
  const merged = byName('Bakker')[0];
  assert.strictEqual(merged.uuid, original.uuid);
  assert.deepStrictEqual(merged.phones.map((p) => p.value).sort(), ['+31 6 1234 5678', '020 555 0101'], 'the same number in another format is not added twice, the new one is');
  assert.deepStrictEqual(merged.emails.map((e) => e.value).sort(), ['EVA.privé@example.nl', 'eva@bakkerbouw.example']);
  assert.deepStrictEqual(merged.addresses.map((a) => a.street).sort(), ['Keizersgracht 1', 'Prinsengracht 9']);
  assert.strictEqual(merged.title, 'Inkoper', 'an empty field is filled from the file');
  assert.strictEqual(merged.phones[0].value, '+31 6 1234 5678', 'the existing value stays first');
  const jan = byName('Visser')[0];
  assert.strictEqual(jan.emails.length, 1);

  // merging the same file again changes nothing in the data
  ({ list2, merges } = decide(file(), 'merge'));
  const snap = JSON.stringify(vault().map((c) => [c.uuid, c.phones.map((p) => p.value), c.emails.map((e) => e.value), c.addresses.length]));
  const again = await NotesStore.importContacts(list2, { batch: 'b4', merges });
  assert.strictEqual(vault().length, 2);
  assert.strictEqual(JSON.stringify(vault().map((c) => [c.uuid, c.phones.map((p) => p.value), c.emails.map((e) => e.value), c.addresses.length])), snap);

  // undo of the first merge run puts the contacts back as they were before it; the second run changed nothing
  const afterB3 = r;
  assert.strictEqual(afterB3.merged.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const undoAgain = NotesStore.restoreContacts(again);
  assert.deepStrictEqual(undoAgain.removed, 0);
  assert.strictEqual(byName('Bakker')[0].phones.length, 2, 'undoing the second run leaves what the first merge added');
  const undone = NotesStore.restoreContacts(afterB3);
  assert.strictEqual(undone.kept, 2, 'merged contacts touched by a later import are kept as they are');

  // a fresh merge and its undo
  NotesStore.addContact({ name: { given: 'Lotte', family: 'Boer' }, phones: [{ value: '06 1111 2222' }] });
  const file2 = incomingPlain([{ name: { given: 'Lotte', family: 'de Boer' }, phones: [{ value: '+31 6 1111 2222' }, { value: '030 555 0100' }], note: 'Via de buren' }]);
  ({ list2, merges } = decide(file2, 'merge'));
  const before = byName('Boer')[0];
  const r2 = await NotesStore.importContacts(list2, { batch: 'b5', merges });
  assert.strictEqual(r2.mergedCount, 1);
  assert.strictEqual(byName('Boer')[0].phones.length, 3, 'a national and an international form are both kept: nothing is dropped');
  assert.strictEqual(byName('Boer')[0].note, 'Via de buren');
  const u2 = NotesStore.restoreContacts(r2);
  assert.deepStrictEqual([u2.removed, u2.restored, u2.kept], [0, 1, 0]);
  const back = byName('Boer')[0];
  assert.deepStrictEqual(back.phones.map((p) => p.value), before.phones.map((p) => p.value));
  assert.strictEqual(back.note, before.note);
  assert.strictEqual(vault().length, 3);

  // two duplicates of one file entry: the second merges into the one created by this import, undo removes it
  const inFile = incomingPlain([
    { name: { given: 'Noor', family: 'Dam' }, phones: [{ value: '06 2222 3333' }] },
    { name: { given: 'Noor', family: 'Dam' }, emails: [{ value: 'noor@example.nl' }] },
  ]);
  const mm = C.matchIncoming(inFile, vault());
  assert.deepStrictEqual(mm[0], null);
  assert.deepStrictEqual([mm[1].kind, mm[1].target], ['possible', { index: 0 }], 'only the name is the same: a possible duplicate');
  const forced = incomingPlain([
    { name: { given: 'Noor', family: 'Dam' }, phones: [{ value: '06 2222 3333' }] },
    { name: { given: 'Noor', family: 'Dam' }, phones: [{ value: '(06) 2222-3333' }], emails: [{ value: 'noor@example.nl' }] },
  ]);
  const fm = C.matchIncoming(forced, vault());
  assert.deepStrictEqual(fm[1].target, { index: 0 });
  const r3 = await NotesStore.importContacts(forced, { batch: 'b6', merges: new Map([[1, { index: 0 }]]) });
  assert.strictEqual(r3.created.length, 1);
  assert.strictEqual(r3.mergedCount, 1);
  const noor = byName('Dam')[0];
  assert.deepStrictEqual([noor.phones.length, noor.emails.length], [1, 1]);
  NotesStore.restoreContacts(r3);
  assert.strictEqual(byName('Dam').length, 0);

  // a target that is gone: the entry is added as a new contact, nothing is lost
  const r4 = await NotesStore.importContacts(incomingPlain([{ name: { given: 'Zed' }, emails: [{ value: 'z@example.nl' }] }]), { merges: new Map([[0, { id: 'does-not-exist' }]]) });
  assert.deepStrictEqual([r4.created.length, r4.mergedCount], [1, 0]);

  console.log('contacts import duplicates ok');
})().catch((err) => { console.error(err); process.exit(1); });
