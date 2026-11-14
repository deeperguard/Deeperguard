/**
 * Regression: after "[[Bo" + picking "Boodschappen" in a new note, the title
 * (editor field and note list) must read "Boodschappen", not the raw
 * "[Boodschappen](dg-note:<id>)". The body keeps the working link. Titles that
 * were stored raw by the old derivation are re-derived, never locked.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NotesSearch = require('../app/static/js/search.js');
const L = require('../app/static/js/notelinks.js');
const { render } = require('../app/static/js/markdown.js');

const { derivedTitleFromBody, legacyDerivedTitleFromBody, titleIsDerivedFromBody, effectiveNoteTitle } = NotesSearch;

// Load the real titleLockedByUser from app.js so the save path is exercised.
const appSrc = fs.readFileSync(path.join(__dirname, '../app/static/js/app.js'), 'utf8');
const fnMatch = appSrc.match(/function titleLockedByUser\(note\) \{[\s\S]*?\n  \}/);
assert.ok(fnMatch, 'titleLockedByUser found in app.js');
// eslint-disable-next-line no-new-func
const titleLockedByUser = new Function('NotesSearch', `${fnMatch[0]}; return titleLockedByUser;`)(NotesSearch);

// Mirrors the title part of flushSave in app.js.
function savedTitle(note, editorTitle, body) {
  const manual = titleLockedByUser(note);
  return manual ? String(editorTitle || '').trim() : (derivedTitleFromBody(body) || '');
}

const ID = '50b3e132-1111-4111-8111-111111111111';
const link = L.buildLink(ID, 'Boodschappen');
assert.strictEqual(link, `[Boodschappen](dg-note:${ID})`);

// 1. New note, body becomes the inserted link: title is the readable label.
const fresh = { uuid: 'n1', content: { type: 'note', title: '', title_manual: false, content: '' } };
assert.strictEqual(titleLockedByUser(fresh), false);
const typed = '[[Bo';
const picked = L.applyChoice(typed, L.findTrigger(typed, typed.length), { uuid: ID, title: 'Boodschappen' });
const body = picked.value;
assert.strictEqual(body, link);
const title = savedTitle(fresh, derivedTitleFromBody(body), body);
assert.strictEqual(title, 'Boodschappen');
assert.ok(!title.includes('dg-note:'));
const saved = { uuid: 'n1', content: { ...fresh.content, title, content: body } };
assert.strictEqual(effectiveNoteTitle(saved), 'Boodschappen');
// Body is untouched and still renders a working link to the target note.
assert.strictEqual(saved.content.content, `[Boodschappen](dg-note:${ID})`);
const lookup = (uuid) => (uuid === ID ? { title: 'Boodschappen' } : undefined);
const prepared = L.prepareRender(saved.content.content, lookup);
assert.match(prepared.restore(render(prepared.text)), new RegExp(`href="#note/${ID}"[^>]*data-dg-note="${ID}"`));
assert.deepStrictEqual(L.findLinks(saved.content.content).map((l) => l.uuid), [ID]);
// Further typing keeps the title derived.
assert.strictEqual(titleLockedByUser(saved), false);

// Other markdown links and mixed text.
assert.strictEqual(derivedTitleFromBody(`Zie ${link} en [site](https://example.com)\nmeer`), 'Zie Boodschappen en site');
assert.strictEqual(derivedTitleFromBody('![logo](https://x.test/a.png) Kop'), 'logo Kop');
assert.strictEqual(derivedTitleFromBody('Gewone [tekst] zonder link'), 'Gewone [tekst] zonder link');

// 2. Legacy: a title stored raw by the old derivation is not a user title.
const legacyRaw = legacyDerivedTitleFromBody(body);
assert.strictEqual(legacyRaw, link);
const legacy = { uuid: 'n2', content: { type: 'note', title: legacyRaw, title_manual: false, content: body } };
assert.strictEqual(titleIsDerivedFromBody(legacyRaw, body), true);
assert.strictEqual(titleLockedByUser(legacy), false);
assert.strictEqual(effectiveNoteTitle(legacy), 'Boodschappen');
assert.strictEqual(savedTitle(legacy, legacyRaw, body), 'Boodschappen');

// Legacy with a long first line (truncated at 60) and an ordinary link.
const longBody = `Lees [de handleiding](https://example.com/docs) voor ${'x'.repeat(80)}`;
const legacyLong = { uuid: 'n3', content: { type: 'note', title: legacyDerivedTitleFromBody(longBody), content: longBody } };
assert.strictEqual(titleLockedByUser(legacyLong), false);
assert.ok(!effectiveNoteTitle(legacyLong).includes('https://'));
assert.ok(!savedTitle(legacyLong, legacyLong.content.title, longBody).includes('https://'));

// 3. A title the user typed is never overwritten.
const typedFlag = { uuid: 'n4', content: { type: 'note', title: 'Mijn lijst', title_manual: true, content: body } };
assert.strictEqual(titleLockedByUser(typedFlag), true);
assert.strictEqual(savedTitle(typedFlag, 'Mijn lijst', body), 'Mijn lijst');
assert.strictEqual(effectiveNoteTitle(typedFlag), 'Mijn lijst');
const typedNoFlag = { uuid: 'n5', content: { type: 'note', title: 'Eigen titel', content: body } };
assert.strictEqual(titleLockedByUser(typedNoFlag), true);
assert.strictEqual(effectiveNoteTitle(typedNoFlag), 'Eigen titel');
// Even a typed raw link title stays when the user marked it manual.
const typedRaw = { uuid: 'n6', content: { type: 'note', title: link, title_manual: true, content: body } };
assert.strictEqual(effectiveNoteTitle(typedRaw), link);

console.log('test_note_title_links: ok');
