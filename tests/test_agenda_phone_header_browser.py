"""Real-app Chromium test: phone agenda header (today button with day number, + button).

The today button shows today's day number and picks today; the + button opens a new event on the
picked day; menu sits left, month title centered, actions right. Skips without Chromium.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "HeadPass1x!abcd"


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-phone-head-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
            ctx.add_init_script(
                "(() => { const R = Date; const off = new R(2026, 10, 20, 12).getTime() - R.now();"
                " class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); }"
                " static now() { return R.now() + off; } } window.Date = D; })();")
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "head@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-root", state="visible", timeout=30_000)
            if page.locator("#agenda-root .agenda-month-grid").count() == 0:
                toggle = page.locator('[data-agenda-view="month"]').locator("visible=true")
                if not toggle.count():
                    page.wait_for_selector("#agenda-phone-more", state="visible", timeout=30_000)
                    page.click("#agenda-phone-more")
                    page.wait_for_selector("#agenda-phone-menu", state="visible")
                toggle.first.click()
            page.wait_for_selector("#agenda-root .agenda-month-grid", timeout=30_000)
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _ts(page, y, m, d):
    return page.evaluate("([y, m, d]) => String(new Date(y, m - 1, d).getTime())", [y, m, d])


def test_today_button_shows_day_number_and_picks_today(session):
    page = session
    page.click('[data-agenda-month-pick="%s"]' % _ts(page, 2026, 11, 5))
    page.click("#agenda-next")
    btn = page.locator("#agenda-today")
    assert btn.locator("text.agenda-today-num").text_content() == "20"
    assert btn.get_attribute("aria-label").startswith("Go to today, ")
    btn.click()
    assert page.evaluate("() => NotesAgenda._state.monthPickDay") == int(_ts(page, 2026, 11, 20))
    assert page.evaluate("() => NotesAgenda._state.anchor.getMonth()") == 10
    pressed = page.locator('#agenda-root [aria-pressed="true"]').get_attribute("data-agenda-month-pick")
    assert pressed == _ts(page, 2026, 11, 20)


def test_add_button_opens_editor_on_picked_day(session):
    page = session
    page.click('[data-agenda-month-pick="%s"]' % _ts(page, 2026, 11, 12))
    add = page.locator("#agenda-phone-add-event")
    assert "12" in add.get_attribute("aria-label")
    add.click()
    page.wait_for_selector("#agenda-edit-start", state="visible")
    assert page.input_value("#agenda-edit-start").startswith("2026-11-12T")


def test_header_layout_menu_left_title_centered_actions_right(session):
    page = session
    page.keyboard.press("Escape")
    box = page.evaluate(
        "() => { const r = (s) => document.querySelector(s).getBoundingClientRect();"
        " return { menu: r('#agenda-phone-more'), title: r('.agenda-top-phone .agenda-title-primary'),"
        " today: r('#agenda-today'), add: r('#agenda-phone-add-event'), w: window.innerWidth }; }")
    mid = box["title"]["left"] + box["title"]["width"] / 2
    assert box["menu"]["right"] < box["title"]["left"]
    assert abs(mid - box["w"] / 2) < 40
    assert box["today"]["left"] > box["title"]["right"]
    assert box["add"]["left"] > box["today"]["left"]
