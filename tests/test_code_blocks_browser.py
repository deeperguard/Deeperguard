"""Fenced code blocks in the Markdown view: colouring, copy button, XSS, contrast (real Chromium)."""
from __future__ import annotations

from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "app" / "static" / "js"
SCRIPTS = [
    JS / "vendor" / "dompurify" / "purify.min.js",
    JS / "vendor" / "markdown-it" / "markdown-it.min.js",
    JS / "vendor" / "highlightjs" / "highlight.min.js",
    JS / "sanitize.js",
    JS / "markdown.js",
    JS / "preview.js",
]
CSS = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")

CODE = 'const a = "x < y"; // note\n  indented();\n\n\ttabbed </code> &amp;'


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


def _page(browser, theme="dark"):
    ctx = browser.new_context(viewport={"width": 800, "height": 600})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="http://localhost")
    page = ctx.new_page()
    page.route("**/*", lambda route: route.fulfill(
        status=200, content_type="text/html",
        body=f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head>'
             '<body><div id="preview"></div></body></html>'))
    page.goto("http://localhost/")
    page.add_style_tag(content=CSS)
    page.evaluate("window.__alerts=[];window.alert=(m)=>window.__alerts.push(m);0")
    for script in SCRIPTS:
        page.add_script_tag(content=script.read_text(encoding="utf-8"))
    return page


def _show(page, md):
    page.evaluate(
        """(md) => {
          const p = document.getElementById('preview');
          p.innerHTML = NotesMarkdown.render(md);
          NotesPreview.decorateCodeBlocks(p);
          NotesPreview.bindCodeCopy(p);
        }""", md)


def test_js_block_is_coloured_and_sanitized(browser):
    page = _page(browser)
    _show(page, "```js\nconst a = 1; // hi\n```")
    kinds = page.evaluate("[...document.querySelectorAll('#preview pre code span')].map(s => s.className)")
    assert "hljs-keyword" in kinds and "hljs-number" in kinds and "hljs-comment" in kinds
    assert page.evaluate("document.querySelector('#preview pre code').textContent") == "const a = 1; // hi"


def test_unknown_language_is_not_coloured_by_hljs_and_does_not_fail(browser):
    page = _page(browser)
    _show(page, "```nosuchlang\nplain text\n```")
    assert page.evaluate("document.querySelectorAll('#preview .hljs-keyword').length") == 0
    assert page.evaluate("document.querySelector('#preview pre code').textContent") == "plain text"


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_token_colours_have_aa_contrast(browser, theme):
    page = _page(browser, theme)
    _show(page, "```js\nconst s = 'str'; // c\nfunction f(a) { return 42 + a.b; }\n```\n\n"
                "```python\nclass A:\n    def f(self): return None\n```\n\n"
                "```html\n<div id=\"a\">x</div>\n```\n\n```diff\n+ a\n- b\n```")
    worst = page.evaluate(
        """() => {
          const cv = document.createElement('canvas'); cv.width = cv.height = 1;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          const rgb = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const out = {}; let n = 0;
          for (const span of document.querySelectorAll('#preview pre code span[class^="hljs-"]')) {
            const pre = span.closest('pre');
            const a = lum(rgb(getComputedStyle(span).color)); const b = lum(rgb(getComputedStyle(pre).backgroundColor));
            out[span.className] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); n += 1;
          }
          return { n, out };
        }""")
    assert worst["n"] >= 8
    low = {k: v for k, v in worst["out"].items() if v < 4.5}
    assert not low, f"contrast below AA in {theme}: {low}"
    colours = page.evaluate(
        "[...new Set([...document.querySelectorAll('#preview code span[class^=hljs-]')].map(s => getComputedStyle(s).color))].length")
    assert colours >= 3  # actually coloured, not all inherited text colour


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_copy_button_keyboard_copies_exact_raw_code_and_announces(browser, theme):
    page = _page(browser, theme)
    fence = f"```js\n{CODE}\n```"
    _show(page, fence)
    btn = page.locator("#preview pre button.code-copy-btn")
    assert btn.count() == 1
    assert btn.get_attribute("type") == "button"
    assert btn.get_attribute("aria-label")
    status = page.locator("#preview pre [aria-live=polite]")
    assert status.count() == 1 and status.inner_text() == ""
    btn.focus()
    page.keyboard.press("Enter")
    page.wait_for_function("document.querySelector('#preview .code-copy-status').textContent === 'Gekopieerd'")
    assert page.evaluate("navigator.clipboard.readText()") == CODE
    assert btn.inner_text() == "Gekopieerd"
    # Second copy of the same block works and is announced again.
    page.evaluate("navigator.clipboard.writeText('other')")
    btn.focus()
    page.keyboard.press("Space")
    page.wait_for_function("document.querySelector('#preview .code-copy-status').textContent === 'Gekopieerd'")
    assert page.evaluate("navigator.clipboard.readText()") == CODE


