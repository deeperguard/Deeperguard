"""Real-app Chromium test: the agenda editor refuses an empty or whitespace-only
title (new and edit), shows a linked error and focuses the field; a valid title
saves, and an existing 'Untitled' event can be renamed. Skips without Chromium."""
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

PASSWORD = "EmptyTitlePass1!abc"

# Stand-in for the browser's Notification API, installed before the app scripts run, so the
# permission state is under test control and no real permission prompt can block the run.
# requestPermission() answers with window.__dgNextPermission (or keeps the current state).
FAKE_NOTIFICATION = """(() => {
  class FakeNotification { close() {} }
  FakeNotification.permission = 'default';
  FakeNotification.requests = 0;
  FakeNotification.requestPermission = () => {
    FakeNotification.requests += 1;
    FakeNotification.permission = window.__dgNextPermission || FakeNotification.permission;
    return Promise.resolve(FakeNotification.permission);
  };
  Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
})();"""


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-emptytitle-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            pg = browser.new_page(viewport={"width": 1280, "height": 800})
            pg.add_init_script(FAKE_NOTIFICATION)
            pg.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', "emptytitle@e2e.invalid")
            pg.fill("#register-password", PASSWORD)
            pg.fill("#register-password2", PASSWORD)
            pg.check("#register-terms")
            pg.check("#register-recover-ack")
            pg.click("#register-submit")
            pg.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(pg)
            pg.evaluate("() => NotesStore.markKeyVerified?.()")
            pg.click("#app-tab-agenda")
            pg.wait_for_selector("#agenda-root", timeout=30_000)
            yield pg
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _add_event(pg):
    pg.locator("#agenda-add-event:visible, #agenda-fab-add:visible").first.click()
    pg.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)


def _assert_blocked(pg, notes):
    assert pg.locator("#agenda-editor:not([hidden])").count() == 1
    err = pg.locator("#agenda-edit-title-error")
    assert err.is_visible() and err.inner_text().strip()
    title = pg.locator("#agenda-edit-title")
    assert title.get_attribute("aria-invalid") == "true"
    assert title.get_attribute("aria-describedby") == "agenda-edit-title-error"
    assert pg.evaluate("() => document.activeElement.id") == "agenda-edit-title"
    assert pg.input_value("#agenda-edit-notes") == notes


def _event_count(pg):
    return pg.evaluate("() => NotesStore.listAgendaEvents().length")


@pytest.mark.parametrize("blank", ["", "   "])
def test_new_event_blank_title_is_blocked(page, blank):
    before = _event_count(page)
    _add_event(page)
    page.fill("#agenda-edit-notes", "keep me")
    page.fill("#agenda-edit-title", blank)
    page.click("#agenda-edit-save")
    _assert_blocked(page, "keep me")
    assert _event_count(page) == before
    page.keyboard.type("x")
    assert page.locator("#agenda-edit-title-error").is_hidden()
    assert page.locator("#agenda-edit-title").get_attribute("aria-invalid") is None
    _cancel_editor(page)


def _cancel_editor(pg):
    pg.click("#agenda-edit-cancel")
    if pg.locator("#confirm-ok:visible").count():
        pg.click("#confirm-ok")
    pg.wait_for_selector("#agenda-editor", state="hidden", timeout=5000)


def _save_new_event(pg, title):
    """Create an event with `title` through the editor and return its id."""
    before = set(_event_ids(pg))
    _add_event(pg)
    pg.fill("#agenda-edit-title", title)
    pg.click("#agenda-edit-save")
    pg.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    return next(i for i in _event_ids(pg) if i not in before)


def _event_ids(pg):
    return pg.evaluate("() => NotesStore.listAgendaEvents().map(e => e.id)")


def _titles(pg):
    return pg.evaluate("() => NotesStore.listAgendaEvents().map(e => e.title)")


def _open_event_editor(pg, event_id):
    pg.locator(f'#agenda-root [data-agenda-id="{event_id}"]').first.click()
    pg.wait_for_selector(
        "#agenda-detail-card:not([hidden]), #agenda-scope-chooser:not([hidden]), #agenda-editor:not([hidden])",
        timeout=10_000,
    )
    if pg.locator("#agenda-detail-card:not([hidden])").count():
        pg.click("#agenda-detail-edit")
    if pg.locator("#agenda-scope-chooser:not([hidden])").count():
        pg.click('[data-agenda-edit-scope="series"]')
    pg.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)


