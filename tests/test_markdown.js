const assert = require('assert');
const { render, renderLegacy, renderRichUnsafe, toggleTaskAt } = require('../app/static/js/markdown.js');

const html = render('- [ ] Buy milk\n- [x] Done\n\n**bold** and `code`\n\n```\n*not italic*\n```');
assert.match(html, /task-toggle/);
assert.match(html, /data-checked="0"/);
assert.match(html, /data-checked="1"/);
assert.match(html, /<strong>bold<\/strong>/);
assert.match(html, /<pre(?: class="code-preview")?(?: dir="ltr")?><code/);
assert.doesNotMatch(html, /<em>not italic<\/em>/);

const linked = render('See [link](https://example.com) and [bad](javascript:alert(1)).');
assert.match(linked, /<a href="https:\/\/example.com" rel="noopener noreferrer" target="_blank">link<\/a>/);
assert.doesNotMatch(linked, /<a href="javascript:/);

const brokenHref = render('[x](https://example.com"onmouseover="alert(1))');
assert.match(brokenHref, /&quot;onmouseover=&quot;/);
assert.doesNotMatch(brokenHref, /href="https:\/\/example\.com" onmouseover/);

const dataUri = render('[d](data:text/html,hi)');
assert.doesNotMatch(dataUri, /<a href=/);

const mailto = render('[m](mailto:user@example.com)');
assert.match(mailto, /<a href="mailto:user@example.com"/);
const samePage = render('[jump](#title)');
assert.match(samePage, /<a href="#title">jump<\/a>/);
assert.doesNotMatch(samePage, /target="_blank"/);
const hashScheme = render('[bad](#javascript:alert(1))');
assert.doesNotMatch(hashScheme, /<a /);

const bare = render('See http://example.com and <https://example.com/a> today.');
assert.match(bare, /<a href="http:\/\/example.com" rel="noopener noreferrer" target="_blank">http:\/\/example.com<\/a>/);
assert.match(bare, /<a href="https:\/\/example.com\/a" rel="noopener noreferrer" target="_blank">https:\/\/example.com\/a<\/a>/);
const jsAutolink = render('javascript:alert(1) and <javascript:alert(1)>');
assert.doesNotMatch(jsAutolink, /<a href="javascript:/);
const coded = render('`http://example.com` stays code');
assert.match(coded, /<code>http:\/\/example.com<\/code>/);
assert.doesNotMatch(coded, /<code><a /);
const blanks = render('a\n\n\nb');
assert.match(blanks, /<p dir="auto"><br><\/p>/);

const flipped = toggleTaskAt('- [ ] one\n- [x] two', 1);
assert.strictEqual(flipped, '- [ ] one\n- [ ] two');
assert.strictEqual(toggleTaskAt('- [ ] one', 0), '- [x] one');

const emphasis = render('This is _italic_ and __bold__ and *still* **works**.');
assert.match(emphasis, /<em>italic<\/em>/);
assert.match(emphasis, /<strong>bold<\/strong>/);
assert.match(emphasis, /<em>still<\/em>/);
assert.match(emphasis, /<strong>works<\/strong>/);

// Emphasis must not rewrite inside link attribute values (Round 56 L1).
const attrTrap = render('[x](https://a.com/_x)_"onx=1');
assert.doesNotMatch(attrTrap, /target="<em>/);
assert.doesNotMatch(attrTrap, /<a[^>]+onx=/);
assert.match(attrTrap, /target="_blank"/);
const intraword = render('leave foo_bar_baz and foo__bar__baz alone');
assert.doesNotMatch(intraword, /<em>/);
assert.doesNotMatch(intraword, /<strong>/);
const codedEm = render('`_not italic_` stays code');
assert.match(codedEm, /<code>_not italic_<\/code>/);
assert.doesNotMatch(codedEm, /<em>not italic<\/em>/);
const safe = render('[_x_](javascript:alert(1)) and [_y_](https://example.com)');
assert.doesNotMatch(safe, /href="javascript:/);
assert.match(safe, /<a href="https:\/\/example.com"/);

const table = render('# Table test\n\n| Col A | Col B |\n| --- | ---: |\n| **x** | y |\n| a | b |\n');
assert.match(table, /<div class="md-table-wrap"><table>/);
assert.match(table, /<th scope="col" dir="auto">Col A<\/th>/);
assert.match(table, /text-align:right/);
assert.match(table, /<strong>x<\/strong>/);
assert.doesNotMatch(table, /\| Col A \|/);
const richTable = renderRichUnsafe('| Col A | Col B |\n| --- | ---: |\n| x | y |');
assert.match(richTable, /<div class="md-table-wrap"><table>/);
assert.match(richTable, /<th scope="col">Col A<\/th>/);
assert.match(richTable, /<th class="md-align-right" scope="col">Col B<\/th>/);
assert.doesNotMatch(richTable, /<td[^>]*scope=/);

// HTML, script and javascript: links in table header and body cells stay text in both renderers.
const hostileCells = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[x](javascript:alert(1))',
  '<iframe src="javascript:alert(1)"></iframe>',
];
for (const cell of hostileCells) {
  const source = `| ${cell} | h |\n| --- | --- |\n| ${cell} | c |`;
  for (const out of [render(source), renderRichUnsafe(source)]) {
    assert.match(out, /<table>/, cell);
    const tags = [...out.matchAll(/<([a-z][a-z0-9]*)([^>]*)>/gi)];
    assert.ok(tags.every(([, name]) => ['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(name)), `${cell}: ${out}`);
    assert.ok(tags.every(([, , attrs]) => !/\bon\w+=|src=|href=/i.test(attrs)), `${cell}: ${out}`);
  }
}

// L2: fence language / sheet name must be attribute-escaped.
const fenceXss = render('```x"onmouseover="alert(1)\ncode\n```');
assert.match(fenceXss, /data-lang="x&quot;onmouseover=&quot;alert\(1\)"/);
assert.doesNotMatch(fenceXss, /data-lang="x"onmouseover=/);

// Without a DOM sanitizer (node) render() uses the old renderer; the old renderer stays exported.
assert.strictEqual(render('**x**'), renderLegacy('**x**'));

// markdown-it stage: raw HTML is text, Markdown structure comes from markdown-it.
const mdit = renderRichUnsafe('# T\n\n> q\n\n1. a\n2. b\n\n<b onclick=x>y</b>');
assert.match(mdit, /<h1>T<\/h1>/);
assert.match(mdit, /<blockquote>/);
assert.match(mdit, /<ol>/);
assert.match(mdit, /&lt;b onclick=x&gt;y&lt;\/b&gt;/);
assert.doesNotMatch(mdit, /<b /);
const gap = renderRichUnsafe('a\n\n\nb');
assert.match(gap, /<p>a<\/p>\n<p><br><\/p>\n<p>b<\/p>/);
assert.doesNotMatch(renderRichUnsafe('a\n\nb'), /<br>/);
const rtlTask = renderRichUnsafe('- [x] done');
assert.match(rtlTask, /<li class="task done"><button type="button" class="task-toggle" data-checked="1" aria-checked="true">/);

console.log('ok');
