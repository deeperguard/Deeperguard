"""Browser tests for the password step of the shared confirm dialog.

Uses the real markup from app/templates/app.html, the real app.css and the
real dialog-a11y.js. The readable export passes
`verifyPassword: NotesStore.verifyVaultPassword`; here a stub with a known
password stands in for it. Docs: docs/IMPORT_EXPORT_SPEC.md section 5.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"
DIALOG_JS = ROOT / "app/static/js/dialog-a11y.js"

sync_api = pytest.importorskip("playwright.sync_api")

_start = APP_HTML.index('<div id="confirm-dialog"')
CONFIRM_MARKUP = APP_HTML[_start:APP_HTML.index('<div id="ai-outbound-backdrop"', _start)]
BACKDROP = '<div id="confirm-backdrop" class="settings-backdrop" hidden></div>'
PAGE = '<!doctype html><html data-theme="dark"><body><main></main>' + BACKDROP + CONFIRM_MARKUP + "</body></html>"


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


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 800})
    pg = ctx.new_page()
    pg.set_content(PAGE)
    pg.add_style_tag(path=str(APP_CSS))
    pg.add_script_tag(path=str(DIALOG_JS))
    pg.evaluate("""() => {
      window.exports = 0;
      window.checked = [];
      window.result = 'pending';
      window.ask = () => {
        window.result = 'pending';
        return DialogA11y.confirm('Export?', {
          title: 'Export', confirmLabel: 'Export', danger: true,
          verifyPassword: async (typed) => { window.checked.push(typed); return typed === 'correct horse'; },
        }).then((ok) => { window.result = ok; if (ok === true) window.exports += 1; });
      };
      window.ask();
    }""")
    pg.wait_for_selector("#confirm-password-wrap:not([hidden])")
    yield pg
    ctx.close()


def _result(page):
    page.wait_for_function("window.result !== 'pending'")
    return page.evaluate("window.result")


def test_correct_password_confirms_and_clears_field(page):
    page.fill("#confirm-password", "correct horse")
    page.click("#confirm-ok")
    assert _result(page) is True
    assert page.evaluate("window.exports") == 1
    assert page.input_value("#confirm-password") == ""
    assert page.evaluate("document.getElementById('confirm-password-wrap').hidden") is True


def test_wrong_password_shows_error_and_does_not_confirm(page):
    page.fill("#confirm-password", "nope")
    page.click("#confirm-ok")
    page.wait_for_selector("#confirm-password-error:not([hidden])")
    assert "Wrong password" in page.inner_text("#confirm-password-error")
    assert page.evaluate("window.result") == "pending"
    assert page.evaluate("window.exports") == 0
    assert page.input_value("#confirm-password") == ""
    # The dialog stays usable: the right password afterwards passes.
    page.fill("#confirm-password", "correct horse")
    page.keyboard.press("Enter")
    assert _result(page) is True


def test_wrong_password_message_comes_from_caller(page):
    page.keyboard.press("Escape")
    _result(page)
    page.evaluate("""() => {
      window.result = 'pending';
      DialogA11y.confirm('Export?', {
        verifyPassword: async () => false,
        wrongPasswordMessage: 'Custom failure text.',
      }).then((v) => { window.result = v; });
    }""")
    page.wait_for_selector("#confirm-password-wrap:not([hidden])")
    page.fill("#confirm-password", "bad")
    page.click("#confirm-ok")
    page.wait_for_selector("#confirm-password-error:not([hidden])")
    assert page.inner_text("#confirm-password-error") == "Custom failure text."


def test_wrong_password_default_message_is_generic(page):
    page.fill("#confirm-password", "nope")
    page.click("#confirm-ok")
    page.wait_for_selector("#confirm-password-error:not([hidden])")
    assert page.inner_text("#confirm-password-error") == "Wrong password."


def test_empty_password_never_confirms(page):
    page.click("#confirm-ok")
    page.wait_for_selector("#confirm-password-error:not([hidden])")
    assert page.evaluate("window.exports") == 0


def test_three_wrong_attempts_close_dialog_without_export(page):
    for n in range(3):
        if n:
            page.wait_for_function("!document.getElementById('confirm-dialog').hasAttribute('aria-busy')")
        page.fill("#confirm-password", "bad")
        page.click("#confirm-ok")
    assert _result(page) is False
    assert page.evaluate("window.exports") == 0
    assert page.evaluate("document.getElementById('confirm-dialog').hidden") is True
    assert page.input_value("#confirm-password") == ""


def test_cancel_clears_typed_password(page):
    page.fill("#confirm-password", "correct horse")
    page.keyboard.press("Escape")
    assert _result(page) is False
    assert page.input_value("#confirm-password") == ""
    assert page.evaluate("window.exports") == 0


def test_plain_confirm_has_no_password_field(page):
    page.keyboard.press("Escape")
    _result(page)
    page.evaluate("() => { window.result = 'pending'; DialogA11y.confirm('Sure?').then((v) => { window.result = v; }); }")
    page.wait_for_selector("#confirm-dialog:not([hidden])")
    assert page.evaluate("document.getElementById('confirm-password-wrap').hidden") is True
    page.click("#confirm-ok")
    assert _result(page) is True
