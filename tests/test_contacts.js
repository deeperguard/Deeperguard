// Contacts data layer (docs/CONTACTS_SPEC.md sections 2, 3, 5): create, edit, delete, search, groups,
// favourites, photo limit, unknown fields, the ciphertext on the wire, lock, backup restore and the
// field-level merge on a push conflict, all through the real NotesStore.
const assert = require('assert');
const path = require('path');
const h = require('./sync_harness');
const C = require(path.join(__dirname, '..', 'app', 'static', 'js', 'contacts.js'));

global.NotesContacts = C;
const { NotesStore } = h;
const iso = (ms) => new Date(ms).toISOString();

function pushedRows() {
  return h.pushCalls().flatMap((c) => c.body.items || []);
}

function jpegB64(bytes) {
  return Buffer.alloc(bytes, 7).toString('base64');
}

(async () => {
  // --- unlock required ---------------------------------------------------------
  assert.throws(() => NotesStore.addContact({ name: { given: 'X' } }), /Unlock the vault first/);

  await h.unlockFresh();
  h.resetServer();

  // An account without contacts simply has none; notes are unaffected.
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Old note', content: 'hello' });
  assert.deepStrictEqual(NotesStore.listContacts(), []);
  assert.deepStrictEqual(NotesStore.listContactLabels(), []);

  // --- create + read -------------------------------------------------------------
  const eva = NotesStore.addContact({
    name: { given: 'Eva', family: 'Bakker' },
    org: { name: 'Bakker Bouw B.V.', unit: 'Inkoop' },
    phones: [{ type: 'mobile', value: '+31 6 12345678' }],
    emails: [{ type: 'work', value: 'eva@bakkerbouw.example' }],
    addresses: [{ type: 'home', street: 'Keizersgracht 1', city: 'Amsterdam', country: 'Nederland' }],
    note: 'Lunch 12 mei.\nBel na 17:00.',
    labels: ['Werk', 'werk', 'Bouw'],
  });
  NotesStore.addContact({ name: { given: 'José', family: 'Müller' }, favorite: true, phones: [{ value: '020 555 01 02' }] });
  const zed = NotesStore.addContact({ name: { formatted: 'Zed Taxi' }, labels: ['Bouw'] });
  const list = NotesStore.listContacts();
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((c) => C.displayName(c)), ['Eva Bakker', 'José Müller', 'Zed Taxi']);
  const stored = NotesStore.get(eva.uuid).content;
  assert.strictEqual(stored.type, 'contact');
  assert.deepStrictEqual(stored.labels, ['Werk', 'Bouw'], 'labels de-duplicated case-insensitively');
  assert.match(stored.phones[0].id, /^[A-Z2-7]{8}$/, 'entries get a stable id');
  assert.match(stored.uid, /^urn:uuid:/);
  assert.ok(!NotesStore.listNotes().some((n) => n.uuid === eva.uuid), 'a contact is not a note');
  assert.strictEqual(NotesStore.listNotes().length, 1);

  // --- edit: only the given fields change, unknown keys survive -------------------------
  const phoneId = stored.phones[0].id;
  NotesStore.get(eva.uuid).content.future_key = { keep: 'me' };
  NotesStore.updateContact(eva.uuid, { title: 'Inkoper' });
  const after = NotesStore.get(eva.uuid).content;
  assert.strictEqual(after.title, 'Inkoper');
  assert.deepStrictEqual(after.future_key, { keep: 'me' });
  assert.strictEqual(after.phones[0].id, phoneId, 'ids are stable across edits');
  assert.ok(after.fc.title && after.fc.phones, 'every changed field has an edit clock');
  assert.strictEqual(after.created_at, stored.created_at);
  assert.strictEqual(NotesStore.updateContact(noteId, { title: 'x' }), null, 'a note is not a contact');
  assert.strictEqual(NotesStore.get(noteId).content.type, 'note');

  // --- search: names, organisation, phone, email, accents, AND, operators ---------------
  const names = (q, o) => NotesStore.searchContacts(q, o).map((c) => C.displayName(c));
  assert.deepStrictEqual(names('bakker'), ['Eva Bakker'], 'name');
  assert.deepStrictEqual(names('bouw b.v.'), ['Eva Bakker'], 'organisation');
  assert.deepStrictEqual(names('inkoop'), ['Eva Bakker'], 'organisation unit');
  assert.deepStrictEqual(names('eva@bakkerbouw'), ['Eva Bakker'], 'email');
  assert.deepStrictEqual(names('612 345'), ['Eva Bakker'], 'phone matched on digits');
  assert.deepStrictEqual(names('020555'), ['José Müller'], 'phone with spaces');
  assert.deepStrictEqual(names('jose muller'), ['José Müller'], 'accent-insensitive');
  assert.deepStrictEqual(names('müller jose'), ['José Müller'], 'any word order');
  assert.deepStrictEqual(names('eva zed'), [], 'every word must match');
  assert.deepStrictEqual(names('keizersgracht'), ['Eva Bakker'], 'address');
  assert.deepStrictEqual(names(''), ['Eva Bakker', 'José Müller', 'Zed Taxi']);

  // --- groups and favourites ----------------------------------------------------------------
  assert.deepStrictEqual(names('label:bouw'), ['Eva Bakker', 'Zed Taxi']);
  assert.deepStrictEqual(names('', { label: 'WERK' }), ['Eva Bakker']);
  assert.deepStrictEqual(names('is:favorite'), ['José Müller']);
  assert.deepStrictEqual(names('', { favouritesOnly: true }), ['José Müller']);
  assert.deepStrictEqual(NotesStore.listContactLabels(), [{ name: 'Bouw', count: 2 }, { name: 'Werk', count: 1 }]);
  NotesStore.updateContact(zed.uuid, { favorite: true });
  assert.deepStrictEqual(names('is:favorite'), ['José Müller', 'Zed Taxi']);
  NotesStore.updateContact(zed.uuid, { favorite: false });
  assert.deepStrictEqual(names('is:favorite'), ['José Müller']);
  assert.strictEqual(NotesStore.renameContactLabel('bouw', 'Bouwers'), 2);
  assert.deepStrictEqual(NotesStore.get(zed.uuid).content.labels, ['Bouwers']);
  assert.deepStrictEqual(NotesStore.get(eva.uuid).content.labels, ['Werk', 'Bouwers']);
  assert.strictEqual(NotesStore.renameContactLabel('Bouwers', ''), 2, 'empty name removes the group');
  assert.deepStrictEqual(NotesStore.get(eva.uuid).content.labels, ['Werk']);

  // --- unknown imported fields: kept, round trip, hostile keys dropped ---------------------
  const hostile = { source: { format: 'vcard', version: '3.0' }, vcard: [{ g: 'item5', n: 'X-ABRELATEDNAMES', p: {}, v: 'Marie Visser' }], csv: { Hobby: 'sailing' }, constructor: 'x' };
  Object.defineProperty(hostile, '__proto__', { value: { polluted: true }, enumerable: true });
  const imported = NotesStore.addContact({ name: { given: 'Jan' }, extra: hostile });
  NotesStore.updateContact(imported.uuid, { nickname: 'J' });
  const ex = NotesStore.get(imported.uuid).content.extra;
  assert.strictEqual(ex.vcard[0].v, 'Marie Visser');
  assert.strictEqual(ex.vcard[0].g, 'item5');
  assert.strictEqual(ex.csv.Hobby, 'sailing');
  assert.strictEqual(ex.source.version, '3.0');
  assert.ok(!Object.prototype.hasOwnProperty.call(ex, 'constructor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ex, '__proto__'));
  assert.strictEqual({}.polluted, undefined);
  assert.deepStrictEqual(names('marie visser'), ['Jan'], 'related names in extra are searchable');
  assert.deepStrictEqual(names('sailing'), [], 'other unknown fields are not searched');

  // --- caps -----------------------------------------------------------------------------------------
  const big = C.buildContact({
    phones: Array.from({ length: 51 }, (_, i) => ({ value: `0${i}00000` })),
    note: 'n'.repeat(25000),
    labels: Array.from({ length: 21 }, (_, i) => `g${i}`),
    dates: [{ type: 'birthday', value: '1984-13-40' }, { type: 'birthday', value: '1984-03-09' }, { type: 'birthday', value: '--0309' }],
  });
  assert.strictEqual(big.content.phones.length, 50);
  assert.strictEqual(big.dropped.phones, 1);
  assert.strictEqual(big.content.note.length, 20000);
  assert.strictEqual(big.content.labels.length, 20);
  assert.deepStrictEqual(big.content.dates.map((d) => [d.type, d.value]), [['birthday', '1984-03-09'], ['other', '--03-09']]);
  assert.strictEqual(big.dropped.dates, 1);
  const fat = (key, value) => Array.from({ length: 50 }, () => ({ [key]: String(value).repeat(500) }));
  assert.throws(() => C.buildContact({
    urls: fat('value', 'u'), emails: fat('value', 'e'), phones: fat('value', 'p'), ims: fat('value', 'i'),
    addresses: Array.from({ length: 50 }, () => ({ street: 's'.repeat(500), city: 'c'.repeat(500), region: 'r'.repeat(500), postal: 'p'.repeat(500), country: 'k'.repeat(500) })),
  }), /too large/, 'a contact over 128 KiB is refused');

  // --- photo: JPEG up to 12 KiB is kept, bigger or non-JPEG is dropped ----------------------------------
  const okPhoto = NotesStore.addContact({ name: { given: 'Pic' }, photo: { mime: 'image/jpeg', data: jpegB64(12288), w: 192, h: 192 } });
  assert.ok(NotesStore.get(okPhoto.uuid).content.photo);
  assert.strictEqual(okPhoto.dropped.photo, undefined);
  const tooBig = NotesStore.addContact({ name: { given: 'Big' }, photo: { mime: 'image/jpeg', data: jpegB64(12289), w: 192, h: 192 } });
  assert.strictEqual(NotesStore.get(tooBig.uuid).content.photo, null);
  assert.strictEqual(tooBig.dropped.photo, 1);
  const png = NotesStore.addContact({ name: { given: 'Png' }, photo: { mime: 'image/png', data: jpegB64(100), w: 10, h: 10 } });
  assert.strictEqual(NotesStore.get(png.uuid).content.photo, null);
  const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0, 0, 0x07, 0xd0, 0, 0]);
  assert.deepStrictEqual(C.imageSize(pngHeader), { w: 3000, h: 2000 });

  // The square crop: centred by default, zoom shrinks it, and it never leaves the image.
  assert.deepStrictEqual(C.cropSquare(3000, 2000), { sx: 500, sy: 0, side: 2000 });
  assert.deepStrictEqual(C.cropSquare(3000, 2000, { cx: 0.5, cy: 0.5, zoom: 2 }), { sx: 1000, sy: 500, side: 1000 });
  assert.deepStrictEqual(C.cropSquare(3000, 2000, { cx: 0, cy: 1, zoom: 4 }), { sx: 0, sy: 1500, side: 500 });
  assert.deepStrictEqual(C.cropSquare(3000, 2000, { cx: 9, cy: -9, zoom: 0.1 }), { sx: 1000, sy: 0, side: 2000 });

  // --- push: nothing readable leaves the device ---------------------------------------------------
  const secret = NotesStore.addContact({
    name: { given: 'Wilhelmina', family: 'Zonnebloem' },
    org: { name: 'Zonnebloem Holding' },
    phones: [{ type: 'mobile', value: '+31 6 98765432' }],
    emails: [{ type: 'home', value: 'wilhelmina@zonnebloem.example' }],
    addresses: [{ type: 'home', street: 'Geheimlaan 7', city: 'Zwolle', postal: '8011 AA' }],
    note: 'verjaardag moeder',
    photo: { mime: 'image/jpeg', data: jpegB64(300), w: 192, h: 192 },
  });
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  const row = pushedRows().find((r) => r.item_uuid === secret.uuid);
  assert.ok(row, 'contact row is pushed');
  const wire = JSON.stringify(row);
  for (const needle of ['Wilhelmina', 'Zonnebloem', '98765432', 'wilhelmina@', 'Geheimlaan', 'Zwolle', '8011', 'verjaardag', jpegB64(300).slice(0, 40), '"contact"', 'favorite', 'phones']) {
    assert.ok(!wire.includes(needle), `"${needle}" must not appear outside the ciphertext`);
  }
  assert.deepStrictEqual(Object.keys(row).sort(), Object.keys(pushedRows().find((r) => r.item_uuid === noteId)).sort(), 'same row shape as a note');
  const plain = await h.decryptRow(row);
  assert.strictEqual(plain.type, 'contact');
  assert.strictEqual(plain.name.family, 'Zonnebloem');

  // --- delete --------------------------------------------------------------------------------------------
  assert.strictEqual(NotesStore.removeContact(noteId), false, 'removeContact ignores notes');
  assert.strictEqual(NotesStore.removeContact(secret.uuid), true);
  assert.strictEqual(NotesStore.removeContact(secret.uuid), false, 'twice is harmless');
  assert.ok(!NotesStore.listContacts().some((c) => c.uuid === secret.uuid));
  assert.strictEqual(NotesStore.updateContact(secret.uuid, { title: 'x' }), null, 'a deleted contact cannot be edited');
  h.resetServer();
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(pushedRows().some((r) => r.item_uuid === secret.uuid && r.deleted), 'tombstone is pushed');

  // --- backup: rows restore into an empty vault field by field ------------------------------------------
  await NotesStore.flush();
  const before = NotesStore.listContacts();
  const rows = [];
  for (const item of NotesStore.state.items.values()) {
    if (item.deleted) continue;
    const s = h.idb.get(item.uuid);
    rows.push({ item_uuid: item.uuid, content_version: 1, ciphertext: s.ciphertext, content_hash: s.content_hash, deleted: false, updated_at: item.updated_at });
  }
  NotesStore.state.items.clear();
  NotesStore.state.dirty.clear();
  h.idb.clear();
  assert.strictEqual(NotesStore.listContacts().length, 0);
  await NotesStore.importBackup({ format: 'deeperguard-backup-v1', items: JSON.parse(JSON.stringify(rows)) }, true);
  const noVersion = (list) => list.map(({ __fv, ...rest }) => rest);
  assert.deepStrictEqual(noVersion(NotesStore.listContacts()), noVersion(before), 'contacts restore field by field');
  assert.strictEqual(NotesStore.listNotes().length, 1);

  // --- lock removes decrypted contacts from memory ----------------------------------------------------------
  assert.ok(NotesStore.listContacts().length >= 4);
  NotesStore.lock();
  assert.deepStrictEqual(NotesStore.listContacts(), []);
  assert.deepStrictEqual(NotesStore.searchContacts('eva'), []);
  assert.strictEqual(NotesStore.state.items.size, 0);
  assert.throws(() => NotesStore.addContact({ name: { given: 'X' } }), /Unlock the vault first/);
  for (const store of [localStorage.store, sessionStorage.store]) {
    assert.ok(!JSON.stringify(store).includes('Bakker'), 'no plaintext in web storage');
  }

  // --- conflict: two devices edit different fields; then the same field -------------------------------------------
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();
  const T = Date.now() - 60000;
  const baseBuilt = C.buildContact({
    name: { given: 'Eva', family: 'Bakker' },
    phones: [{ id: 'PHONE001', type: 'mobile', value: '0611111111' }],
    addresses: [{ id: 'ADDR0001', type: 'home', street: 'Oude straat 1' }],
    note: 'oorspronkelijk',
  }, null, iso(T)).content;
  const ID = NotesStore.newUuid();
  const baseRow = await h.encryptedRow(ID, baseBuilt, 100, 1001, { rev: 3 });
  h.server.pullPages = [{ items: [baseRow], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(NotesStore.listContacts().length, 1);

  // Other device (rev 4): new address and a different note.
  const otherDevice = C.buildContact({
    addresses: [{ id: 'ADDR0001', type: 'home', street: 'Nieuwe laan 9' }],
    note: 'van de laptop',
  }, baseBuilt, iso(T + 40000)).content;
  const otherRow = await h.encryptedRow(ID, otherDevice, 300, 1003, { rev: 4 });

  // This device edits the phone number and the note (also from the base state).
  h.resetServer();
  let pushes = 0;
  h.server.pushResponder = (items) => items.map((r) => {
    if (r.item_uuid !== ID) return { item_uuid: r.item_uuid, status: 'ok', rev: 1 };
    pushes += 1;
    if (r.base_rev === 3) return { item_uuid: ID, status: 'conflict', rev: 4, server_item: otherRow };
    assert.strictEqual(r.base_rev, 4);
    return { item_uuid: ID, status: 'ok', rev: 5 };
  });
  NotesStore.updateContact(ID, { phones: [{ id: 'PHONE001', type: 'mobile', value: '0622222222' }], note: 'van de telefoon' });
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(pushes >= 2, 'one conflict, then a re-push');
  const merged = NotesStore.get(ID).content;
  assert.strictEqual(merged.phones[0].value, '0622222222', 'this device\'s phone edit survives');
  assert.strictEqual(merged.addresses[0].street, 'Nieuwe laan 9', 'the other device\'s address edit survives');
  const contacts = NotesStore.listContacts();
  assert.strictEqual(contacts.length, 2, 'the note was changed on both devices: one conflict copy');
  const copy = contacts.find((c) => c.uuid !== ID);
  assert.strictEqual(copy.conflict_of, ID);
  assert.match(C.displayName(copy), /\(conflict copy\)$/);
  assert.deepStrictEqual([merged.note, copy.note].sort(), ['van de laptop', 'van de telefoon'], 'neither note text is lost');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // Pure merge: different fields on each side need no copy; identical contents change nothing.
  const left = C.buildContact({ name: { given: 'A' }, phones: [{ value: '1' }] }, null, iso(T)).content;
  const lEdit = C.buildContact({ title: 'T1' }, left, iso(T + 1000)).content;
  const rEdit = C.buildContact({ note: 'N1' }, left, iso(T + 2000)).content;
  const both = C.mergeContacts(lEdit, rEdit);
  assert.strictEqual(both.copy, null);
  assert.strictEqual(both.content.title, 'T1');
  assert.strictEqual(both.content.note, 'N1');
  const added = C.mergeContacts(
    C.buildContact({ phones: [...left.phones, { value: '2' }] }, left, iso(T + 1000)).content,
    C.buildContact({ phones: [...left.phones, { value: '3' }] }, left, iso(T + 2000)).content,
  );
  assert.deepStrictEqual(added.content.phones.map((p) => p.value).sort(), ['1', '2', '3'], 'list additions on both sides are kept');
  assert.strictEqual(C.mergeContacts(left, left).copy, null);

  console.log('test_contacts.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
