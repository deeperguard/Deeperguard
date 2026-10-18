const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'static', 'css', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');
const store = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'store.js'), 'utf8');
const ocr = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'client-ocr-engine.js'), 'utf8');

assert.ok(!appJs.includes('if (currentId) closeEditor()'));
assert.ok(appJs.includes('Escape never closes the open note'));
assert.ok(appJs.includes('function docViewerFocusables()'));
assert.ok(appJs.includes("attachmentOcrRetryable(att)"));
assert.ok(appJs.includes('if (!attachmentIsPdfOrPhoto(att)) return false;'));
assert.ok(appJs.includes('originalFilename: originalName'));
assert.ok(appJs.includes('unlock-notice'));
assert.ok(appJs.includes('is-indeterminate'));
assert.ok(appJs.includes('Checking password…'));

assert.ok(html.includes('role="dialog" aria-modal="true" aria-labelledby="doc-title"'));
assert.ok(html.includes('Each pause saves a version.'));

assert.ok(!store.includes('REVISION_GAP_MS'));
assert.ok(ocr.includes('function keepOriginalScanFile(file)'));
assert.ok(ocr.includes("mime === 'image/webp'"));

assert.ok(css.includes('body.editor-toolbar-menu-open .editor-toolbar-menu-item.btn.icon svg.ui-icon'));
assert.ok(css.includes('.tag-bar-shell.is-collapsed .tag-bar-toggle-chevron { display: none; }'));
assert.ok(css.includes('#unlock-error.unlock-notice'));
assert.ok(css.includes('login-indeterminate'));
assert.ok(css.includes('#btn-find-desktop'));
assert.ok(css.includes('.editor-scroll > #preview:not([hidden])'));

console.log('ok');
