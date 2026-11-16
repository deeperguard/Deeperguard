"""Table editor grid and table view in real Chromium: keyboard, Markdown written back, sanitizing,
th scope and sideways scrolling at phone width. Pure parse/serialize cases: tests/test_table_editor.js."""
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
    JS / "table-editor.js",
]
CSS = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")

# Same wiring as app.js: the panel writes into the textarea; Escape/Done put the caret after the table.
HARNESS = """
window.__alerts = [];
window.alert = (m) => window.__alerts.push(m);
const ta = document.getElementById('body');
window.__undo = 0;
window.ctl = NotesTableEditor.createController({
  container: document.getElementById('table-editor'),
  getSource: () => ta.value,
  setSource: (next) => { ta.value = next; },
  beforeChange: () => { window.__undo += 1; },
  onClose: ({ focusSource, offset }) => {
    if (!focusSource) return;
    ta.focus();
    ta.setSelectionRange(offset, offset);
  },
});
"""


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


def _page(browser, theme="dark", width=900):
    ctx = browser.new_context(viewport={"width": width, "height": 700})
    page = ctx.new_page()
    page.route("**/*", lambda route: route.fulfill(
        status=200, content_type="text/html",
        body=f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8">'
             '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
             '<div id="table-editor" class="table-editor" role="group" aria-label="Table editor" hidden></div>'
             '<textarea id="body"></textarea><button id="after">after</button>'
             '<div id="preview" class="preview"></div></body></html>'))
    page.goto("http://localhost/")
    page.add_style_tag(content=CSS)
    for script in SCRIPTS:
        page.add_script_tag(content=script.read_text(encoding="utf-8"))
    page.evaluate(HARNESS)
    return page


def _body(page):
    return page.evaluate("document.getElementById('body').value")


def _focused(page):
    return page.evaluate(
        "(() => { const a = document.activeElement; return a && a.dataset.row !== undefined"
        " ? [Number(a.dataset.row), Number(a.dataset.col)] : (a && (a.id || a.dataset.tableAction)) })()")


def test_insert_and_edit_a_table_with_keyboard_only(browser):
    page = _page(browser)
    page.fill("#body", "Intro")
    page.evaluate("ctl.insertAt(5, 'n1')")
    assert page.is_visible("#table-editor")
    assert _focused(page) == [0, 0]
    assert _body(page) == "Intro\n\n| Column 1 | Column 2 |\n| --- | --- |\n| | |\n| | |\n"

    page.keyboard.type("Name")
    page.keyboard.press("Tab")
    assert _focused(page) == [0, 1]
    page.keyboard.type("Price | €")
    page.keyboard.press("Tab")
    assert _focused(page) == [1, 0], "Tab wraps to the first cell of the next row"
    page.keyboard.type("Tea")
    page.keyboard.press("Shift+Tab")
    assert _focused(page) == [0, 1]
    page.keyboard.press("Enter")
    assert _focused(page) == [1, 1], "Enter moves down"
    page.keyboard.type("C:\\tea\\")
    page.keyboard.press("ArrowDown")
    assert _focused(page) == [2, 1]
    page.keyboard.press("ArrowUp")
    assert _focused(page) == [1, 1]
    assert _body(page) == (
        "Intro\n\n| Name | Price \\| € |\n| --- | --- |\n| Tea | C:\\tea\\ |\n| | |\n")

    # Toolbar buttons are reachable and usable with the keyboard; the label tells where focus is.
    page.focus('[data-table-action="column-right"]')
    page.keyboard.press("Enter")
    assert _focused(page) == [1, 2]
    page.keyboard.type("in stock")
    page.focus('[data-table-action="align-right"]')
    page.keyboard.press("Space")
    assert page.get_attribute('[data-table-action="align-right"]', "aria-pressed") == "true"
    page.focus('[data-table-action="row-below"]')
    page.keyboard.press("Enter")
    assert _focused(page) == [2, 2]
    page.keyboard.type("new")
    assert page.text_content(".table-editor-pos") == "Row 2, column 3"
    assert _body(page) == (
        "Intro\n\n| Name | Price \\| € | |\n| --- | --- | ---: |\n| Tea | C:\\tea\\ | in stock |\n"
        "| | | new |\n| | | |\n")

    page.focus('[data-row="3"][data-col="0"]')
    page.click('[data-table-action="delete-row"]')
    page.focus('[data-row="0"][data-col="1"]')
    page.click('[data-table-action="delete-column"]')
    assert _body(page) == "Intro\n\n| Name | |\n| --- | ---: |\n| Tea | in stock |\n| | new |\n"
    assert page.is_disabled('[data-table-action="delete-row"]'), "header row cannot be deleted"
    page.click('[data-table-action="delete-column"]')
    assert page.is_disabled('[data-table-action="delete-column"]'), "the last column stays"
    assert _body(page) == "Intro\n\n| Name |\n| --- |\n| Tea |\n| |\n"
    assert page.evaluate("window.__undo") >= 9, "every edit is its own undo step"

    page.keyboard.press("Escape")
    assert page.is_hidden("#table-editor")
    assert page.evaluate("document.activeElement.id") == "body"
    assert page.evaluate("document.getElementById('body').selectionStart") == len("Intro\n\n| Name |\n| --- |\n| Tea |\n| |")
    assert page.evaluate("document.getElementById('table-editor').children.length") == 0


