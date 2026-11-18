"""Chromium test: the 'recovery key used' notice shows date/time and advice, and is
dismissed per device with the mouse or the keyboard. Skips without Chromium."""
from __future__ import annotations

from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

STATIC = Path(__file__).resolve().parents[1] / "app" / "static"
CSS = (STATIC / "css" / "app.css").read_text(encoding="utf-8")
JS = (STATIC / "js" / "recovery-notice.js").read_text(encoding="utf-8")

# 2026-11-19 10:30:00 UTC
CREATED = 1795084200

HARNESS = """
  window.calls = [];
  window.server = [{ id: 7, kind: 'recovery_key_used', created_at: %d }];
  window.fakeApi = async (path, opts = {}) => {
    window.calls.push((opts.method || 'GET') + ' ' + path);
    if (path.endsWith('/dismiss')) {
      const id = Number(path.split('/').slice(-2)[0]);
      window.server = window.server.filter((n) => n.id !== id);
      return { ok: true };
    }
    return { notices: window.server };
  };
""" % CREATED


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as pw:
        try:
            br = pw.chromium.launch()
        except Exception as exc:
            pytest.skip(f"Chromium not available: {exc}")
        yield br
        br.close()


def _open(browser, width=1280, scheme="light"):
    ctx = browser.new_context(
        viewport={"width": width, "height": 700}, color_scheme=scheme, locale="en-GB", timezone_id="UTC",
    )
    page = ctx.new_page()
    page.set_content(
        '<!doctype html><html><head><meta charset="utf-8"></head><body>'
        '<div id="recovery-notice" class="recovery-notice" hidden role="status" aria-live="polite"></div>'
        "<main>notes</main></body></html>"
    )
    page.add_style_tag(content=CSS)
    page.add_script_tag(content=HARNESS)
    page.add_script_tag(content=JS)
    page.evaluate("() => NotesRecoveryNotice.refresh(window.fakeApi, document.getElementById('recovery-notice'))")
    return page


def test_notice_shows_date_time_and_advice_and_can_be_clicked_away(browser):
    page = _open(browser)
    box = page.locator("#recovery-notice")
    box.wait_for(state="visible")
    text = box.inner_text()
    assert "recovery key was used" in text
    assert "19 Nov 2026" in text and "10:30" in text
    assert "If this was not you, change your password now." in text
    page.get_by_role("button", name="Dismiss").click()
    box.wait_for(state="hidden")
    assert page.evaluate("window.calls") == [
        "GET /api/account/vault-recovery-notices",
        "POST /api/account/vault-recovery-notices/7/dismiss",
        "GET /api/account/vault-recovery-notices",
    ]
    # The next start/sync finds nothing left to show.
    page.evaluate("() => NotesRecoveryNotice.refresh(window.fakeApi, document.getElementById('recovery-notice'))")
    page.wait_for_function("window.calls.length === 4")
    assert page.locator("#recovery-notice").is_hidden()


def test_dismiss_works_with_the_keyboard_and_shows_a_focus_ring(browser):
    page = _open(browser, width=390, scheme="dark")
    page.locator("#recovery-notice").wait_for(state="visible")
    page.keyboard.press("Tab")
    btn = page.get_by_role("button", name="Dismiss")
    assert page.evaluate("document.activeElement.classList.contains('recovery-notice-dismiss')")
    assert page.evaluate("getComputedStyle(document.activeElement).outlineStyle") != "none"
    assert btn.get_attribute("aria-label").startswith("Dismiss: Your recovery key was used")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.keyboard.press("Enter")
    page.locator("#recovery-notice").wait_for(state="hidden")


def test_failed_dismiss_keeps_the_notice(browser):
    page = _open(browser)
    page.locator("#recovery-notice").wait_for(state="visible")
    page.evaluate(
        "() => NotesRecoveryNotice.refresh(async (p, o = {}) => {"
        " if (o.method === 'POST') throw new Error('offline');"
        " return { notices: window.server }; }, document.getElementById('recovery-notice'))"
    )
    page.get_by_role("button", name="Dismiss").click()
    page.wait_for_timeout(200)
    assert page.locator("#recovery-notice").is_visible()
