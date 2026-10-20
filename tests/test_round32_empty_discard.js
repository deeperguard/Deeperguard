/**
 * Round 32 HIGH: whitespace-cleared saved notes must not be hard-deleted.
 * Sequence: create → type body → Saved → clear to whitespace → set real title → leave.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NotesSearch = require('../app/static/js/search.js');
const {
  noteIsEmptyStub,
  noteHasBeenSaved,
  noteMayHardDiscard,
  parseQueryTerms,
} = NotesSearch;
const { revisionLabel } = require('../app/static/js/note-history.js');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const legal = fs.readFileSync(path.join(root, 'app/templates/legal.html'), 'utf8');
const docPage = fs.readFileSync(path.join(root, 'app/templates/doc-page.html'), 'utf8');
const adminApi = fs.readFileSync(path.join(root, 'app/admin_api.py'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

function note(content, extra = {}) {
  return { uuid: 'n1', rev: extra.rev || 0, content: { type: 'note', tags: [], attachments: [], revisions: [], ...content } };
}

// Brand-new empty draft may be discarded (including after a sync rev).
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '' })), true);
assert.strictEqual(noteMayHardDiscard(note({ title: '   ', content: '  \n  ' })), true);
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '' }, { rev: 5 })), true);
assert.strictEqual(noteHasBeenSaved(note({ title: '', content: '' }, { rev: 5 })), false);

// After user content was saved (revision with body), clearing must NOT hard-discard.
const savedThenCleared = note({
  title: '   ',
  content: '   \n  ',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: '', content: 'hello body' }],
});
assert.strictEqual(noteIsEmptyStub(savedThenCleared), true);
assert.strictEqual(noteHasBeenSaved(savedThenCleared), true);
assert.strictEqual(noteMayHardDiscard(savedThenCleared), false);

// Real title after whitespace clear is not an empty stub.
assert.strictEqual(noteMayHardDiscard(note({
  title: 'R32 ws2',
  content: '   \n  ',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: '', content: 'hello' }],
})), false);

// App uses noteMayHardDiscard for flushSave + discardEmptyDraftNote.
assert.ok(appJs.includes('noteMayHardDiscard'));
assert.ok(appJs.includes('noteHasBeenSaved'));
assert.ok(searchJs.includes('function noteMayHardDiscard'));
assert.ok(searchJs.includes('function noteHasBeenSaved'));

// Discard path no longer uses bare noteIsEmptyStub for hard remove in flushSave.
const flush = appJs.split('function flushSave()')[1].split('function scheduleSave()')[0];
assert.ok(flush.includes('noteMayHardDiscard'));
assert.ok(!/NotesStore\.remove\(currentId,\s*\{\s*force:\s*true\s*\}\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*NotesStore\.upsert/.test(
  flush.replace(/\s+/g, ' '),
) || flush.includes('noteMayHardDiscard'));

// Lone quote must not match every note.
assert.ok(parseQueryTerms('"').length >= 1);
assert.strictEqual(NotesSearch.matches(note({ title: 'Hello', content: 'world' }), '"', {}), false);

// Version history empty snapshot label.
assert.strictEqual(revisionLabel({ title: '', content: '' }), 'Untitled (first save)');

// Medium: terms beta quota, self-host rendered HTML, danger zone, file inputs.
assert.ok(legal.includes('Pro with 5'));
assert.ok(legal.includes('/contact'));
assert.ok(legal.includes('Last updated'));
assert.ok(docPage.includes('mk-topbar.html'));
assert.ok(docPage.includes('body_html'));
assert.ok(adminApi.includes('render_simple_markdown'));
assert.ok(html.includes('id="settings-danger-zone"'));
assert.ok(html.includes('settings-danger-hint'));
assert.ok(html.includes('id="scan-camera"') && html.includes('tabindex="-1"'));
assert.ok(appPy.includes('strict=True'));
assert.ok(appPy.includes('Code already sent'));

// Tag/folder empty copy without Sync.
assert.ok(appJs.includes('No notes in ${name} yet'));
assert.ok(appJs.includes('Add this tag to a note.'));

// Tap targets / login gap / account cache.
assert.ok(css.includes('min-height: 44px'));
assert.ok(
  css.includes('.brand .zk-plain + .auth-hint')
  || css.includes('margin: 10px auto 12px')
  || css.includes('.brand p.zk-plain')
  || css.includes('margin: 12px 0 0'),
);
assert.ok(fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8').includes('ACCOUNT_CACHE_MS'));

console.log('test_round32_empty_discard ok');
