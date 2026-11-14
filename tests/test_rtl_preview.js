// RTL per block in the markdown preview: dir="auto" on every block, code
// blocks forced ltr, and the preview attribute filter (sanitize.js) that the
// real render path in app.js runs on the markdown output.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { render } = require('../app/static/js/markdown.js');
const { sanitizePreviewAttrs } = require('../app/static/js/sanitize.js');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// Same pipeline as renderNoteBodyPreviewRaw -> htmlWithoutInlineHandlers.
const preview = (md) => sanitizePreviewAttrs(render(md));

// 1. Arabic paragraph after an English one gets its own dir="auto".
const mixed = preview('Hello world\n\nمرحبا بالعالم');
assert.match(mixed, /<p dir="auto">Hello world<\/p>/);
assert.match(mixed, /<p dir="auto">مرحبا بالعالم<\/p>/);

// Every block element carries dir="auto".
const blocks = preview([
  '# H1', '## H2', '### H3', '',
  '- item', '- [ ] task', '',
  '> שלום', '> quote line two', '',
  '| A | B |', '| --- | --- |', '| 1 | 2 |',
].join('\n'));
for (const tag of ['h1', 'h2', 'h3', 'li', 'blockquote', 'th', 'td']) {
  const opens = blocks.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) || [];
  assert.ok(opens.length, `${tag} rendered`);
  opens.forEach((open) => assert.match(open, /\bdir="auto"/, `${tag} has dir=auto: ${open}`));
}
assert.match(blocks, /<blockquote dir="auto">שלום<br>quote line two<\/blockquote>/);
assert.doesNotMatch(blocks, /<p[^>]*><blockquote/, 'blockquote is not wrapped in a paragraph');
assert.doesNotMatch(blocks, /&gt; /, 'quote markers are consumed');

// 2. Code blocks are ltr, even between RTL paragraphs.
const code = preview('سلام\n\n```js\nconst x = 1;\n```\n\nسلام');
assert.match(code, /<pre class="code-preview" dir="ltr" data-lang="js"><code dir="ltr" class="language-js">/);
assert.doesNotMatch(code, /<pre[^>]*dir="auto"/);

// 3. Sanitizer: only dir=auto|ltr|rtl survives.
assert.strictEqual(sanitizePreviewAttrs('<p dir="evil">x</p>'), '<p>x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir="rtl">x</p>'), '<p dir="rtl">x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir="LTR">x</p>'), '<p dir="ltr">x</p>');
assert.strictEqual(sanitizePreviewAttrs("<p dir='auto'>x</p>"), '<p dir="auto">x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir=rtl>x</p>'), '<p dir="rtl">x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir>x</p>'), '<p>x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir="rtl x">x</p>'), '<p>x</p>');
// Two dir attributes: invalid ones are dropped, at most one valid one is kept.
assert.strictEqual(sanitizePreviewAttrs('<p dir="evil" dir="rtl">x</p>'), '<p dir="rtl">x</p>');
assert.strictEqual(sanitizePreviewAttrs('<p dir="ltr" dir="rtl">x</p>'), '<p dir="ltr">x</p>');
// A ">" inside a quoted attribute value does not end the tag early.
assert.strictEqual(
  sanitizePreviewAttrs('<a title="a > b" dir="evil" href="#x">y</a>'),
  '<a title="a > b" href="#x">y</a>',
);
assert.strictEqual(
  sanitizePreviewAttrs('<span data-x=\'1>2\' dir="evil" dir="auto">y</span>'),
  '<span data-x=\'1>2\' dir="auto">y</span>',
);
// Other disallowed attributes: inline event handlers are removed too.
assert.strictEqual(
  sanitizePreviewAttrs('<img src="x" onerror="alert(1)" ONLOAD=alert(2)>'),
  '<img src="x">',
);
assert.strictEqual(
  sanitizePreviewAttrs('<p title="x > y" onclick="a()" dir="evil">t</p>'),
  '<p title="x > y">t</p>',
);
// Untouched markup and text stay byte-identical.
const plain = '<pre class="code-preview" data-lang="js"><code>a &lt; b</code></pre> one=1';
assert.strictEqual(sanitizePreviewAttrs(plain), plain);

// The filter is wired into the real preview render path in app.js.
const fnStart = appJs.indexOf('function htmlWithoutInlineHandlers(html)');
assert.ok(fnStart >= 0);
assert.match(appJs.slice(fnStart, fnStart + 300), /NotesSanitize\.sanitizePreviewAttrs\(html\)/);
assert.match(appJs, /return htmlWithoutInlineHandlers\(html\);/, 'renderNoteBodyPreviewRaw output is filtered');
assert.match(appJs, /htmlWithoutInlineHandlers\(NotesMarkdown\.render\(text\)\)/, 'OCR markdown preview is filtered');
// Runtime pass keeps code ltr instead of auto.
const markStart = appJs.indexOf('function markAutoDir(root)');
const markBody = appJs.slice(markStart, markStart + 500);
assert.doesNotMatch(markBody.split('pre, pre code')[0], /\bpre\b/);
assert.match(markBody, /'pre, pre code'[\s\S]*?setAttribute\('dir', 'ltr'\)/);

// 4. CSS uses logical properties so lists and quotes mirror per block.
assert.match(css, /\.preview li \{ margin-inline-start: 1\.5em; \}/);
assert.match(css, /\.preview blockquote \{[^}]*border-inline-start:[^}]*padding-inline-start:|\.preview blockquote \{[^}]*padding-inline-start:[^}]*border-inline-start:/);
assert.match(css, /\.preview td, \.preview th \{ text-align: start; \}/);
assert.match(css, /#preview \.code-copy-btn \{[^}]*inset-inline-end:/);

console.log('test_rtl_preview ok');
