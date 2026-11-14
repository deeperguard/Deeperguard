/**
 * Copy button on code blocks in the note preview: added with DOM APIs after
 * rendering (exactly one per block, also after re-render), copies only the
 * code text, and markdown source still cannot inject a <button>.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install, Element } = require('./domstub.js');

const { document } = install();
if (!Element.prototype.setAttribute) {
  Element.prototype.setAttribute = function setAttribute(name, value) {
    this.attrs = this.attrs || {};
    this.attrs[name] = String(value);
  };
  Element.prototype.getAttribute = function getAttribute(name) {
    return this.attrs && name in this.attrs ? this.attrs[name] : null;
  };
}

const root = path.join(__dirname, '..');
const { render } = require('../app/static/js/markdown.js');
const { decorateCodeBlocks, copyCodeBlock, bindCodeCopy } = require('../app/static/js/preview.js');

function decode(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Build a DOM preview from rendered markdown (the stub does not parse HTML).
function buildPreview(html) {
  const container = document.createElement('div');
  container.id = 'preview';
  const re = /<pre class="code-preview"[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g;
  let match;
  while ((match = re.exec(html))) {
    const pre = document.createElement('pre');
    pre.className = 'code-preview';
    const code = document.createElement('code');
    code.textContent = decode(match[1]);
    pre.appendChild(code);
    container.appendChild(pre);
  }
  return container;
}

function buttonsIn(container) {
  return container.querySelectorAll('button.code-copy-btn');
}

const source = 'Intro\n\n```js\nconst a = "<b>" && 1;\nconsole.log(a);\n```\n\nMid\n\n```\nplain   text\n```\n';
const html = render(source);
assert.match(html, /<pre class="code-preview" data-lang="js"><code/);
assert.doesNotMatch(html, /<button/i, 'markdown output itself carries no button HTML');

(async () => {
  // Exactly one button per block, also after re-renders and repeated decoration.
  let preview = buildPreview(html);
  assert.strictEqual(preview.querySelectorAll('pre.code-preview').length, 2);
  assert.strictEqual(decorateCodeBlocks(preview), 2);
  assert.strictEqual(decorateCodeBlocks(preview), 0, 'second pass adds nothing');
  assert.strictEqual(buttonsIn(preview).length, 2);
  preview.querySelectorAll('pre.code-preview').forEach((pre) => {
    assert.strictEqual(pre.querySelectorAll('button.code-copy-btn').length, 1);
  });
  for (let i = 0; i < 3; i += 1) {
    preview = buildPreview(render(source));
    decorateCodeBlocks(preview);
    assert.strictEqual(buttonsIn(preview).length, 2);
  }

  const btn = buttonsIn(preview)[0];
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.textContent, 'Kopieer');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Code kopiëren');

  // Delegated click copies exactly the code (not the button label).
  const writes = [];
  const clipboard = { writeText: async (text) => { writes.push(text); } };
  const errors = [];
  assert.strictEqual(bindCodeCopy(preview, { clipboard, onError: (m) => errors.push(m) }), true);
  assert.strictEqual(bindCodeCopy(preview, { clipboard }), false, 'only one delegated listener');
  assert.strictEqual((preview.listeners.click || []).length, 1);
  let prevented = false;
  preview.listeners.click[0]({ target: btn, preventDefault() { prevented = true; }, stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.ok(prevented);
  assert.deepStrictEqual(writes, ['const a = "<b>" && 1;\nconsole.log(a);']);
  assert.ok(!writes[0].includes('Kopieer'));
  assert.strictEqual(btn.textContent, 'Gekopieerd');
  assert.deepStrictEqual(errors, []);
  clearTimeout(btn._codeCopyTimer);

  // Second block: whitespace kept exactly.
  const second = buttonsIn(preview)[1];
  assert.strictEqual(await copyCodeBlock(second, { clipboard }), true);
  assert.strictEqual(writes[1], 'plain   text');
  clearTimeout(second._codeCopyTimer);

  // Clipboard refused / missing: error shown, label unchanged, nothing written.
  const fresh = buildPreview(html);
  decorateCodeBlocks(fresh);
  const fbtn = buttonsIn(fresh)[0];
  const denied = { writeText: async () => { throw new Error('NotAllowedError'); } };
  assert.strictEqual(await copyCodeBlock(fbtn, { clipboard: denied, onError: (m) => errors.push(m) }), false);
  assert.strictEqual(await copyCodeBlock(fbtn, { clipboard: {}, onError: (m) => errors.push(m) }), false);
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(fbtn.textContent, 'Kopieer');

  // Label resets after ~2 s.
  const realSetTimeout = global.setTimeout;
  let delay = null;
  let resetFn = null;
  global.setTimeout = (fn, ms) => { resetFn = fn; delay = ms; return 0; };
  try {
    await copyCodeBlock(fbtn, { clipboard });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.strictEqual(delay, 2000);
  assert.strictEqual(fbtn.textContent, 'Gekopieerd');
  resetFn();
  assert.strictEqual(fbtn.textContent, 'Kopieer');

  // Sanitizer: a <button> in the markdown source is never rendered as an element.
  for (const src of [
    '<button onclick="alert(1)">x</button>',
    'Text <button class="code-copy-btn">Kopieer</button>',
    '```\n<button>in code</button>\n```',
    '> <BUTTON type=submit>q</BUTTON>',
  ]) {
    const out = render(src);
    assert.doesNotMatch(out, /<button/i, `button escaped for ${src}`);
    assert.match(out, /&lt;button/i, 'shown as escaped text');
  }

  // No inline handlers or innerHTML in the new client code.
  const previewJs = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
  const start = previewJs.indexOf('const CODE_COPY_LABEL');
  const end = previewJs.indexOf('function bindCodeCopy');
  const block = previewJs.slice(start, previewJs.indexOf('\n  }\n', end));
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|\.on[a-z]+\s*=/);

  const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
  assert.ok(appJs.includes('NotesPreview?.bindCodeCopy?.(ui.preview'));
  assert.ok(appJs.includes('NotesPreview?.decorateCodeBlocks?.(ui.preview)'));
  const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
  assert.match(css, /\.code-copy-btn\s*\{[^}]*inset-inline-end/);
  assert.match(css, /@media \(hover: none\)\s*\{\s*#preview \.code-copy-btn/);

  console.log('test_code_copy_button ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
