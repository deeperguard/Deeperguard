"""All XSS vectors from docs/design/rich-editor-tests.md in a real browser DOM.

Runs the full Markdown view pipeline exactly as the app does (vendored markdown-it ->
NotesMarkdown.renderRich -> NotesSanitize.sanitizeRichHtml with vendored DOMPurify -> innerHTML of
the preview element) and checks that no script runs, no dangerous element/attribute/URL ends up
in the DOM, no network request is made, and the sanitizer output is idempotent.

Skips when node, Playwright or a Chromium binary is missing.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
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
    const raw = NotesMarkdown.renderRich(v.md);
    const clean = NotesSanitize.sanitizeRichHtml(raw);
    if (typeof clean !== 'string') { failures.push(`#${v.id}: sanitizer unavailable`); continue; }
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
        if (n.startsWith('on') || n === 'style' || n === 'srcset' || n.includes(':')) failures.push(`#${v.id}: attr ${n}`);
        if (['href', 'action', 'formaction'].includes(n) && !new RegExp(C.href, 'i').test(attr.value)) failures.push(`#${v.id}: ${n}=${attr.value}`);
        if (n === 'src' && !(tag === 'img' && new RegExp(C.src, 'i').test(attr.value))) failures.push(`#${v.id}: src=${attr.value}`);
      }
      if (tag === 'a' && /^https?:/i.test(el.getAttribute('href') || '') && el.getAttribute('rel') !== 'noopener noreferrer') {
        failures.push(`#${v.id}: external link without rel`);
      }
    }
    if (v.text && !preview.textContent.includes(v.text)) failures.push(`#${v.id}: payload not visible as text`);
    for (const a of preview.querySelectorAll('a')) a.click();
  }
  await new Promise((r) => setTimeout(r, 50));
  if (window.__xss !== undefined) failures.push('window.__xss was set');
  if (window.__alerts.length) failures.push(`alert was called: ${window.__alerts.join(', ')}`);
  preview.innerHTML = '';
  return failures;
}
"""


def _chromium() -> str | None:
    for name in ("chromium", "chromium-browser", "google-chrome"):
        found = shutil.which(name)
        if found:
            return found
    return None


class RichXssVectorsBrowserTests(unittest.TestCase):
    def test_all_vectors_in_real_dom(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.skipTest("playwright is not installed")
        exe = os.environ.get("CHROMIUM_PATH") or _chromium()
        if not exe:
            self.skipTest("no chromium binary")

        dump = subprocess.run(
            [node, "-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))", str(ROOT / "tests" / "rich_xss_vectors.js")],
            check=True, capture_output=True, text=True,
        )
        data = json.loads(dump.stdout)
        sanitize_api = subprocess.run(
            [node, "-e", "const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.RICH_ALLOWED_TAGS))", str(JS / "sanitize.js")],
            check=True, capture_output=True, text=True,
        )
        checks = {
            "dangerous": data["DANGEROUS_SELECTOR"] if isinstance(data.get("DANGEROUS_SELECTOR"), str) else "script",
            "tags": json.loads(sanitize_api.stdout),
            "href": r"^(?:https?:\/\/|mailto:|#)",
            "src": r"^(?:blob:|data:image\/(?:png|jpeg|gif|webp)[;,])",
        }

        requests: list[str] = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe)
            try:
                page = browser.new_page()
                page.on("request", lambda req: requests.append(req.url))
                page.set_content('<!doctype html><html><body><div id="preview" class="preview"></div></body></html>')
                page.evaluate("window.__alerts=[];window.alert=(m)=>window.__alerts.push(`#${window.__current}: ${m}`);0")
                for script in SCRIPTS:
                    page.add_script_tag(content=script.read_text(encoding="utf-8"))
                failures = page.evaluate(CHECK, {"vectors": data["RENDER_VECTORS"], "C": checks})
            finally:
                browser.close()

        self.assertEqual(failures, [])
        external = [u for u in requests if not u.startswith(("about:", "data:"))]
        self.assertEqual(external, [], "rendering must not trigger network requests")


if __name__ == "__main__":
    unittest.main()
