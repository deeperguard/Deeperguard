/**
 * Folder vs tag explanation: sidebar sections, new-folder prompt and manage-tags dialog
 * all carry the "one folder / several tags" text, linked via aria-describedby or visible,
 * and the texts exist in English and Dutch.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// --- translation table (en + nl) ---
const tableSrc = appJs.split('const FOLDER_TAG_EXPLAIN = ')[1];
assert.ok(tableSrc, 'FOLDER_TAG_EXPLAIN table exists in app.js');
const table = vm.runInNewContext(`(${tableSrc.split('};')[0]}})`);
for (const lang of ['en', 'nl']) {
  for (const key of ['folder', 'tag']) {
    assert.ok(String(table[lang]?.[key] || '').trim(), `missing ${lang}.${key} explanation`);
  }
}
assert.match(table.en.folder, /exactly one folder/i);
assert.match(table.en.tag, /several tags/i);
assert.match(table.nl.folder, /precies één map/i);
assert.match(table.nl.tag, /meerdere labels/i);
assert.ok(appJs.includes('applyFolderTagExplain();'), 'locale texts are applied at startup');

// --- helpers on the static markup ---
function openTag(id) {
  const m = html.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`, 'i'));
  assert.ok(m, `element #${id} exists`);
  return m[0];
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}
function explainFor(id) {
  const tag = openTag(id);
  return { kind: attr(tag, 'data-explain'), text: html.split(tag)[1].split('<')[0].trim() };
}

// Every aria-describedby in the template must resolve to an existing id.
const describedIds = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
for (const id of describedIds) {
  assert.ok(html.includes(`id="${id}"`), `aria-describedby target #${id} exists`);
}

// Sidebar sections: visible explanation inside each section.
for (const [section, explainId, kind, inputId] of [
  ['tag-section', 'tag-section-explain', 'tag', 'tag-name-input'],
  ['folder-section', 'folder-section-explain', 'folder', 'folder-name-input'],
]) {
  const block = html.split(`id="${section}"`)[1].split('</details>')[0];
  assert.ok(block.includes(`id="${explainId}"`), `${section} contains its explanation`);
  const ex = explainFor(explainId);
  assert.strictEqual(ex.kind, kind);
  assert.strictEqual(ex.text, table.en[kind]);
  assert.strictEqual(attr(openTag(inputId), 'aria-describedby'), explainId, `${inputId} described by explanation`);
}

// Dialogs: new folder + manage tags carry the explanation via aria-describedby.
for (const [dialogId, kind] of [['folder-prompt', 'folder'], ['tag-manage-dialog', 'tag']]) {
  const describedBy = attr(openTag(dialogId), 'aria-describedby');
  assert.ok(describedBy, `#${dialogId} has aria-describedby`);
  const ex = explainFor(describedBy);
  assert.strictEqual(ex.kind, kind, `#${dialogId} explanation is the ${kind} text`);
  assert.strictEqual(ex.text, table.en[kind]);
  const dialogBlock = html.split(openTag(dialogId))[1].split('confirm-dialog-actions')[0];
  assert.ok(dialogBlock.includes(`id="${describedBy}"`), `explanation lives inside #${dialogId}`);
}

// Theme-aware colour (no hard-coded light/dark value).
const css = appCss.split('.nav-explain {')[1].split('}')[0];
assert.ok(css.includes('color: var(--muted)'));

console.log('folder/tag explanation ok');
