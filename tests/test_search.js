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
assert.deepStrictEqual(titlesOnlyFile.map((n) => n.uuid), ['scan']);
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

console.log('ok');
