const assert = require('assert');
const {
  derivedTitleFromBody,
  effectiveNoteTitle,
  noteIsEmptyStub,
  filterNotes,
  findMatches,
  describeMatch,
  sameNoteContent,
  highlightPlain,
  replaceAll,
  countActiveSearchFilters,
  defaultSearchOptions,
  noteIsProtected,
  indexNote,
  buildSearchBlob,
  clearMemoryIndex,
  memoryIndexActive,
  listCountLabel,
  documentHighlightLabel,
  noteBodyReading,
  readingStats,
  fileRowMatches,
  noteIsPinned,
  partitionPinnedNotes,
  compareNotesForSort,
} = require('../app/static/js/search.js');

function note(overrides) {
  return {
    uuid: overrides.uuid || 'n',
    content: {
      type: 'note',
      title: 'Untitled',
      content: '',
      tags: [],
      pinned: false,
      starred: false,
      archived: false,
      trashed: false,
      locked: false,
      prevent_edit: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

const work = note({ uuid: 'work', title: 'Work project', content: 'body hidden', tags: ['tag-work'], updated_at: '2026-02-01T00:00:00.000Z' });
const loose = note({ uuid: 'loose', title: 'Loose', tags: [], updated_at: '2026-03-01T00:00:00.000Z' });
const archived = note({ uuid: 'arch', title: 'Old', archived: true, tags: [] });
const protectedNote = note({ uuid: 'prot', title: 'Secret', content: 'secret body', prevent_edit: true });
const tagMap = new Map([
  ['tag-work', { content: { title: 'Work' } }],
  ['tag-ideas', { content: { title: 'Ideas' } }],
]);

const all = filterNotes([work, loose, archived], { filter: 'all', tagMap });
assert.deepStrictEqual(all.map((n) => n.uuid), ['loose', 'work']);

const untagged = filterNotes([work, loose, archived], { filter: 'untagged', tagMap });
assert.deepStrictEqual(untagged.map((n) => n.uuid), ['loose']);

const tagged = filterNotes([work, loose], { filter: 'all', tagId: 'tag-work', tagMap });
assert.deepStrictEqual(tagged.map((n) => n.uuid), ['work']);

const search = filterNotes([work, loose], { filter: 'all', query: 'work', tagMap });
assert.deepStrictEqual(search.map((n) => n.uuid), ['work']);

const titlesOnly = filterNotes([work, loose], {
  filter: 'all',
  query: 'body',
  tagMap,
  searchOptions: { titlesOnly: true },
});
assert.deepStrictEqual(titlesOnly.map((n) => n.uuid), []);

const titlesOnlyHit = filterNotes([work, loose], {
  filter: 'all',
  query: 'project',
  tagMap,
  searchOptions: { titlesOnly: true },
});
assert.deepStrictEqual(titlesOnlyHit.map((n) => n.uuid), ['work']);

const includeArchived = filterNotes([work, loose, archived], {
  filter: 'all',
  query: 'old',
  tagMap,
  searchOptions: { includeArchived: true },
});
assert.deepStrictEqual(includeArchived.map((n) => n.uuid), ['arch']);

const tagFilterOnly = filterNotes([work, loose], {
  filter: 'all',
  tagMap,
  searchOptions: { tagIds: ['tag-work'] },
});
assert.deepStrictEqual(tagFilterOnly.map((n) => n.uuid), ['work']);

const tagFilterOr = filterNotes([
  note({ uuid: 'a', tags: ['tag-work'] }),
  note({ uuid: 'b', tags: ['tag-ideas'] }),
  note({ uuid: 'c', tags: [] }),
], {
  filter: 'all',
  tagMap,
  searchOptions: { tagIds: ['tag-work', 'tag-ideas'] },
});
assert.deepStrictEqual(tagFilterOr.map((n) => n.uuid).sort(), ['a', 'b']);

const hideProtected = filterNotes([work, protectedNote], {
  filter: 'all',
  query: 'secret body',
  tagMap,
  searchOptions: defaultSearchOptions({}),
});
assert.deepStrictEqual(hideProtected.map((n) => n.uuid), []);

const protectedByTitle = filterNotes([work, protectedNote], {
  filter: 'all',
  query: 'secret',
  tagMap,
  searchOptions: defaultSearchOptions({}),
});
assert.deepStrictEqual(protectedByTitle.map((n) => n.uuid), ['prot']);

const readOnlyByFile = filterNotes([
  note({
    uuid: 'ro-file',
    title: 'Docs',
    prevent_edit: true,
    attachment_names: 'NonKYC-api-key.pdf',
    attachments: ['a1'],
  }),
], {
  filter: 'all',
  query: 'nonkyc',
  tagMap,
});
assert.deepStrictEqual(readOnlyByFile.map((n) => n.uuid), ['ro-file']);

const showProtected = filterNotes([work, protectedNote], {
  filter: 'all',
  query: 'secret body',
  tagMap,
  searchOptions: { includeProtected: true },
});
assert.deepStrictEqual(showProtected.map((n) => n.uuid), ['prot']);

const scanned = note({
  uuid: 'scan',
  title: 'Untitled',
  content: '',
  ocr_text: 'Vehicle registration expires June',
  attachment_names: 'reg-card.jpg',
  attachments: ['att-reg'],
});
const ocrOnly = note({
  uuid: 'ocr-note',
  title: 'Contract text',
  content: 'Rental Agreement',
  ocr_text: 'Rental Agreement Casa Es Vedra',
});
const ocrHits = filterNotes([scanned, loose], { filter: 'all', query: 'registration', tagMap });
assert.deepStrictEqual(ocrHits.map((n) => n.uuid), ['scan']);

const titlesOnlyFile = filterNotes([scanned, loose], {
  filter: 'all',
  query: 'reg-card',
  tagMap,
  searchOptions: { titlesOnly: true },
});
assert.deepStrictEqual(titlesOnlyFile.map((n) => n.uuid), []);
const filenameHit = filterNotes([scanned, loose], {
  filter: 'all',
  query: 'reg-card',
  tagMap,
});
assert.deepStrictEqual(filenameHit.map((n) => n.uuid), ['scan']);
const info = describeMatch(scanned, 'registration', tagMap);
assert.strictEqual(info.field, 'ocr');
assert.match(info.snippet, /Vehicle registration/);

const staleIndexed = note({
  uuid: 'stale-index',
  title: 'Insurance scan',
  content: '',
  ocr_text: '',
});
indexNote(staleIndexed, tagMap);
staleIndexed.content.ocr_text = 'Policy number ZX-4419 renewal';
const staleHits = filterNotes([staleIndexed], { filter: 'all', query: 'ZX-4419', tagMap });
assert.deepStrictEqual(staleHits.map((n) => n.uuid), ['stale-index']);
const staleInfo = describeMatch(staleIndexed, 'ZX-4419', tagMap);
assert.strictEqual(staleInfo.field, 'ocr');

const docs = filterNotes([scanned, ocrOnly, loose], { filter: 'documents', tagMap });
assert.deepStrictEqual(docs.map((n) => n.uuid), ['scan']);

const hits = findMatches('Hello hello HELLO', 'hello');
assert.strictEqual(hits.length, 3);
assert.deepStrictEqual(hits[1], { start: 6, end: 11 });
assert.deepStrictEqual(findMatches('abc', ''), []);

const caseHits = findMatches('Hello hello', 'hello', { caseSensitive: true });
assert.strictEqual(caseHits.length, 1);
assert.deepStrictEqual(caseHits[0], { start: 6, end: 11 });

assert.strictEqual(replaceAll('foo bar foo', 'foo', 'baz'), 'baz bar baz');
assert.strictEqual(replaceAll('Foo foo', 'foo', 'x', { caseSensitive: true }), 'Foo x');

assert.strictEqual(countActiveSearchFilters(defaultSearchOptions({
  titlesOnly: true,
  includeArchived: true,
  tagIds: ['a', 'b'],
})), 4);

assert.strictEqual(sameNoteContent(
  { title: '', content: 'Hi', editor: 'plain', prevent_edit: false, locked: false },
  { title: 'Untitled', content: 'Hi', editor: 'plain', prevent_edit: false, locked: false },
), true);
assert.strictEqual(sameNoteContent(
  { title: 'Hi', content: 'Hi', editor: 'plain', locked: false },
  { title: 'Hi', content: 'Hi', editor: 'plain', locked: true },
), false);
assert.strictEqual(sameNoteContent(
  { title: 'Hi', content: 'old', editor: 'plain' },
  { title: 'Hi', content: 'new', editor: 'plain' },
), false);

const highlighted = highlightPlain('Hello hello', 'hello');
assert.match(highlighted, /<mark class="search-hit">Hello<\/mark>/);
assert.match(highlighted, /<mark class="search-hit">hello<\/mark>/);

assert.strictEqual(noteIsProtected({ locked: true }), true);
assert.strictEqual(noteIsProtected({ prevent_edit: true }), true);
assert.strictEqual(noteIsProtected({ locked: false, prevent_edit: false }), false);
assert.strictEqual(noteIsProtected({}), false);
assert.strictEqual(noteIsProtected(null), false);

const lockedSecret = note({
  uuid: 'locked-secret',
  title: 'Safe title',
  content: 'hunter2 password body',
  ocr_text: 'scanned secret 4419',
  attachment_names: 'passport.pdf',
  locked: true,
  tags: ['tag-work'],
});
assert.ok(!buildSearchBlob(lockedSecret, tagMap).includes('hunter2'));
assert.ok(!buildSearchBlob(lockedSecret, tagMap).includes('4419'));
assert.ok(!buildSearchBlob(lockedSecret, tagMap).includes('passport'));
assert.ok(buildSearchBlob(lockedSecret, tagMap).includes('safe title'));
assert.strictEqual(describeMatch(lockedSecret, 'hunter2', tagMap), null);
assert.strictEqual(describeMatch(lockedSecret, '4419', tagMap), null);
assert.strictEqual(describeMatch(lockedSecret, 'safe title', tagMap).field, 'title');
indexNote(lockedSecret, tagMap);
const lockedBodyHits = filterNotes([lockedSecret], {
  filter: 'all',
  query: 'hunter2',
  tagMap,
  searchOptions: { includeProtected: true },
});
assert.deepStrictEqual(lockedBodyHits.map((n) => n.uuid), []);
const lockedTitleHits = filterNotes([lockedSecret], {
  filter: 'all',
  query: 'safe title',
  tagMap,
  searchOptions: { includeProtected: true },
});
assert.deepStrictEqual(lockedTitleHits.map((n) => n.uuid), ['locked-secret']);

const laterLocked = note({
  uuid: 'later-locked',
  title: 'Visible',
  content: 'hidden-body-token',
  locked: false,
});
indexNote(laterLocked, tagMap);
laterLocked.content.locked = true;
assert.deepStrictEqual(filterNotes([laterLocked], {
  filter: 'all',
  query: 'hidden-body-token',
  tagMap,
  searchOptions: { includeProtected: true },
}).map((n) => n.uuid), []);

const editedOld = note({
  uuid: 'edited-old',
  created_at: '2020-01-01T00:00:00.000Z',
  updated_at: '2026-06-01T12:00:00.000Z',
});
const createdNew = note({
  uuid: 'created-new',
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-16T00:00:00.000Z',
});
const byUpdated = filterNotes([editedOld, createdNew], { filter: 'all', tagMap, sort: 'updated' });
assert.deepStrictEqual(byUpdated.map((n) => n.uuid), ['edited-old', 'created-new']);
const byCreated = filterNotes([editedOld, createdNew], { filter: 'all', tagMap, sort: 'created' });
assert.deepStrictEqual(byCreated.map((n) => n.uuid), ['created-new', 'edited-old']);

const olderPinned = note({
  uuid: 'older-pinned',
  title: 'Zebra pinned',
  pinned: true,
  created_at: '2019-01-01T00:00:00.000Z',
  updated_at: '2019-01-02T00:00:00.000Z',
});
const newerStarred = note({
  uuid: 'newer-starred',
  title: 'Alpha starred',
  starred: true,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
});
assert.strictEqual(noteIsPinned(olderPinned), true);
assert.strictEqual(noteIsPinned(newerStarred), true);
assert.strictEqual(noteIsPinned(loose), false);

const pinnedFirstUpdated = filterNotes(
  [loose, olderPinned, newerStarred, editedOld],
  { filter: 'all', tagMap, sort: 'updated' },
);
assert.deepStrictEqual(pinnedFirstUpdated.map((n) => n.uuid), [
  'newer-starred',
  'older-pinned',
  'edited-old',
  'loose',
]);

const pinnedFirstCreated = filterNotes(
  [loose, olderPinned, newerStarred, createdNew],
  { filter: 'all', tagMap, sort: 'created' },
);
assert.deepStrictEqual(pinnedFirstCreated.map((n) => n.uuid), [
  'newer-starred',
  'older-pinned',
  'created-new',
  'loose',
]);

const pinnedFirstTitle = filterNotes(
  [loose, olderPinned, newerStarred],
  { filter: 'all', tagMap, sort: 'title' },
);
assert.deepStrictEqual(pinnedFirstTitle.map((n) => n.uuid), [
  'newer-starred',
  'older-pinned',
  'loose',
]);
assert.ok(compareNotesForSort(olderPinned, loose, 'updated') < 0);

const split = partitionPinnedNotes([loose, olderPinned, newerStarred, editedOld]);
assert.deepStrictEqual(split.pinned.map((n) => n.uuid).sort(), ['newer-starred', 'older-pinned']);
assert.deepStrictEqual(split.rest.map((n) => n.uuid).sort(), ['edited-old', 'loose']);

const taggedPinned = filterNotes(
  [
    note({ uuid: 'tag-pin', title: 'Pinned tagged', pinned: true, tags: ['tag-work'], updated_at: '2018-01-01T00:00:00.000Z' }),
    note({ uuid: 'tag-new', title: 'Fresh tagged', tags: ['tag-work'], updated_at: '2026-08-01T00:00:00.000Z' }),
  ],
  { filter: 'all', tagId: 'tag-work', tagMap, sort: 'updated' },
);
assert.deepStrictEqual(taggedPinned.map((n) => n.uuid), ['tag-pin', 'tag-new']);

assert.strictEqual(derivedTitleFromBody('  Hello   from Dennis — first note.\nsecond'), 'Hello from Dennis — first note.');
assert.strictEqual(derivedTitleFromBody(`  ${'a'.repeat(80)}`), `${'a'.repeat(59)}…`);
assert.strictEqual(effectiveNoteTitle(note({ title: 'Untitled', content: 'Hello from Dennis — first note.' })), 'Hello from Dennis — first note.');
assert.strictEqual(effectiveNoteTitle(note({ title: 'Kept', title_manual: true, content: 'Other first line' })), 'Kept');
assert.strictEqual(effectiveNoteTitle(note({ title: '', content: '   \n  Second line wins' })), 'Second line wins');
assert.strictEqual(
  effectiveNoteTitle(note({
    title: '{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[["Budget","2024"]]}]}',
    content: '',
  })),
  'Sheet1: Budget',
);
assert.strictEqual(
  effectiveNoteTitle(note({ title: 'Title', content: '{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[["A"]]}]}' })),
  'Sheet1: A',
);
assert.match(
  effectiveNoteTitle(note({ title: '{"activeSheet":"Sheet1","sheets":[', content: '' })),
  /^Spreadsheet · /,
);
assert.strictEqual(noteIsEmptyStub(note({ title: '', content: '' })), true);
assert.strictEqual(noteIsEmptyStub(note({ title: 'Title', content: '' })), true);
assert.strictEqual(noteIsEmptyStub(note({ title: 'Hello', content: '' })), false);

const highlightedList = highlightPlain('To do list', 'To do');
assert.match(highlightedList, /class="search-hit"/);
assert.doesNotMatch(highlightedList, /text-decoration/);

assert.strictEqual(
  effectiveNoteTitle(note({
    title: '',
    content: '{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[{"index":0,"cells":[{"value":"Date","index":0},{"value":"KLM","index":1}]}]}]}',
  })),
  'Sheet1: Date',
);

const heavyNotes = [];
const bigJson = `{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[${Array.from({ length: 40 }, (_, i) => `{"index":${i},"cells":[{"value":"KLM row ${i}","index":0}]}`).join(',')}]}]}`;
for (let i = 0; i < 120; i += 1) {
  heavyNotes.push(note({
    uuid: `h-${i}`,
    title: i % 3 === 0 ? bigJson : `Werkgeversverklaring ${i}`,
    content: i % 2 === 0 ? bigJson : `body mentions KLM ${i}`,
    tags: i % 5 === 0 ? ['tag-klm'] : [],
  }));
}
assert.doesNotThrow(() => {
  const hits = filterNotes(heavyNotes, {
    query: 'KLM',
    filter: 'all',
    tagMap,
    sort: 'updated',
    searchOptions: defaultSearchOptions(),
  });
  assert.ok(hits.length > 0);
});

const invoice136 = note({ uuid: 'inv-136', title: 'Invoice 136', content: 'amount due' });
const invoice1360 = note({ uuid: 'inv-1360', title: 'Invoice 1360', content: 'other amount' });
const glued136 = note({ uuid: 'glued-136', title: 'x136y', content: 'code x136y' });
const body136 = note({ uuid: 'body-136', title: 'Memo', content: 'Reference 136 on the invoice' });
const numberHits = filterNotes([invoice136, invoice1360, glued136, body136, loose], {
  filter: 'all',
  query: '136',
  tagMap,
});
assert.deepStrictEqual(numberHits.map((n) => n.uuid).sort(), ['body-136', 'inv-136']);
const longerNumber = filterNotes([invoice136, invoice1360], {
  filter: 'all',
  query: '1360',
  tagMap,
});
assert.deepStrictEqual(longerNumber.map((n) => n.uuid), ['inv-1360']);
const wordSubstring = filterNotes([
  work,
  note({ uuid: 'workshop', title: 'Workshop notes', content: 'agenda' }),
  loose,
], { filter: 'all', query: 'work', tagMap });
assert.ok(wordSubstring.some((n) => n.uuid === 'workshop'));
assert.ok(wordSubstring.some((n) => n.uuid === 'work'));
const exactInfo = describeMatch(body136, '136', tagMap);
assert.strictEqual(exactInfo.field, 'body');
assert.match(exactInfo.snippet, /\b136\b/);
assert.strictEqual(describeMatch(invoice1360, '136', tagMap), null);

const ghost = note({
  uuid: 'ghost-136',
  title: 'Unrelated',
  content: 'no digits here',
  ocr_text: 'copied invoice 136',
});
indexNote(ghost, tagMap);
ghost.content.ocr_text = '';
ghost.content.content = 'no digits here';
assert.strictEqual(memoryIndexActive(), true);
const ghostHits = filterNotes([ghost], { filter: 'all', query: '136', tagMap });
assert.deepStrictEqual(ghostHits.map((n) => n.uuid), []);
assert.strictEqual(describeMatch(ghost, '136', tagMap), null);

assert.strictEqual(listCountLabel(12), '12 notes');
assert.strictEqual(listCountLabel(1), '1 note');
assert.strictEqual(listCountLabel(3, { files: true }), '3 files');
assert.strictEqual(listCountLabel(1, { files: true }), '1 file');
assert.strictEqual(documentHighlightLabel(12), '12 highlights in this PDF');
assert.strictEqual(documentHighlightLabel(1, { page: 1, pages: 4 }), '1 highlight in this PDF, page 1 of 4');
assert.notStrictEqual(listCountLabel(12), documentHighlightLabel(12));
assert.doesNotMatch(listCountLabel(12), /highlight/);
assert.doesNotMatch(documentHighlightLabel(12), /notes/);

const emptyBody = note({
  uuid: 'empty-body',
  title: 'Invoice scan',
  content: '',
  ocr_text: 'invoice word '.repeat(40),
});
assert.deepStrictEqual(noteBodyReading(emptyBody), { words: 0, minutes: 0 });
assert.deepStrictEqual(noteBodyReading(note({ content: 'one two three' })), { words: 3, minutes: 0 });
assert.deepStrictEqual(
  readingStats('alpha bravo charlie delta echo foxtrot'),
  { words: 6, minutes: 0 },
);
assert.deepStrictEqual(
  readingStats('alpha bravo charlie delta echo foxtrot golf hotel'),
  { words: 8, minutes: 0 },
  'eight words stay eight — the counter must not stop at three',
);
assert.deepStrictEqual(
  readingStats(Array.from({ length: 220 }, () => 'word').join(' ')),
  { words: 220, minutes: 1 },
);

assert.strictEqual(fileRowMatches(
  { content: { filename: 'other.pdf', mime: 'application/pdf', ocr_text: '' } },
  note({ title: 'Parent', content: '', ocr_text: 'total 136 due' }),
  '136',
), false);
assert.strictEqual(fileRowMatches(
  { content: { filename: 'invoice.pdf', mime: 'application/pdf', ocr_text: 'total 136 due' } },
  note({ title: 'Parent', content: '' }),
  '136',
), true);
assert.strictEqual(fileRowMatches(
  { content: { filename: '1360-report.pdf', mime: 'application/pdf', ocr_text: '' } },
  note({ title: 'Parent', content: '' }),
  '136',
), false);
assert.strictEqual(fileRowMatches(
  { content: { filename: 'reg-card.jpg', mime: 'image/jpeg', ocr_text: 'scan' } },
  note({ title: 'Vehicle', content: '' }),
  'reg-card',
  { titlesOnly: true },
), false);
assert.strictEqual(fileRowMatches(
  { content: { filename: 'reg-card.jpg', ocr_text: '' } },
  note({ title: 'Vehicle card', content: '' }),
  'vehicle',
  { titlesOnly: true },
), true);

indexNote(invoice136, tagMap);
assert.strictEqual(memoryIndexActive(), true);
clearMemoryIndex();
assert.strictEqual(memoryIndexActive(), false);

const folderMap = new Map([
  ['folder-travel', { content: { title: 'Travelbox' } }],
]);
const tripA = note({ uuid: 'trip-a', title: 'Passport', content: 'Scan', folder_id: 'folder-travel' });
const tripB = note({ uuid: 'trip-b', title: 'Hotel', content: 'Booking', folder_id: 'folder-travel' });
const stayHome = note({ uuid: 'home', title: 'Groceries', content: 'Milk' });
const folderHits = filterNotes([tripA, tripB, stayHome], {
  filter: 'all',
  query: 'travelbox',
  tagMap,
  folderMap,
});
assert.deepStrictEqual(folderHits.map((n) => n.uuid).sort(), ['trip-a', 'trip-b']);
assert.strictEqual(describeMatch(tripA, 'travelbox', tagMap, { folderMap }).field, 'folder');
assert.strictEqual(describeMatch(tripA, 'travelbox', tagMap, { folderMap }).label, 'Folder');
assert.deepStrictEqual(filterNotes([tripA, tripB], {
  filter: 'all',
  query: 'travelbox',
  tagMap,
}).map((n) => n.uuid), []);

console.log('ok');
