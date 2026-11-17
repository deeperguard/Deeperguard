// Formatted Markdown editor. The behaviour checks run in real Chromium
// (tests/test_rich_editor_browser.py: byte-exact round-trip over a corpus, toolbar and shortcuts,
// undo/redo, pasted HTML, keyboard use, typing speed). Here: the pure helpers and the page markup
// (the browser part needs python3 with pytest, Playwright and Chromium, and fails without them).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const rich = require('../app/static/js/rich-editor.js');

assert.strictEqual(rich.available(), false, 'no editor library in plain node');
assert.strictEqual(rich.tooLarge('x'.repeat(rich.MAX_CHARS)), false);
assert.strictEqual(rich.tooLarge('x'.repeat(rich.MAX_CHARS + 1)), true);
assert.strictEqual(rich.tooLarge('\n'.repeat(rich.MAX_LINES - 1)), false);
assert.strictEqual(rich.tooLarge('\n'.repeat(rich.MAX_LINES)), true);

// The page must give the toolbar its role and every button an accessible name.
const html = fs.readFileSync(path.join(__dirname, '../app/templates/app.html'), 'utf8');
const toolbar = /<div id="md-toolbar"[^>]*>([\s\S]*?)<\/div>/.exec(html);
assert.ok(toolbar, 'toolbar markup');
assert.ok(/role="toolbar"/.test(toolbar[0]) && /aria-label="[^"]+"/.test(toolbar[0].split('>')[0]));
for (const [button] of toolbar[1].matchAll(/<button[^>]*>/g)) {
  assert.ok(/aria-label="[^"]+"/.test(button) || /id="btn-(rich|md)-mode"/.test(button), `button without aria-label: ${button}`);
}

// A missing Playwright or Chromium is a failure, not a skip: otherwise the core checks never run and the test stays green.
const run = spawnSync('python3', ['-I', '-m', 'pytest', '-q', path.join(__dirname, 'test_rich_editor_browser.py')], { encoding: 'utf8' });
assert.strictEqual(run.status, 0, `browser run failed:\n${run.stdout}\n${run.stderr}`);
assert.ok(/\bpassed\b/.test(run.stdout) && !/\bskipped\b/.test(run.stdout), `browser checks did not all run:\n${run.stdout}`);
console.log('ok');
