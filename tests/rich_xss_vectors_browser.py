"""All XSS vectors from docs/design/rich-editor-tests.md in a real browser DOM.

Runs the Markdown view pipeline exactly as the app does (vendored markdown-it ->
NotesMarkdown.render, which sanitizes with vendored DOMPurify -> innerHTML of the preview element)
and checks that no script runs, no dangerous element/attribute/URL ends up in the DOM, no network
request is made, and the sanitizer output is idempotent.

Called by tests/test_rich_xss_vectors.js. Exit 0 = pass, 1 = failures, 77 = prerequisite missing
(node, Playwright or Chromium).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "app" / "static" / "js"
SCRIPTS = [
    JS / "vendor" / "dompurify" / "purify.min.js",
    JS / "vendor" / "markdown-it" / "markdown-it.min.js",
    JS / "sanitize.js",
    JS / "markdown.js",
]

CHECK = r"""
async ({ vectors, C }) => {
  const preview = document.getElementById('preview');
  const failures = [];
  for (const v of vectors) {
    window.__current = v.id;
    const clean = NotesMarkdown.render(v.md);
    if (NotesSanitize.sanitizeRichHtml(clean) !== clean) failures.push(`#${v.id}: sanitizer not idempotent`);
    preview.innerHTML = clean;
    // Re-parse round (mXSS): serialise and assign again.
    preview.innerHTML = preview.innerHTML;
    await new Promise((r) => setTimeout(r, 0));
    if (preview.querySelector(C.dangerous)) failures.push(`#${v.id}: dangerous element`);
    for (const el of preview.querySelectorAll('*')) {
      const tag = el.localName;
      if (!C.tags.includes(tag)) failures.push(`#${v.id}: tag ${tag}`);
      for (const attr of el.attributes) {
        const n = attr.name.toLowerCase();
        if (n.startsWith('on') || n === 'srcset' || n.includes(':')) failures.push(`#${v.id}: attr ${n}`);
        // The only style the renderer may produce is the fixed table alignment.
        if (n === 'style' && !(['th', 'td'].includes(tag) && /^text-align:(left|center|right)$/.test(attr.value))) {
          failures.push(`#${v.id}: style=${attr.value}`);
        }
        if (['href', 'action', 'formaction'].includes(n) && !new RegExp(C.href, 'i').test(attr.value)) failures.push(`#${v.id}: ${n}=${attr.value}`);
        if (n === 'src' && !(tag === 'img' && new RegExp(C.src, 'i').test(attr.value))) failures.push(`#${v.id}: src=${attr.value}`);
      }
      if (tag === 'a' && /^https?:/i.test(el.getAttribute('href') || '') && el.getAttribute('rel') !== 'noopener noreferrer') {
        failures.push(`#${v.id}: external link without rel`);
      }
    }
    if (v.text && !preview.textContent.includes(v.text)) failures.push(`#${v.id}: payload not visible as text`);
    if (v.table && preview.querySelectorAll('table th').length !== v.table) failures.push(`#${v.id}: table structure lost`);
    if (v.strong && ![...preview.querySelectorAll('strong')].some((s) => s.textContent === v.strong)) failures.push(`#${v.id}: <strong> lost`);
    for (const a of preview.querySelectorAll('a')) a.click();
  }
  await new Promise((r) => setTimeout(r, 50));
  if (window.__xss !== undefined) failures.push('window.__xss was set');
  if (window.__alerts.length) failures.push(`alert was called: ${window.__alerts.join(', ')}`);

  // Behaviour the view keeps from the old renderer.
  preview.innerHTML = NotesMarkdown.render([
    '# عنوان', '', 'a', '', '', 'b', '', '- [ ] one', '- [x] two', '', '> quote', '',
    '| l | r |', '|:--|--:|', '| 1 | 2 |', '', '```js', 'let a = "<b>";', '```',
    '', '![](data:image/png;base64,iVBORw0KGgo=)', '', 'See http://example.com/x.',
  ].join('\n'));
  const q = (s) => preview.querySelector(s);
  if (q('h1')?.getAttribute('dir') !== 'auto') failures.push('heading lacks dir=auto');
  if (q('blockquote')?.getAttribute('dir') !== 'auto') failures.push('blockquote lacks dir=auto');
  if (q('li')?.getAttribute('dir') !== 'auto') failures.push('list item lacks dir=auto');
  if (q('th')?.style.textAlign !== 'left' || preview.querySelectorAll('th')[1].style.textAlign !== 'right') failures.push('table alignment lost');
  if (!q('div.md-table-wrap > table')) failures.push('table wrapper lost');
  if (preview.querySelectorAll('p > br:only-child').length !== 1) failures.push('extra blank line not kept');
  if (preview.querySelectorAll('li.task button.task-toggle').length !== 2) failures.push('task toggles lost');
  if (q('li.task.done button')?.dataset.checked !== '1' || q('li.task.done button').getAttribute('aria-checked') !== 'true') failures.push('done task not marked');
  const pre = q('pre.code-preview');
  if (!pre || pre.dir !== 'ltr' || pre.dataset.lang !== 'js') failures.push('code block lost its markup');
  if (pre && pre.querySelector('code').textContent.trim() !== 'let a = "<b>";') failures.push('code source changed');
  if (q('img')?.getAttribute('src') !== 'data:image/png;base64,iVBORw0KGgo=') failures.push('attachment image dropped');
  if (q('a[href="http://example.com/x"]')?.getAttribute('target') !== '_blank') failures.push('autolink missing');
  preview.innerHTML = '';
  return failures;
}
"""


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("node is not installed")
        return 77
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed")
        return 77

    def dump(expr: str, module: Path):
        out = subprocess.run(
            [node, "-e", f"process.stdout.write(JSON.stringify({expr}))", str(module)],
            check=True, capture_output=True, text=True,
        )
        return json.loads(out.stdout)

    data = dump("(()=>{const m=require(process.argv[1]);return {v:m.RENDER_VECTORS,d:m.DANGEROUS_SELECTOR,h:m.ALLOWED_HREF.source,s:m.ALLOWED_SRC.source}})()", ROOT / "tests" / "rich_xss_vectors.js")
    checks = {
        "dangerous": data["d"],
        "tags": dump("require(process.argv[1]).RICH_ALLOWED_TAGS", JS / "sanitize.js"),
        "href": data["h"],
        "src": data["s"],
    }

    requests: list[str] = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:  # no Chromium binary
            print(f"chromium cannot start: {exc}")
            return 77
        try:
            page = browser.new_page()
            page.on("request", lambda req: requests.append(req.url))
            page.set_content('<!doctype html><html><body><div id="preview"></div></body></html>')
            page.evaluate("window.__alerts=[];window.alert=(m)=>window.__alerts.push(`#${window.__current}: ${m}`);0")
            for script in SCRIPTS:
                page.add_script_tag(content=script.read_text(encoding="utf-8"))
            failures = page.evaluate(CHECK, {"vectors": data["v"], "C": checks})
        finally:
            browser.close()

    external = [u for u in requests if not u.startswith(("about:", "data:"))]
    if external:
        failures.append(f"rendering made network requests: {external}")
    if failures:
        print("\n".join(failures))
        return 1
    print(f"real DOM: {len(data['v'])} vectors ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
