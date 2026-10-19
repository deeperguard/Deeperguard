const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'store.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'static', 'css', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');

assert.ok(css.includes('flex-wrap: nowrap !important'));
assert.ok(css.includes('flex-direction: column !important'));
assert.ok(css.includes('.editor-actions-overflow-panel .editor-actions-group'));
const disabled = css.split('.editor-toolbar-menu-item:disabled:not([hidden])')[1].split('}')[0];
assert.ok(disabled.includes('opacity: 0.45 !important'));
assert.ok(css.includes('body.editor-toolbar-menu-open .editor-toolbar-overflow-toggle.btn.icon[aria-label]::after'));
assert.ok(css.includes('.note-preview-checked'));
assert.ok(css.includes('.section-chevron'));
assert.ok(!css.includes("content: '▾'"));

assert.ok(appJs.includes('function attachmentKindName('));
assert.ok(appJs.includes('note-preview-checked'));
assert.ok(appJs.includes('highlightListText(`• ${row.text}`, query)'));
// Round 12 switched list thumbs from cover-crop to contain+center so receipts
// show the whole image instead of a single glyph fragment.
assert.ok(appJs.includes('Math.min(side / sw, side / sh)'));
assert.ok(appJs.includes('btn.setAttribute(\'aria-label\', text)'));
assert.ok(appJs.includes('kdfFastReject'));
assert.ok(appJs.includes('function noteBrowserZoom('));
assert.ok(appJs.includes('function restoreEditorAfterZoom('));
assert.ok(appJs.includes("ui.body.spellcheck = codeNote ? false : !!prefs.spellcheck"));
assert.ok(appJs.includes("ui.body.spellcheck = editorKind === 'code' ? false : !!prefs.spellcheck"));
assert.ok(appJs.includes("dialog.setAttribute('aria-labelledby', 'confirm-title')"));
assert.ok(appJs.includes('appShell.setAttribute(\'aria-hidden\', \'true\')'));
assert.ok(appJs.includes('if (document.activeElement === btn) btn.blur()'));

assert.ok(storeJs.includes('kdfFastReject'));
assert.ok(storeJs.includes('state.kdfFastReject = true'));
assert.ok(storeJs.includes('const secondScore = await scoreVaultKdfVersion(password, salt, second, ciphers)'));

assert.ok(html.includes('aria-labelledby="confirm-title"'));
assert.ok(html.includes('id="confirm-title"'));
assert.ok(html.includes('class="section-chevron section-chevron-open" aria-hidden="true"'));
assert.ok((html.match(/section-chevron-open" aria-hidden="true"/g) || []).length === 3);
assert.ok((html.match(/section-chevron-closed" aria-hidden="true"/g) || []).length === 3);

console.log('ok');
