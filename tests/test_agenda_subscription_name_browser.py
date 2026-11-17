"""Real-app Chromium test: the name of a URL-subscribed calendar shows in the agenda itself.

Starts the real Flask app, registers, adds one subscription and one normal calendar with an event
each, and checks the chips (month/week/day), the list view, the event detail and the legend, a
Rename without reload and that a hostile name is rendered as text. Skips without Chromium.
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

PASSWORD = "CalPickerPass1!abc"
UNLOCKED_JS = "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()"


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-sub-name-"))
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
            page.fill('input[name="email"]', "subname@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


HOSTILE = "<img src=x onerror=alert(1)>"


def _setup(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    return page.evaluate("""() => {
      const S = NotesStore;
      const work = window.NotesAgendaCalendars.createCalendar('Werk', 'teal');
      const sub = S.addAgendaSubscription({ name: 'Team Rooster', url: 'https://example.invalid/a.ics' });
      const start = new Date();
      start.setHours(10, 0, 0, 0);
      const base = { start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), all_day: false };
      S.upsertAgendaEvent('11111111-1111-4111-8111-111111111111', { ...base, title: 'Rooster dienst', subscription_id: sub.id, source: sub.name });
      S.upsertAgendaEvent('22222222-2222-4222-8222-222222222222', { ...base, title: 'Overleg', calendarId: work });
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      S.upsertAgendaEvent('44444444-4444-4444-8444-444444444444', {
        title: 'Rooster vrij', start: day.toISOString(), end: new Date(day.getTime() + 86400000).toISOString(),
        all_day: true, subscription_id: sub.id, source: sub.name });
      return sub.id;
    }""")


def _view(page, view):
    page.evaluate("() => NotesAgenda.render()")
    page.click(f'[data-agenda-view="{view}"]')


def _chip_titles(page, selector):
    return page.eval_on_selector_all(selector, "els => els.map(e => e.title)")


def _assert_week_takes_body(page):
    """The week overview fills the whole agenda body, so no space is left for a side strip."""
    box = page.evaluate("""() => {
      const w = document.querySelector('.agenda-week-layout').getBoundingClientRect();
      const b = document.querySelector('.agenda-body').getBoundingClientRect();
      return { wLeft: w.left, wWidth: w.width, bLeft: b.left, bWidth: b.width };
    }""")
    assert box["wWidth"] > 0, box
    assert abs(box["wWidth"] - box["bWidth"]) < 1, box
    assert abs(box["wLeft"] - box["bLeft"]) < 1, box


def test_subscription_name_everywhere(page):
    sub_id = _setup(page)
    dialogs = []
    prompt_answer = {"value": ""}

    def on_dialog(d):
        if d.type == "prompt":
            d.accept(prompt_answer["value"])
        else:
            dialogs.append(d.message)
            d.dismiss()

    page.on("dialog", on_dialog)

    for view, sel in (("month", ".agenda-month-ev"), ("week", ".agenda-event-chip"), ("day", ".agenda-event-chip")):
        _view(page, view)
        titles = _chip_titles(page, sel)
        assert any("Rooster dienst" in t and t.endswith("Team Rooster") for t in titles), (view, titles)
        assert any("Overleg" in t and t.endswith("Werk") for t in titles), (view, titles)

    for view in ("week", "day"):
        _view(page, view)
        allday = _chip_titles(page, ".agenda-allday-chip")
        assert any("Rooster vrij" in t and t.endswith("Team Rooster") for t in allday), (view, allday)

    _view(page, "agenda")
    row = page.locator(".agenda-list-row", has_text="Rooster dienst")
    assert "Team Rooster" in row.inner_text()
    assert "Werk" in page.locator(".agenda-list-row", has_text="Overleg").inner_text()

    row.first.click()
    page.wait_for_selector("#agenda-detail-calendar", state="visible", timeout=30_000)
    assert page.inner_text("#agenda-detail-calendar") == "Calendar: Team Rooster"
    page.click("#agenda-detail-edit")
    page.wait_for_selector("#agenda-editor:not([hidden]) #agenda-edit-calendar", timeout=30_000)
    selected = page.locator("#agenda-edit-calendar option:checked")
    assert "Team Rooster" in selected.inner_text()
    assert selected.evaluate("o => o.disabled && o.value === ''")
    page.click("#agenda-edit-cancel")
    page.keyboard.press("Escape")

    assert page.locator(".agenda-legend").count() == 0
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    sub_row = page.locator("#agenda-calendars-subs li", has_text="Team Rooster")
    assert "Subscribed · on" in sub_row.inner_text()
    assert sub_row.locator("input").count() == 1
    assert sub_row.get_by_role("switch", name="Subscribed calendar Team Rooster").is_checked()
    assert page.locator("#agenda-calendars-list li", has_text="Werk").locator("input").count() == 1
    page.click("#agenda-calendar-settings-close")

    # Rename through the real UI (prompt dialog): no reload, no manual render().
    def rename(name):
        prompt_answer["value"] = name
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
        row = page.locator(".agenda-subscription-row", has=page.locator("strong"))
        row.get_by_role("button", name="Rename").first.click()
        page.click("#agenda-calendar-settings-close")

    rename("Nieuw rooster")
    assert "Nieuw rooster" in page.locator(".agenda-list-row", has_text="Rooster dienst").inner_text()
    rename(HOSTILE)
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    assert HOSTILE in page.locator("#agenda-calendars-subs").inner_text()
    assert "Nieuw rooster" not in page.locator("#agenda-calendars-subs").inner_text()
    assert page.locator(".agenda-body img, #agenda-calendar-settings img").count() == 0
    page.click("#agenda-calendar-settings-close")
    assert dialogs == []


def test_calendar_toggle_in_settings_hides_events(page):
    page.evaluate("""() => {
      const id = NotesAgendaCalendars.createCalendar('Spoor', 'red');
      const start = new Date();
      start.setHours(14, 0, 0, 0);
      NotesStore.upsertAgendaEvent('33333333-3333-4333-8333-333333333333', {
        title: 'Spoorwerk', start: start.toISOString(), all_day: false, calendarId: id,
        end: new Date(start.getTime() + 3600000).toISOString() });
    }""")
    _view(page, "week")
    assert page.locator(".agenda-legend").count() == 0
    chips = page.locator(".agenda-event-chip", has_text="Spoorwerk")
    assert chips.count() == 1
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    heading = page.locator("#agenda-calendars-heading")
    assert heading.text_content() == "Calendars"
    toggle = page.get_by_role("checkbox", name="Show Spoor")
    toggle.focus()
    page.keyboard.press("Space")  # keyboard operation, panel stays open
    assert page.locator("#agenda-calendar-settings:not([hidden])").count() == 1
    page.wait_for_function(
        "() => ![...document.querySelectorAll('.agenda-event-chip')].some(c => c.textContent.includes('Spoorwerk'))")
    assert page.get_by_role("checkbox", name="Show Spoor").is_checked() is False
    assert page.evaluate(
        "() => NotesAgendaCalendars.listCalendars().find(c => c.name === 'Spoor').visible") is False

    # Survives a reload (vault unlocked again): still off and its event still hidden.
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="attached", timeout=60_000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120_000)
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    _view(page, "week")
    assert page.locator(".agenda-event-chip", has_text="Spoorwerk").count() == 0
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    assert page.get_by_role("checkbox", name="Show Spoor").is_checked() is False
    page.get_by_role("checkbox", name="Show Spoor").focus()
    page.keyboard.press("Space")
    page.wait_for_function(
        "() => [...document.querySelectorAll('.agenda-event-chip')].some(c => c.textContent.includes('Spoorwerk'))")
    assert page.get_by_role("checkbox", name="Show Spoor").is_checked() is True
    page.click("#agenda-calendar-settings-close")
    page.set_viewport_size({"width": 390, "height": 800})
    page.evaluate("() => NotesAgenda.render()")
    assert page.locator(".agenda-legend").count() == 0
    _assert_week_takes_body(page)
    page.set_viewport_size({"width": 1280, "height": 800})
    page.evaluate("() => NotesAgenda.render()")
    assert page.locator(".agenda-legend").count() == 0
    _assert_week_takes_body(page)
