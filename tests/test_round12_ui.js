const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const markdown = fs.readFileSync(path.join(root, 'app/static/js/markdown.js'), 'utf8');

// 1. Spurious conflict copy: adopt rev while dirty; fingerprint rebase
assert.ok(storeJs.includes('function adoptPushedRevision('));
assert.ok(storeJs.includes('function isRecentLocalNoteText('));
assert.ok(storeJs.includes('rememberNoteFingerprint'));
assert.ok(storeJs.includes('if (editedSincePush(uuid, snap))'));
assert.ok(storeJs.includes('adoptPushedRevision(uuid, result)'));
assert.ok(storeJs.includes('!isRecentLocalNoteText(uuid, remote.content)'));

// 2. Markdown preview: blank lines, fence lang, inline code style
assert.ok(markdown.includes('highlightFence'));
assert.ok(markdown.includes('NotesMarkdownHighlight'));
assert.ok(markdown.includes('```([^\n`]*)\\n?([\\s\\S]*?)```') || markdown.includes('```([^\\n`]*)\\n?([\\s\\S]*?)```'));
assert.ok(markdown.includes('chunk.length - 2'));
assert.ok(markdown.includes('<p><br></p>'));
assert.ok(css.includes('#preview code') || css.includes('.preview code'));
assert.ok(css.includes('pre.code-preview'));

const { render } = require('../app/static/js/markdown.js');
const spaced = render('Hello\n\n\nWorld');
assert.ok(spaced.includes('<p><br></p>'), 'extra blank lines survive as empty paragraphs');
assert.ok(spaced.includes('<p>Hello</p>'));
assert.ok(spaced.includes('<p>World</p>'));
const fenced = render('```js\nconst x = 1;\n```');
assert.ok(fenced.includes('data-lang="js"'));
assert.ok(fenced.includes('language-js'));
assert.ok(!fenced.includes('>js\n') && !fenced.includes('>js</'), 'info string is not rendered as code body');
assert.ok(fenced.includes('const x = 1;'));
const inline = render('use `code` here');
assert.ok(inline.includes('<code>code</code>'));

// 3. Thumbs: contain+center; PDF list width uses DPR
assert.ok(appJs.includes('Math.min(side / sw, side / sh)'));
assert.ok(appJs.includes('const dx = Math.round((side - dw) / 2)'));
assert.ok(appJs.includes('Math.max(LIST_THUMB_PX, thumbOutputPx())'));
assert.ok(css.includes('object-position: center'));

// 4. Attach keeps existing title; untitled gets filename with extension
assert.ok(appJs.includes('function noteHasUsableTitle('));
assert.ok(appJs.includes('function fileTitleWithExt('));
assert.ok(appJs.includes('if (note && !noteHasUsableTitle(note))'));
assert.ok(!appJs.includes("if (note && (!note.content.title || note.content.title === 'Untitled'))"));

// 5. Find tooltip: no native title; Escape suppresses custom tip
assert.ok(!html.includes('id="btn-find"') || !/#btn-find[^>]*title=/.test(html));
assert.ok(html.includes('id="btn-find"') && html.includes('aria-label="Find in note"'));
assert.ok(!html.includes('title="Find in note (⌘F)"'));
assert.ok(appJs.includes('function suppressToolbarTips('));
assert.ok(appJs.includes("querySelectorAll('.find-btn')"));
assert.ok(css.includes('body.editor-toolbar-tip-suppress .find-btn'));

// 6. Consistent FILE paperclip for non-pdf/img
assert.ok(appJs.includes("return { icon: '📎', label: 'FILE', tone: 'note', svg: kindIconSvg('note') }"));
assert.ok(!appJs.includes("if (kind === 'text') return { icon: '📃', label: 'FILE'"));

// 7. Wider compact breakpoint
assert.ok(css.includes('@media (max-width: 999px)'));
assert.ok(css.includes('@media (min-width: 1000px)'));
assert.ok(appJs.includes("(max-width: 999px)"));
assert.ok(appJs.includes("(min-width: 1000px)"));
assert.ok(css.includes('scroll-margin-bottom: 72px') || css.includes('.sidebar-nav #folder-section'));

// 8. List + editor relative times share the same refresh
assert.ok(appJs.includes('function refreshRelativeTimes('));
assert.ok(appJs.includes('updateNoteMeta(open)'));
assert.ok(appJs.includes('rowTime.dataset.edited'));

console.log('ok');
