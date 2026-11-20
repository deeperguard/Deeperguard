"""Real-app Chromium test: phone month grid day labels and keyboard navigation.

Every day has an aria-label with the full date and the event count, the grid is one tab stop,
arrow keys move by day/week (also across the month border) and Enter selects. Skips without
Chromium.
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

PASSWORD = "KbdPass1x!abcd"

SEED = """async () => {
  const d = new Date(2026, 10, 19);
  for (let h = 8; h < 12; h += 1) {
    const s = new Date(d); s.setHours(h, 0, 0, 0);
    const e = new Date(d); e.setHours(h + 1, 0, 0, 0);
    NotesStore.upsertAgendaEvent(NotesStore.newUuid(), { title: 'Event ' + h, start: s.toISOString(),
      end: e.toISOString(), all_day: false });
  }
  await NotesStore.flush();
}"""

ACTIVE = "() => document.activeElement.getAttribute('data-agenda-month-pick')"
PICKED = ("() => document.querySelector('#agenda-root [aria-pressed=\"true\"]')"
          ".getAttribute('data-agenda-month-pick')")
TAB_STOPS = "#agenda-root .agenda-month-date[tabindex='0']"


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-month-kbd-"))
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
            page.fill('input[name="email"]', "kbd@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.evaluate(SEED)
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


def _label(page, y, m, d):
    return page.evaluate(
        "(t) => document.querySelector(`[data-agenda-month-pick=\"${t}\"]`).getAttribute('aria-label')",
        _ts(page, y, m, d))


def _focus_day(page, y, m, d):
    page.evaluate(
        "(t) => document.querySelector(`[data-agenda-month-pick=\"${t}\"]`).focus()", _ts(page, y, m, d))


def test_day_labels_and_single_tab_stop(session):
    page = session
    busy = _label(page, 2026, 11, 19)
    quiet = _label(page, 2026, 11, 18)
    assert "19" in busy and "2026" in busy and busy.endswith("4 events"), busy
    assert quiet.endswith("0 events"), quiet
    assert page.locator(TAB_STOPS).count() == 1


def test_arrows_move_day_and_week_and_enter_selects(session):
    page = session
    _focus_day(page, 2026, 11, 10)
    page.keyboard.press("ArrowRight")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 11, 11)
    page.keyboard.press("ArrowDown")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 11, 18)
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowUp")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 11, 10)
    assert page.evaluate(PICKED) == _ts(page, 2026, 11, 10)
    assert page.locator(TAB_STOPS).count() == 1
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Enter")
    assert page.evaluate(PICKED) == _ts(page, 2026, 11, 11)


def test_arrows_cross_month_border_keeping_focus(session):
    page = session
    _focus_day(page, 2026, 11, 30)
    page.keyboard.press("ArrowRight")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 12, 1)
    assert page.evaluate(PICKED) == _ts(page, 2026, 12, 1)
    assert page.evaluate("() => NotesAgenda._state.anchor.getMonth()") == 11
    page.keyboard.press("ArrowUp")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 11, 24)
    assert page.evaluate("() => NotesAgenda._state.anchor.getMonth()") == 10
    _focus_day(page, 2026, 11, 1)
    page.keyboard.press("ArrowLeft")
    assert page.evaluate(ACTIVE) == _ts(page, 2026, 10, 31)
    assert page.evaluate(PICKED) == _ts(page, 2026, 10, 31)
