"""Real-app Chromium test: opt-in webcal feed of one calendar (consent, link, update, revoke).

Starts the real Flask app, registers, creates calendars with events, opens a Feed panel and reads
the public feed URL without a session. Skips without Chromium.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402

PASSWORD = "CalFeedPass1!abc"
PANEL = "#agenda-calendar-settings"

SEED = """() => {
  const S = NotesStore;
  const work = NotesAgendaCalendars.createCalendar('Werk', 'teal');
  const other = NotesAgendaCalendars.createCalendar('Prive', 'red');
  const base = { type: 'agenda_event', version: 1, start: '2026-11-20T09:00:00.000Z',
    end: '2026-11-20T10:00:00.000Z', all_day: false, rrule: '' };
  S.upsertAgendaEvent('e-work', { ...base, title: 'Overleg werk', calendarId: work });
  S.upsertAgendaEvent('e-home', { ...base, title: 'Tandarts thuis', calendarId: other });
  return { work, other };
}"""

NEW_EVENT = """(id) => NotesStore.upsertAgendaEvent('e-new', { type: 'agenda_event', version: 1,
  start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T10:00:00.000Z', all_day: false,
  rrule: '', title: 'Nieuwe afspraak', calendarId: id })"""

FEED_BTN_TEXT = """(name) => {
  const b = document.querySelector('[data-agenda-cal-action="feed"][aria-label="Subscription link for ' + name + '"]');
  return b ? b.textContent : null;
}"""


def _fetch(webcal):
    """Anonymous GET (no cookies) of a webcal:// link. Returns (status, body)."""
    try:
        with urllib.request.urlopen("http://" + webcal[len("webcal://"):], timeout=10) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, ""


@pytest.fixture(scope="module")
def ctx():
    data = Path(tempfile.mkdtemp(prefix="dg-cal-feed-"))
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
            page.fill('input[name="email"]', "calfeed@e2e.invalid")
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
            yield page, ids, {}
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _open_panel(page):
    if not page.locator(f"{PANEL}:not([hidden])").count():
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector(f"{PANEL}:not([hidden])")


def test_warning_and_consent_then_link_serves_only_that_calendar(ctx):
    page, _, state = ctx
    _open_panel(page)
    page.get_by_role("button", name="Subscription link for Werk").click()
    group = page.get_by_role("group", name="Subscription link for Werk")
    assert "The server can read this calendar" in group.inner_text()
    group.get_by_role("button", name="Create link").click()  # without consent nothing is created
    assert "Tick the box" in group.inner_text()
    assert page.locator("#agenda-cal-feed-url").count() == 0
    group.get_by_label("I understand the server can read this calendar.").check()
    group.get_by_role("button", name="Create link").click()
    page.wait_for_selector("#agenda-cal-feed-url")
    link = page.input_value("#agenda-cal-feed-url")
    assert link.startswith("webcal://")
    status, text = _fetch(link)
    assert status == 200
    assert "Overleg werk" in text and "Tandarts thuis" not in text
    assert page.evaluate(FEED_BTN_TEXT, "Werk") == "Feed on"
    state["link"] = link


def test_edit_reaches_the_feed_and_new_link_revokes_the_old_one(ctx):
    page, ids, state = ctx
    old = state["link"]
    page.evaluate(NEW_EVENT, ids["work"])
    page.evaluate("() => NotesAgendaCalendars.syncFeeds()")
    assert "Nieuwe afspraak" in _fetch(old)[1]
    _open_panel(page)
    if page.get_by_role("group", name="Subscription link for Werk").count() == 0:
        page.get_by_role("button", name="Subscription link for Werk").click()
    page.get_by_role("button", name="New link (old link stops working)").click()
    page.wait_for_function(
        "(o) => { const i = document.getElementById('agenda-cal-feed-url'); return !!i && i.value !== o; }",
        arg=old)
    new = page.input_value("#agenda-cal-feed-url")
    assert _fetch(old)[0] == 404
    assert _fetch(new)[0] == 200
    state["link"] = new


def test_turn_off_revokes_and_syncing_again_does_not_recreate_it(ctx):
    page, _, state = ctx
    link = state["link"]
    _open_panel(page)
    if page.get_by_role("group", name="Subscription link for Werk").count() == 0:
        page.get_by_role("button", name="Subscription link for Werk").click()
    page.get_by_role("button", name="Turn off and revoke link").click()
    page.wait_for_selector("text=Create link")
    assert _fetch(link)[0] == 404
    assert page.evaluate(FEED_BTN_TEXT, "Werk") == "Feed"
    page.evaluate("() => NotesAgendaCalendars.syncFeeds()")
    assert _fetch(link)[0] == 404


def test_deleting_a_calendar_with_a_feed_revokes_it_and_panel_is_keyboard_usable(ctx):
    page, ids, _ = ctx
    _open_panel(page)
    page.set_viewport_size({"width": 390, "height": 800})
    btn = page.get_by_role("button", name="Subscription link for Prive")
    btn.focus()
    assert page.evaluate("() => document.activeElement.getAttribute('data-agenda-cal-action')") == "feed"
    page.keyboard.press("Enter")
    group = page.get_by_role("group", name="Subscription link for Prive")
    group.get_by_label("I understand the server can read this calendar.").check()
    group.get_by_role("button", name="Create link").click()
    page.wait_for_selector("#agenda-cal-feed-url")
    link = page.input_value("#agenda-cal-feed-url")
    assert _fetch(link)[0] == 200
    group.get_by_role("button", name="Close").focus()
    page.keyboard.press("Enter")
    assert page.locator("#agenda-cal-feed-url").count() == 0
    assert page.locator(f"{PANEL}:not([hidden])").count() == 1
    page.evaluate("(id) => NotesAgendaCalendars.deleteCalendar(id, 'delete')", ids["other"])
    page.evaluate("() => NotesAgendaCalendars.syncFeeds()")
    assert _fetch(link)[0] == 404
