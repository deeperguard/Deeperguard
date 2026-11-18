"""Real-app Chromium test: the calendar picker of a new agenda event.

Starts the real Flask app, registers, saves events in a visible and a hidden calendar (the hidden
one was saved last) and checks that "+ Event" preselects the visible calendar, then the default
calendar once no visible calendar has an event. Skips when Playwright/Chromium is unavailable.
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

PASSWORD = "CalPickerPass1!abc"


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-new-event-cal-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "calpicker@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _picker(page):
    return page.eval_on_selector(
        "#agenda-edit-calendar",
        "el => ({ value: el.value, label: el.selectedOptions[0] ? el.selectedOptions[0].textContent : '' })",
    )


def _open_new_event(page):
    page.click("#agenda-add-event")
    page.wait_for_selector("#agenda-editor:not([hidden]) #agenda-edit-calendar", timeout=30_000)
    picked = _picker(page)
    page.click("#agenda-edit-cancel")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=30_000)
    return picked


def test_new_event_picker_preselects_last_used_visible_calendar(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    ids = page.evaluate("""async () => {
      const C = window.NotesAgendaCalendars;
      const S = NotesStore;
      const work = C.createCalendar('Werk', 'teal');
      const hidden = C.createCalendar('Privé', 'purple');
      const start = new Date(Date.now() + 3 * 86400000);
      start.setHours(10, 0, 0, 0);
      const event = (calendarId) => ({
        title: 'Overleg', start: start.toISOString(),
        end: new Date(start.getTime() + 3600000).toISOString(), all_day: false, calendarId });
      S.upsertAgendaEvent(S.newUuid(), event(work));
      await new Promise((r) => setTimeout(r, 20));
      S.upsertAgendaEvent(S.newUuid(), event(hidden));
      C.setCalendarVisible(hidden, false);
      await S.flush();
      return { work, def: S.DEFAULT_CALENDAR_ID };
    }""")

    # The newest event is in the hidden calendar, so the visible "Werk" calendar is the default.
    assert _open_new_event(page) == {"value": ids["work"], "label": "Werk"}

    # Hide "Werk" too: no visible event is left, so the default calendar is preselected.
    page.evaluate("(id) => window.NotesAgendaCalendars.setCalendarVisible(id, false)", ids["work"])
    assert _open_new_event(page)["value"] == ids["def"]