def test_copy_failure_does_not_claim_success(browser):
    page = _page(browser)
    _show(page, "```js\nlet a = 1;\n```")
    page.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } })")
    page.locator("#preview button.code-copy-btn").click()
    page.wait_for_timeout(150)
    assert page.locator("#preview .code-copy-status").inner_text() == ""
    assert page.locator("#preview button.code-copy-btn").inner_text() != "Gekopieerd"


def test_each_block_gets_its_own_button_and_copies_its_own_code(browser):
    page = _page(browser)
    _show(page, "```js\nlet one;\n```\n\ntext\n\n```python\ntwo = 2\n```")
    assert page.locator("#preview button.code-copy-btn").count() == 2
    page.locator("#preview button.code-copy-btn").nth(1).click()
    page.wait_for_function("document.querySelectorAll('#preview .code-copy-status')[1].textContent === 'Gekopieerd'")
    assert page.evaluate("navigator.clipboard.readText()") == "two = 2"
    assert page.locator("#preview .code-copy-status").nth(0).inner_text() == ""


MALICIOUS = [
    # language name
    '```js"><img src=x onerror=window.__xss=1>\nlet a;\n```',
    "```<script>window.__xss=1</script>\nlet a;\n```",
    "```js onmouseover=window.__xss=1\nlet a;\n```",
    "```javascript\" onclick=\"window.__xss=1\nlet a;\n```",
    # code text, with and without a known language
    '```js\n"><img src=x onerror=window.__xss=1><script>window.__xss=1</script>\n```',
    '```html\n<img src=x onerror=window.__xss=1><svg onload=window.__xss=1>\n```',
    '```xml\n<![CDATA[</code></pre><img src=x onerror=window.__xss=1>]]>\n```',
    '```\n</code></pre><script>window.__xss=1</script>\n```',
    "```python\nx = '</span><img src=x onerror=window.__xss=1>'\n```",
]


@pytest.mark.parametrize("md", MALICIOUS)
def test_malicious_language_or_code_executes_nothing(browser, md):
    page = _page(browser)
    _show(page, md)
    if page.locator("#preview pre button").count():
        page.locator("#preview pre button.code-copy-btn").first.click()
    page.wait_for_timeout(100)
    assert page.evaluate("window.__xss") is None
    assert page.evaluate("window.__alerts.length") == 0
    assert page.evaluate("document.querySelectorAll('#preview script, #preview img, #preview svg, #preview iframe').length") == 0
    bad = page.evaluate(
        "[...document.querySelectorAll('#preview *')].flatMap(e => [...e.attributes].map(a => a.name).filter(n => n.startsWith('on')))")
    assert bad == []
    # Only <pre>, <code>, <span class=hljs-*> and our own button/status live inside the block.
    inner = page.evaluate(
        "[...document.querySelectorAll('#preview pre *')].map(e => e.localName + '.' + e.className)")
    assert all(i.split('.')[0] in ("code", "span", "button") for i in inner), inner
    assert all(not i.startswith("span.") or i.split(".", 1)[1].split()[0].startswith(("hljs-", "sr-only")) for i in inner), inner


def test_xss_payload_is_shown_and_copied_as_plain_text(browser):
    page = _page(browser)
    payload = '<img src=x onerror=window.__xss=1>'
    _show(page, f"```html\n{payload}\n```")
    assert payload in page.evaluate("document.querySelector('#preview pre code').textContent")
    page.locator("#preview button.code-copy-btn").click()
    page.wait_for_function("document.querySelector('#preview .code-copy-status').textContent === 'Gekopieerd'")
    assert page.evaluate("navigator.clipboard.readText()") == payload
