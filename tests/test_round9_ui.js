const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'static', 'css', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'app', 'templates', 'login.html'), 'utf8');
const totp = fs.readFileSync(path.join(root, 'app', 'templates', 'totp.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app', 'static', 'sw.js'), 'utf8');

assert.ok(appJs.includes('function checklistPreviewRows('));
assert.ok(appJs.includes('function highlightListText('));
assert.ok(appJs.includes('highlightListText(`• ${row.text}`, query)'));
assert.ok(appJs.includes('function fitThumbCanvas('));
assert.ok(appJs.includes('function paintFittedThumb('));
assert.ok(appJs.includes('function scrollOpenNoteToTop('));
assert.ok(appJs.includes('scrollOpenNoteToTop();'));
assert.ok(appJs.includes("role=\"checkbox\""));
assert.ok(appJs.includes('aria-label="${escapeAttr(String(row.text || \'\').trim() || \'List item\')}"'));
assert.ok(appJs.includes("const kindLabel = attachmentThumbLabel(kind);"));
assert.ok(appJs.includes("label: 'PDF'"));
assert.ok(appJs.includes("label: 'IMG'"));
assert.ok(appJs.includes("panel.setAttribute('role', 'menu')"));
assert.ok(appJs.includes("el.setAttribute('role', 'menuitem')"));
assert.ok(!appJs.includes("kind === 'image' ? 'Image'"));

const thumbRule = css.split('.note-list-thumb img,')[1].split('}')[0];
assert.ok(thumbRule.includes('object-fit: contain'));
// Round 12 centers contained thumbs so the whole receipt is visible.
assert.ok(thumbRule.includes('object-position: center'));
assert.ok(!thumbRule.includes('object-fit: cover'));
assert.ok(css.includes('overflow-anchor: none'));
assert.ok(css.includes('.editor-head-main .editor-meta-row'));
assert.ok(css.includes('display: contents'));
assert.ok(css.includes('order: 2'));
assert.ok(css.includes('justify-content: flex-start'));
const sheet = css.split('body.editor-toolbar-menu-open .editor-actions-overflow-panel .editor-phone-toolbar-hide:not([hidden]):not(.editor-tools-divider)')[1].split('}')[0];
assert.ok(sheet.includes('border: 0 !important'));
assert.ok(sheet.includes('color: var(--text) !important'));
assert.ok(css.includes('content: none !important'));

assert.ok(html.includes('role="dialog" aria-modal="true" aria-labelledby="confirm-title"'));
assert.ok(!html.includes('role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"'));
assert.ok(!html.includes('mailto:'));
assert.ok(!html.includes('onsubmit='));
assert.ok(!html.includes('onclick='));
assert.ok(!html.includes('title="Note type"'));

assert.ok(!login.includes('onsubmit='));
assert.ok(!totp.includes('onsubmit='));

assert.ok(sw.includes("You're offline"));
assert.ok(sw.includes('cacheFirstNavigate'));
assert.ok(sw.includes('Keep this file byte-stable'));
assert.ok(sw.includes('function withoutInlineHandlers'));
assert.ok(!sw.includes('onclick='));
assert.ok(sw.includes('id="offline-reload"'));

console.log('ok');
