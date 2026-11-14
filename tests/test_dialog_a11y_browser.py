"""Browser tests for the shared accessible dialog pattern (dialog-a11y.js).

Loads the real dialog markup from app/templates/app.html, the real app.css,
the real dialog-a11y.js and the real confirmAction() from app.js into
Chromium via Playwright, then checks focus trap, Escape = cancel, focus
restore, safe initial focus, busy guard and reduced motion at 390px and
1280px in light and dark theme. Skips when Playwright/Chromium is missing.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"
DIALOG_JS = ROOT / "app/static/js/dialog-a11y.js"

sync_api = pytest.importorskip("playwright.sync_api")


def _between(text: str, start: str, end: str) -> str:
    i = text.index(start)
    return text[i:text.index(end, i)]


FOLDER_MARKUP = _between(APP_HTML, '<div id="folder-prompt"', '<div id="confirm-dialog"')
CONFIRM_MARKUP = _between(APP_HTML, '<div id="confirm-dialog"', '<div id="ai-outbound-backdrop"')
BACKDROP_MARKUP = '<div id="confirm-backdrop" class="settings-backdrop" hidden></div>'
# The real confirmAction() from app.js (it delegates to DialogA11y.confirm).
CONFIRM_SRC = "function confirmAction(" + APP_JS.split("function confirmAction(", 1)[1].split(
    "NotesStore.setCsrf(", 1)[0]

PAGE = """<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head>
<body>
<main><button id="opener" class="btn">Delete note</button><button id="other" class="btn">Other</button></main>
{backdrop}{folder}{confirm}
</body></html>"""


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = pw.chromium.launch()
            except Exception as exc:  # Chromium not installed
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


def _open_page(browser, *, width=1280, theme="dark", reduced_motion="no-preference"):
    ctx = browser.new_context(viewport={"width": width, "height": 800}, reduced_motion=reduced_motion)
    page = ctx.new_page()
    page.set_content(PAGE.format(theme=theme, backdrop=BACKDROP_MARKUP, folder=FOLDER_MARKUP,
                                 confirm=CONFIRM_MARKUP))
    page.add_style_tag(path=str(APP_CSS))
    page.add_script_tag(path=str(DIALOG_JS))
    page.add_script_tag(content=CONFIRM_SRC + "\nwindow.confirmAction = confirmAction;")
    page.evaluate("""() => {
      window.confirmedRuns = 0;
      window.lastResult = 'pending';
      window.askDelete = () => {
        window.lastResult = 'pending';
        return confirmAction('Delete this note?', { title: 'Delete', confirmLabel: 'Delete', danger: true })
          .then((ok) => { window.lastResult = ok; if (ok === true) window.confirmedRuns += 1; });
      };
      document.getElementById('opener').addEventListener('click', () => window.askDelete());
    }""")
    return ctx, page


def _open_confirm(page):
    page.focus("#opener")
    page.keyboard.press("Enter")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    page.wait_for_function("document.activeElement && document.activeElement.id === 'confirm-cancel'")


def _result(page):
    page.wait_for_function("window.lastResult !== 'pending'")
    return page.evaluate("window.lastResult")


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_confirm_dialog_layout_and_aria(browser, tmp_path, width, theme):
    ctx, page = _open_page(browser, width=width, theme=theme)
    try:
        _open_confirm(page)
        dlg = page.locator("#confirm-dialog")
        assert dlg.get_attribute("role") == "dialog"
        assert dlg.get_attribute("aria-modal") == "true"
        assert dlg.get_attribute("aria-labelledby") == "confirm-title"
        assert page.locator("#confirm-close").get_attribute("aria-label")
        box = dlg.bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= width + 0.5
        # Centred horizontally and vertically.
        assert abs((box["x"] + box["width"] / 2) - width / 2) <= 2
        assert abs((box["y"] + box["height"] / 2) - 400) <= 2
        for sel in ("#confirm-close", "#confirm-cancel", "#confirm-ok"):
            b = page.locator(sel).bounding_box()
            assert b["height"] >= 44 and b["width"] >= 44, sel
        # Keyboard focus ring is visible on the focused button.
        outline = page.evaluate(
            "() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
        assert outline[0] != "none" and outline[1] != "0px"
        page.screenshot(path=str(tmp_path / f"confirm-{width}-{theme}.png"))
        page.keyboard.press("Escape")
        assert _result(page) is False
    finally:
        ctx.close()


def test_escape_cancels_and_never_confirms(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.keyboard.press("Escape")
        assert _result(page) is False
        assert page.evaluate("window.confirmedRuns") == 0
        assert page.evaluate("document.getElementById('confirm-dialog').hidden") is True
        # Short close transition, then it is gone.
        page.wait_for_selector("#confirm-dialog", state="hidden", timeout=1000)
    finally:
        ctx.close()


@pytest.mark.parametrize("how", ["#confirm-close", "#confirm-backdrop", "#confirm-cancel"])
def test_close_button_and_backdrop_cancel(browser, how):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.evaluate("(sel) => document.querySelector(sel).click()", how)
        assert _result(page) is False
        assert page.evaluate("window.confirmedRuns") == 0
    finally:
        ctx.close()


def test_confirm_button_confirms(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.click("#confirm-ok")
        assert _result(page) is True
        assert page.evaluate("window.confirmedRuns") == 1
    finally:
        ctx.close()


def test_destructive_button_never_gets_initial_focus(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.wait_for_timeout(50)
        assert page.evaluate("document.activeElement.id") == "confirm-cancel"
        assert "danger" in page.get_attribute("#confirm-ok", "class")
    finally:
        ctx.close()


def test_focus_trap_keeps_tab_inside(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        inside = page.evaluate("() => Array.from(document.querySelectorAll('#confirm-dialog button')).filter(b => !b.hidden).map(b => b.id)")
        seen = set()
        for _ in range(len(inside) * 2 + 1):
            page.keyboard.press("Tab")
            seen.add(page.evaluate("document.activeElement.id"))
        assert seen <= set(inside), seen
        assert seen == set(inside)
        for _ in range(len(inside) * 2 + 1):
            page.keyboard.press("Shift+Tab")
            assert page.evaluate("document.activeElement.closest('#confirm-dialog') !== null")
    finally:
        ctx.close()


def test_focus_returns_to_opener(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.keyboard.press("Escape")
        _result(page)
        page.wait_for_function("document.activeElement && document.activeElement.id === 'opener'")
        _open_confirm(page)
        page.click("#confirm-ok")
        _result(page)
        page.wait_for_function("document.activeElement && document.activeElement.id === 'opener'")
    finally:
        ctx.close()


def test_generic_dialog_trap_and_restore(browser):
    """Any role=dialog aria-modal element gets trap + restore, not just confirm."""
    ctx, page = _open_page(browser)
    try:
        page.focus("#other")
        page.evaluate("document.getElementById('folder-prompt').hidden = false")
        page.wait_for_function("document.activeElement && document.activeElement.id === 'folder-prompt-input'")
        for _ in range(6):
            page.keyboard.press("Tab")
            assert page.evaluate("document.activeElement.closest('#folder-prompt') !== null")
        page.evaluate("document.getElementById('folder-prompt').hidden = true")
        page.wait_for_function("document.activeElement && document.activeElement.id === 'other'")
    finally:
        ctx.close()


def test_escape_ignored_while_action_running(browser):
    ctx, page = _open_page(browser)
    try:
        _open_confirm(page)
        page.evaluate("DialogA11y.setBusy(document.getElementById('confirm-dialog'), true)")
        page.keyboard.press("Escape")
        page.click("#confirm-close")
        page.wait_for_timeout(50)
        assert page.evaluate("window.lastResult") == "pending"
        assert page.locator("#confirm-dialog").is_visible()
        page.evaluate("DialogA11y.setBusy(document.getElementById('confirm-dialog'), false)")
        page.keyboard.press("Escape")
        assert _result(page) is False
        assert page.evaluate("window.confirmedRuns") == 0
    finally:
        ctx.close()


@pytest.mark.parametrize("motion,expect_transition", [("reduce", False), ("no-preference", True)])
def test_transition_respects_reduced_motion(browser, motion, expect_transition):
    ctx, page = _open_page(browser, reduced_motion=motion)
    try:
        _open_confirm(page)
        durations = page.evaluate(
            "() => getComputedStyle(document.getElementById('confirm-dialog')).transitionDuration")
        secs = [float(d.strip().rstrip("s")) for d in durations.split(",")]
        if expect_transition:
            assert max(secs) > 0 and max(secs) <= 0.15
        else:
            assert max(secs) == 0
        page.keyboard.press("Escape")
        _result(page)
    finally:
        ctx.close()
