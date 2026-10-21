const assert = require('assert');
const { render, toggleTaskAt } = require('../app/static/js/markdown.js');

const html = render('- [ ] Buy milk\n- [x] Done\n\n**bold** and `code`\n\n```\n*not italic*\n```');
assert.match(html, /task-toggle/);
assert.match(html, /data-checked="0"/);
assert.match(html, /data-checked="1"/);
assert.match(html, /<strong>bold<\/strong>/);
assert.match(html, /<pre(?: class="code-preview")?><code/);
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
assert.match(blanks, /<p><br><\/p>/);

const flipped = toggleTaskAt('- [ ] one\n- [x] two', 1);
assert.strictEqual(flipped, '- [ ] one\n- [ ] two');
assert.strictEqual(toggleTaskAt('- [ ] one', 0), '- [x] one');

const emphasis = render('This is _italic_ and __bold__ and *still* **works**.');
assert.match(emphasis, /<em>italic<\/em>/);
assert.match(emphasis, /<strong>bold<\/strong>/);
assert.match(emphasis, /<em>still<\/em>/);
assert.match(emphasis, /<strong>works<\/strong>/);
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
assert.match(table, /<th>Col A<\/th>/);
assert.match(table, /text-align:right/);
assert.match(table, /<strong>x<\/strong>/);
assert.doesNotMatch(table, /\| Col A \|/);

// L2: fence language / sheet name must be attribute-escaped.
const fenceXss = render('```x"onmouseover="alert(1)\ncode\n```');
assert.match(fenceXss, /data-lang="x&quot;onmouseover=&quot;alert\(1\)"/);
assert.doesNotMatch(fenceXss, /data-lang="x"onmouseover=/);

console.log('ok');