def test_valid_title_saves(page):
    _save_new_event(page, "Planning")
    assert "Planning" in _titles(page)


def test_edit_blank_title_is_blocked_and_nothing_is_saved(page):
    event_id = _save_new_event(page, "Planning")
    titles_before = _titles(page)
    _open_event_editor(page, event_id)
    page.fill("#agenda-edit-title", "  ")
    page.click("#agenda-edit-save")
    _assert_blocked(page, "")
    assert _titles(page) == titles_before
    assert "Untitled" not in _titles(page)
    _cancel_editor(page)


def test_untitled_event_can_be_renamed(page):
    event_id = _save_new_event(page, "Untitled")
    _open_event_editor(page, event_id)
    assert page.input_value("#agenda-edit-title") == "Untitled"
    page.fill("#agenda-edit-title", "Renamed")
    page.click("#agenda-edit-save")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    title = page.evaluate(
        "(id) => NotesStore.listAgendaEvents().find(e => e.id === id)?.title", event_id)
    assert title == "Renamed"


def test_multiple_reminders_are_saved_and_shown_again(page):
    """Presets plus a custom value are stored as several offsets, survive a reopen, and the
    editor says reminders only work while the app is open."""
    before = set(_event_ids(page))
    _add_event(page)
    hint = page.locator("#agenda-edit-reminders-wrap .agenda-local-reminders-hint").inner_text()
    assert "only work while Deeperguard is open" in hint
    assert "send no email and no push" in hint
    page.fill("#agenda-edit-title", "Reminder event")
    page.check('[data-agenda-reminder-offset="5"]')
    page.check('[data-agenda-reminder-offset="1440"]')
    page.fill("#agenda-edit-reminders-custom", "20")
    page.click("#agenda-edit-save")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    event_id = next(i for i in _event_ids(page) if i not in before)
    stored = page.evaluate(
        "(id) => NotesStore.listAgendaEvents().find(e => e.id === id).reminders", event_id)
    assert sorted(stored) == [5, 20, 1440]
    _open_event_editor(page, event_id)
    assert page.is_checked('[data-agenda-reminder-offset="5"]')
    assert page.is_checked('[data-agenda-reminder-offset="1440"]')
    assert not page.is_checked('[data-agenda-reminder-offset="15"]')
    assert page.input_value("#agenda-edit-reminders-custom") == "20"
    _cancel_editor(page)


def _permission_ui(pg):
    status = pg.locator("#agenda-local-reminder-permission-status")
    return status.inner_text().strip(), pg.locator("#agenda-local-reminder-allow").is_visible()


def _wait_allow_hidden(pg):
    pg.wait_for_function(
        "() => document.getElementById('agenda-local-reminder-allow').hidden", timeout=5000)


def test_notification_permission_status_and_allow_button(page):
    """Agenda settings show the browser's notification permission and offer the Allow button only
    while the browser has not decided; the button asks once and the status follows the answer."""
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    allow = page.locator("#agenda-local-reminder-allow")

    # Undecided, as rendered when the app started: explain and offer the button.
    text, shown = _permission_ui(page)
    assert text.startswith("Reminders show inside Deeperguard. Allow browser notifications")
    assert shown

    # Allow by keyboard; the browser answers 'granted'.
    requests = page.evaluate("() => Notification.requests")
    page.evaluate("() => { window.__dgNextPermission = 'granted'; }")
    allow.focus()
    page.keyboard.press("Enter")
    _wait_allow_hidden(page)
    assert page.evaluate("() => Notification.requests") == requests + 1
    assert _permission_ui(page) == ("Browser notifications are allowed on this device.", False)

    # Undecided again; this time the browser answers 'denied'.
    page.evaluate(
        "() => { Notification.permission = 'default'; NotesAgendaLocalReminders.refreshPermissionUi(); }")
    assert _permission_ui(page)[1]
    page.evaluate("() => { window.__dgNextPermission = 'denied'; }")
    allow.click()
    _wait_allow_hidden(page)
    text, shown = _permission_ui(page)
    assert text.startswith("Browser notifications are blocked.")
    assert not shown

    # No Notification API at all: say so, no button.
    page.evaluate(
        "() => { delete window.Notification; NotesAgendaLocalReminders.refreshPermissionUi(); }")
    text, shown = _permission_ui(page)
    assert text.startswith("This browser does not support notifications.")
    assert not shown
