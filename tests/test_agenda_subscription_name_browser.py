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
      return sub.id;
    }""")


def _view(page, view):
    page.evaluate("() => NotesAgenda.render()")
    page.click(f'[data-agenda-view="{view}"]')


def _chip_titles(page, selector):
    return page.eval_on_selector_all(selector, "els => els.map(e => e.title)")


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

    legend = page.locator(".agenda-legend li", has_text="Team Rooster")
    assert "Subscribed" in legend.inner_text()
    assert legend.locator("input").count() == 0
    assert page.locator(".agenda-legend li", has_text="Werk").locator("input").count() == 1

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
    assert page.locator(".agenda-legend li", has_text="Nieuw rooster").count() == 1
    rename(HOSTILE)
    assert HOSTILE in page.locator(".agenda-legend").inner_text()
    assert page.locator(".agenda-body img, .agenda-legend img").count() == 0
    assert dialogs == []
