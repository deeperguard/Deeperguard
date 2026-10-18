const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'static', 'css', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');

const folderSelect = css.split('.editor-meta-row .editor-folder-control select {')[1].split('}')[0];
assert.ok(folderSelect && !folderSelect.includes('field-sizing'));
assert.ok(folderSelect.includes('min-width: 0'));
assert.ok(css.includes('#folder-prompt'));
assert.ok(css.includes('translate(-50%, -50%)'));
assert.ok(css.includes('max-height: min(70dvh, calc(100dvh - 24px))'));
const loginFrames = css.split('@keyframes login-indeterminate')[1].split('@keyframes')[0];
assert.ok(loginFrames.includes('translateX(138%)'));
assert.ok(!loginFrames.includes('translateX(-120%)'));
assert.ok(css.includes('.editor-pane .writing-tip'));
assert.ok(css.includes('.editor-pane #tag-suggest'));
assert.ok(css.includes('min-height: 40px'));

assert.ok(appJs.includes('renderHistory(savedNote)'));
assert.ok(appJs.includes('function syncChecklistSearchHighlights()'));
assert.ok(appJs.includes('function syncDocEnhance(kind)'));
assert.ok(appJs.includes("return 'FILE'"));
assert.ok(appJs.includes('function paintThumbImage('));
assert.ok(!appJs.includes("stage.textContent = 'File'"));

assert.ok(!html.includes('onsubmit='));
assert.ok(!html.includes('onclick='));
assert.ok(html.includes('id="doc-enhance-toggle" hidden'));
assert.ok(html.includes('id="unlock-form"'));

console.log('ok');