def test_tab_past_the_last_cell_leaves_the_grid(browser):
    page = _page(browser)
    page.fill("#body", "| a |\n|---|\n| 1 |")
    assert page.evaluate("ctl.openAt(0, 'n')") is True
    page.focus('[data-row="1"][data-col="0"]')
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.id") == "body", "no keyboard trap"


def test_open_and_close_without_change_keeps_bytes(browser):
    page = _page(browser)
    # (A textarea stores line ends as LF; CRLF round-trip is covered in tests/test_table_editor.js.)
    src = "x\n\n| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |  \n\ny"
    page.evaluate("(s) => { document.getElementById('body').value = s; }", src)
    assert page.evaluate("ctl.openAt(5, 'n')") is True
    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    page.click('[data-table-action="done"]')
    assert _body(page) == src
    assert page.evaluate("window.__undo") == 0


def test_cell_with_markdown_escape_keeps_its_meaning(browser):
    page = _page(browser)
    page.fill("#body", "| a | b |\n|---|---|\n| \\* | \\\\| |")
    page.evaluate("ctl.openAt(0, 'n')")
    assert page.input_value('[data-row="1"][data-col="0"]') == "\\*"
    assert page.input_value('[data-row="1"][data-col="1"]') == "\\|"
    page.focus('[data-row="1"][data-col="0"]')
    page.keyboard.press("End")
    page.keyboard.type("x")
    page.focus('[data-row="1"][data-col="1"]')
    page.keyboard.press("End")
    page.keyboard.type("y")
    assert _body(page) == "| a | b |\n|---|---|\n| \\*x | \\\\|y |"
    page.evaluate("document.getElementById('preview').innerHTML = NotesMarkdown.render(document.getElementById('body').value)")
    assert page.evaluate("[...document.querySelectorAll('#preview td')].map(td => td.textContent)") == ["*x", "|y"]


def test_outside_change_closes_without_writing(browser):
    page = _page(browser)
    page.fill("#body", "| a |\n|---|\n| 1 |")
    page.evaluate("ctl.openAt(0, 'n')")
    page.evaluate("document.getElementById('body').value = 'replaced elsewhere'")
    page.focus('[data-row="1"][data-col="0"]')
    page.keyboard.type("z")
    assert _body(page) == "replaced elsewhere"
    assert page.is_hidden("#table-editor")


def test_typed_html_is_inert_in_editor_and_view(browser):
    page = _page(browser)
    page.fill("#body", "| h |\n|---|\n| c |")
    page.evaluate("ctl.openAt(0, 'n')")
    payload = '<img src=x onerror=alert(1)><script>alert(2)</script><iframe src="javascript:alert(3)"></iframe>[l](javascript:alert(4))'
    page.fill('[data-row="0"][data-col="0"]', payload)
    page.fill('[data-row="1"][data-col="0"]', payload)
    assert page.evaluate("document.querySelectorAll('#table-editor img, #table-editor script, #table-editor iframe').length") == 0
    page.evaluate("document.getElementById('preview').innerHTML = NotesMarkdown.render(document.getElementById('body').value)")
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelectorAll('#preview img, #preview script, #preview iframe, #preview a').length") == 0
    assert page.evaluate("[...document.querySelectorAll('#preview th, #preview td')].map(c => c.textContent)") == [
        '<img src=x onerror=alert(1)><script>alert(2)</script><iframe src="javascript:alert(3)"></iframe>[l](javascript:alert(4))'] * 2
    assert page.evaluate("window.__alerts") == []


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_view_has_header_scope_and_scrolls_sideways_on_phone(browser, theme):
    page = _page(browser, theme=theme, width=375)
    wide = " | ".join(f"Column number {i}" for i in range(8))
    md = f"| {wide} |\n|{'---|' * 8}\n|{' long cell value |' * 8}"
    page.evaluate("(md) => { document.getElementById('preview').innerHTML = NotesMarkdown.render(md); }", md)
    assert page.evaluate("[...document.querySelectorAll('#preview th')].every(th => th.getAttribute('scope') === 'col')")
    assert page.evaluate("document.querySelectorAll('#preview th').length") == 8
    wrap = page.evaluate("""(() => { const w = document.querySelector('#preview .md-table-wrap');
      return { sw: w.scrollWidth, cw: w.clientWidth, ox: getComputedStyle(w).overflowX }; })()""")
    assert wrap["ox"] == "auto" and wrap["sw"] > wrap["cw"], wrap
    assert page.evaluate("document.documentElement.scrollWidth") <= 375, "only the table scrolls, not the page"


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_editor_grid_scrolls_on_phone_and_shows_focus(browser, theme):
    page = _page(browser, theme=theme, width=375)
    page.fill("#body", "| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |")
    page.evaluate("ctl.openAt(0, 'n')")
    page.keyboard.press("Tab")
    grid = page.evaluate("""(() => { const w = document.querySelector('.table-editor-scroll');
      return { sw: w.scrollWidth, cw: w.clientWidth }; })()""")
    assert grid["sw"] > grid["cw"]
    assert page.evaluate("document.documentElement.scrollWidth") <= 375
    outline = page.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    assert outline not in ("none", ""), outline
    colors = page.evaluate("""(() => { const s = getComputedStyle(document.activeElement);
      return [s.color, getComputedStyle(document.querySelector('.table-editor')).backgroundColor]; })()""")
    assert colors[0] != colors[1]
