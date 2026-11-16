// All XSS vectors from docs/design/rich-editor-tests.md.
//  1. Here in node: the markdown-it stage (html:false + URL allowlist) and the search highlighters.
//  2. In real Chromium (tests/rich_xss_vectors_browser.py): the full pipeline with DOMPurify,
//     checking that no script runs, no on* attribute or dangerous URL survives, no request is made.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const NotesMarkdown = require('../app/static/js/markdown.js');
const NotesSanitize = require('../app/static/js/sanitize.js');
const NotesSearch = require('../app/static/js/search.js');
const {
  RENDER_VECTORS, SEARCH_VECTORS, ALLOWED_HREF, ALLOWED_SRC,
} = require('./rich_xss_vectors.js');

const ALLOWED_TAGS = new Set(NotesSanitize.RICH_ALLOWED_TAGS);
const ALLOWED_ATTR = new Set(NotesSanitize.RICH_ALLOWED_ATTR);

function decode(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function tagsOf(html) {
  const tags = [];
  const re = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = [];
    const are = /\s+([^\s=>]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[2]))) attrs.push([a[1].toLowerCase(), decode(a[2] || '')]);
    tags.push({ name: m[1].toLowerCase(), attrs });
  }
  return tags;
}

function assertSafeHtml(html, label, extraTags = []) {
  // No raw "<" that is not one of our well-formed tags.
  const stripped = html.replace(/<\/?[a-zA-Z][\w-]*(?:\s+[^\s=>]+(?:="[^"]*")?)*\s*\/?>/g, '');
  assert.ok(!stripped.includes('<'), `${label}: stray '<' in output`);
  for (const tag of tagsOf(html)) {
    assert.ok(ALLOWED_TAGS.has(tag.name) || extraTags.includes(tag.name), `${label}: tag <${tag.name}> not allowed`);
    for (const [name, value] of tag.attrs) {
      assert.ok(!name.startsWith('on'), `${label}: event handler ${name}`);
      assert.ok(name !== 'style', `${label}: style attribute`);
      assert.ok(ALLOWED_ATTR.has(name), `${label}: attribute ${name} not allowed`);
      if (name === 'href') assert.ok(ALLOWED_HREF.test(value), `${label}: href ${value}`);
      if (name === 'src') assert.ok(tag.name === 'img' && ALLOWED_SRC.test(value), `${label}: src ${value}`);
    }
    if (tag.name === 'a' && tag.attrs.some(([n, v]) => n === 'href' && /^https?:/i.test(v))) {
      const rel = tag.attrs.find(([n]) => n === 'rel');
      assert.strictEqual(rel && rel[1], 'noopener noreferrer', `${label}: external link without rel`);
    }
  }
}

const render = (md) => NotesMarkdown.renderRichUnsafe(md);
const byId = (id) => render(RENDER_VECTORS.find((v) => v.id === id).md);

let ran = 0;
for (const vector of RENDER_VECTORS) {
  const label = `vector #${vector.id}`;
  const started = Date.now();
  const html = render(vector.md);
  if (vector.dos) assert.ok(Date.now() - started < 5000, `${label}: rendering took too long`);
  assertSafeHtml(html, label);
  if (vector.text) {
    const visible = decode(html.replace(/<[^>]+>/g, ''));
    assert.ok(visible.includes(vector.text), `${label}: payload not shown as text`);
  }
  if (vector.strong) assert.ok(html.includes(`<strong>${vector.strong}</strong>`), `${label}: emphasis lost`);
  if (vector.table) {
    assert.match(html, /<table>/, `${label}: table missing`);
    assert.strictEqual((html.match(/<th[\s>]/g) || []).length, vector.table, `${label}: column count`);
  }
  assert.strictEqual(render(vector.md), html, `${label}: render not deterministic`);
  ran += 1;
}

// Vector specifics.
assert.doesNotMatch(byId(4), /<img/, '#4: x is not an allowed image source');
assert.doesNotMatch(byId(4.1), /<img/, '#4: x is not an allowed image source');
assert.doesNotMatch(byId(5), /href/);
assert.match(byId(5), /klik/);
assert.doesNotMatch(byId(9), /<img/, '#9: svg data URI refused');
assert.doesNotMatch(byId(18), /onmouseover=/);
assert.doesNotMatch(byId(18), /data-lang/, '#18: unsafe language name is ignored');
assert.doesNotMatch(byId(18.1), /<img/);
assert.doesNotMatch(byId(20), /<[^>]*\s(?:onclick|style)=/);
assert.doesNotMatch(byId(26), /<img/, '#26: external images are never loaded');
assert.match(byId(26), /<a href="https:\/\/tracker\.example\/pixel\.gif" class="md-ext-image" rel="noopener noreferrer" target="_blank">t<\/a>/);
assert.doesNotMatch(byId(28), /href/);
assert.doesNotMatch(byId(31), /href/, '#31: zero-width character in href is refused');
assert.doesNotMatch(byId(31.1), /href/);
assert.doesNotMatch(byId(31.2), /href/, '#31: bidi override in href is refused');
for (const id of [6, 6.1, 6.2, 6.3, 6.4, 7, 7.1]) assert.doesNotMatch(byId(id), /href/, `#${id}: no href`);
// #17: code is shown as text; the raw source is what the copy button copies (textContent of <code>).
// The colouring may wrap tokens in <span class="hljs-*">; the text content is still the exact source.
assert.match(byId(17), /<code class="language-html">/);
assert.doesNotMatch(byId(17), /<script/i);
assert.strictEqual(decode(byId(17).replace(/<[^>]+>/g, '')).trim(), '<script>window.__xss=1</script>');
// #12: the quote is not a break-out; no extra attribute is created.
for (const id of [12, 12.1]) {
  const attrNames = tagsOf(byId(id)).flatMap((tag) => tag.attrs.map(([name]) => name));
  assert.ok(!attrNames.some((name) => name.startsWith('on')), `#${id}: injected attribute`);
}

// #22-#25: search term, fragment, OCR text, title/attachment name: always escaped around <mark>.
for (const vector of SEARCH_VECTORS) {
  const label = `search vector #${vector.id}`;
  const marked = NotesSearch.highlightPlain(vector.text, vector.query);
  assertSafeHtml(marked, label, ['mark']);
  assert.ok(decode(marked.replace(/<[^>]+>/g, '')).includes(vector.text), `${label}: text lost`);
  assert.match(marked, /<mark[^>]*>/, `${label}: nothing marked`);
  const snippet = NotesSearch.highlightPlain(NotesSearch.snippetAround(vector.text, vector.query), vector.query);
  assertSafeHtml(snippet, `${label} (fragment)`, ['mark']);
  ran += 1;
}
assert.match(NotesSearch.highlightPlain('a onerror b', 'onerror'), /<mark[^>]*>onerror<\/mark>/);

// Features the view must keep (headings, lists, links, emphasis, quotes, attachment images).
const rich = render([
  '# Kop', '', '## Sub', '', '- een', '- [ ] taak', '- [x] klaar', '', '1. a', '2. b', '',
  '> citaat', '', '*nadruk* en **vet**', '', '[ext](https://example.com) [anker](#kop) [mail](mailto:a@b.nl)',
  '', '![foto](data:image/png;base64,iVBORw0KGgo=)', '', '![bijlage](blob:https://app.example/1234-5678)',
  '', '| l | r |', '|:--|--:|', '| 1 | 2 |',
].join('\n'));
assert.match(rich, /<h1>Kop<\/h1>/);
assert.match(rich, /<h2>Sub<\/h2>/);
assert.match(rich, /<ul>/);
assert.match(rich, /<ol>/);
assert.match(rich, /<blockquote>/);
assert.match(rich, /<em>nadruk<\/em>/);
assert.match(rich, /<strong>vet<\/strong>/);
assert.match(rich, /<a href="https:\/\/example\.com" rel="noopener noreferrer" target="_blank">ext<\/a>/);
assert.match(rich, /<a href="#kop">anker<\/a>/);
assert.match(rich, /<a href="mailto:a@b\.nl" rel="noopener noreferrer" target="_blank">mail<\/a>/);
assert.match(rich, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="foto">/);
assert.match(rich, /<img src="blob:https:\/\/app\.example\/1234-5678" alt="bijlage">/);
assert.match(rich, /class="md-align-left"/);
assert.match(rich, /class="md-align-right"/);
assert.strictEqual((rich.match(/class="task-toggle"/g) || []).length, 2);
assert.match(rich, /data-checked="0"/);
assert.match(rich, /data-checked="1"/);
assertSafeHtml(rich, 'feature sample');

// Without a DOM sanitizer render() must still be safe: it falls back to the old renderer.
assert.doesNotMatch(NotesMarkdown.render('<script>window.__xss=1</script> [a](javascript:x)'), /<script|href="javascript/);

// URL policy unit checks.
assert.strictEqual(NotesSanitize.safeRichHref('javascript:alert(1)'), '');
assert.strictEqual(NotesSanitize.safeRichHref('vbscript:msgbox(1)'), '');
assert.strictEqual(NotesSanitize.safeRichHref('data:text/html,hi'), '');
assert.strictEqual(NotesSanitize.safeRichHref(' https://x.nl'), '');
assert.strictEqual(NotesSanitize.safeRichHref('https://x.nl/a'), 'https://x.nl/a');
assert.strictEqual(NotesSanitize.safeRichHref('#note/abc'), '#note/abc');
assert.strictEqual(NotesSanitize.safeRichHref('#javascript:alert(1)'), '');
assert.strictEqual(NotesSanitize.safeRichImageSrc('https://x.nl/a.png'), '');
assert.strictEqual(NotesSanitize.safeRichImageSrc('data:image/svg+xml;base64,AA=='), '');
assert.strictEqual(NotesSanitize.safeRichImageSrc('data:text/html;base64,AA=='), '');
assert.strictEqual(NotesSanitize.safeRichImageSrc('blob:https://app.example/123'), 'blob:https://app.example/123');

// Real DOM: DOMPurify + script execution + network (needs python3 with Playwright and Chromium).
const runner = path.join(__dirname, 'rich_xss_vectors_browser.py');
const browser = spawnSync('python3', [runner], { encoding: 'utf8' });
if (browser.status === 77) {
  // The DOMPurify layer is only exercised here, so CI sets REQUIRE_BROWSER_TESTS=1 to make a skip fatal.
  assert.notStrictEqual(process.env.REQUIRE_BROWSER_TESTS, '1', 'REQUIRE_BROWSER_TESTS=1 but the real-DOM run was skipped: ' + browser.stdout.trim());
  console.warn('WARNING: real-DOM (DOMPurify) run SKIPPED, not tested: ' + browser.stdout.trim());
} else {
  assert.strictEqual(browser.status, 0, `real-DOM vector run failed:\n${browser.stdout}\n${browser.stderr}`);
}

console.log(`ok (${ran} vectors)`);
