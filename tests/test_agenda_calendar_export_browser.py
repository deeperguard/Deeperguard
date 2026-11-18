"""Real-app Chromium test: each calendar in the settings panel has its own .ics export.

Starts the real Flask app, registers, creates two calendars with events, clicks the per-calendar
Export button and reads the downloaded file. Skips without Chromium.
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

PASSWORD = "CalExportPass1!abc"
PANEL = "#agenda-calendar-settings"

SEED = """() => {
  const S = NotesStore;
  const work = NotesAgendaCalendars.createCalendar('Werk & Privé', 'teal');
  const empty = NotesAgendaCalendars.createCalendar('Leeg', 'red');
  const base = { type: 'agenda_event', version: 1, start: '2026-11-20T09:00:00.000Z',
    end: '2026-11-20T10:00:00.000Z', all_day: false, rrule: '' };
  S.upsertAgendaEvent('e-work', { ...base, title: 'Overleg werk', calendarId: work });
  S.upsertAgendaEvent('e-home', { ...base, title: 'Tandarts thuis' });
  return { work, empty };
}"""


@pytest.fixture(scope="module")
def ctx():
    data = Path(tempfile.mkdtemp(prefix="dg-cal-export-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            page = browser.new_page(viewport={"width": 1280, "height": 800}, accept_downloads=True)
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "calexport@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-add-event", timeout=30_000)
            ids = page.evaluate(SEED)
            page.locator("#agenda-calendar-settings-btn:visible").first.click()
            page.wait_for_selector(f"{PANEL}:not([hidden])")
            yield page, ids
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _export(page, name):
    if not page.locator(f"{PANEL}:not([hidden])").count():  # exporting closes the panel
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector(f"{PANEL}:not([hidden])")
    with page.expect_download() as dl:
        page.get_by_role("button", name=f"Export {name} as .ics").click()
    d = dl.value
    return d.suggested_filename, Path(d.path()).read_text(encoding="utf-8")


def test_export_contains_only_that_calendar(ctx):
    page, _ = ctx
    fname, text = _export(page, "Werk & Privé")
    assert "Overleg werk" in text
    assert "Tandarts thuis" not in text
    assert text.count("BEGIN:VEVENT") == 1
    assert fname.startswith("deeperguard-calendar-werk") and fname.endswith(".ics")


def test_default_calendar_exports_its_own_events(ctx):
    page, _ = ctx
    _, text = _export(page, "Agenda")
    assert "Tandarts thuis" in text
    assert "Overleg werk" not in text


def test_empty_calendar_gives_no_file_and_says_so(ctx):
    page, _ = ctx
    if not page.locator(f"{PANEL}:not([hidden])").count():
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector(f"{PANEL}:not([hidden])")
    downloads = []
    page.on("download", lambda d: downloads.append(d))
    page.get_by_role("button", name="Export Leeg as .ics").click()
    page.wait_for_function(
        "() => document.body.textContent.includes('No events in Leeg to export')", timeout=5000)
    assert downloads == []
    page.get_by_role("button", name="Export Leeg as .ics").click()  # same action twice: still no file
    assert downloads == []


def test_export_button_is_keyboard_reachable_at_phone_width(ctx):
    page, _ = ctx
    if not page.locator(f"{PANEL}:not([hidden])").count():
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector(f"{PANEL}:not([hidden])")
    page.set_viewport_size({"width": 390, "height": 800})
    btn = page.get_by_role("button", name="Export Leeg as .ics")
    btn.focus()
    focused = page.evaluate("() => document.activeElement.getAttribute('data-agenda-cal-action')")
    assert focused == "export"
    box = btn.bounding_box()
    row = page.locator('[data-agenda-cal-id]').first.bounding_box()
    assert box["x"] + box["width"] <= row["x"] + row["width"] + 1
