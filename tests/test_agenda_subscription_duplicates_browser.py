"""Real-app Chromium test: changing the colour of a subscribed calendar never doubles its events.

Adds a subscription with a test feed, changes the colour several times (each change syncs and is
followed by a feed refresh), and checks that every feed event shows exactly once in the week view,
also after a reload. Skips without Chromium.
"""
from __future__ import annotations

import datetime as dt
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402

PASSWORD = "FeedDupPass1!abcd"
FEED = "https://feed-d.example.invalid/rooster.ics"
UNLOCKED_JS = "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()"
TITLES = ["Dup dienst A", "Dup dienst B", "Dup dienst C"]


def _ics():
    day = dt.date.today().strftime("%Y%m%d")
    body = "".join(
        f"BEGIN:VEVENT\r\nUID:d-{i}@example.invalid\r\nSUMMARY:{t}\r\n"
        f"DTSTART:{day}T{9 + i:02d}0000Z\r\nDTEND:{day}T{9 + i:02d}3000Z\r\nEND:VEVENT\r\n"
        for i, t in enumerate(TITLES)
    )
    return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + body + "END:VCALENDAR\r\n"


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-sub-dup-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            context.route("https://feed-d.example.invalid/**", lambda r: r.fulfill(
                status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "text/calendar"},
                body=_ics()))
            pg = context.new_page()
            pg.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', "subdup@e2e.invalid")
            pg.fill("#register-password", PASSWORD)
            pg.fill("#register-password2", PASSWORD)
            pg.check("#register-terms")
            pg.check("#register-recover-ack")
            pg.click("#register-submit")
            pg.wait_for_function(UNLOCKED_JS, timeout=120_000)
            pg.evaluate("() => NotesStore.markKeyVerified?.()")
            yield pg
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _chip_counts(page):
    return page.evaluate("""(titles) => {
      const chips = [...document.querySelectorAll('.agenda-event-chip')].map((c) => c.textContent);
      return titles.map((t) => chips.filter((x) => x.includes(t)).length);
    }""", TITLES)


def _pack_counts(page):
    return page.evaluate("""() => {
      const evs = NotesStore.listAgendaEvents().filter((e) => e.subscription_id);
      return [evs.length, new Set(evs.map((e) => e.ical_uid)).size];
    }""")


def test_colour_changes_never_double_events(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    page.click('[data-agenda-view="week"]')
    page.evaluate("""async (url) => {
      const sub = NotesStore.addAgendaSubscription({ name: 'Dup rooster', url });
      await NotesAgendaSubs.refresh(sub.id);
      NotesAgenda.render();
    }""", FEED)
    page.wait_for_selector(".agenda-event-chip", timeout=30_000)
    assert _chip_counts(page) == [1, 1, 1]
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    group = page.get_by_role("group", name="Colour of Dup rooster")
    for name in ["Purple", "Slate", "Purple", "Slate"]:
        group.get_by_role("radio", name=name).focus()
        page.keyboard.press("Space")
        page.evaluate("async () => { await NotesStore.flush(); await NotesStore.pushDirty({ quiet: true }); }")
        page.evaluate("async () => { await NotesAgendaSubs.refresh(NotesStore.listAgendaSubscriptions()[0].id); }")
        assert _chip_counts(page) == [1, 1, 1], name
        assert _pack_counts(page) == [3, 3], name

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="attached", timeout=60_000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120_000)
    page.click("#app-tab-agenda")
    page.wait_for_selector(".agenda-event-chip", timeout=30_000)
    page.click('[data-agenda-view="week"]')
    assert _chip_counts(page) == [1, 1, 1]
    assert _pack_counts(page) == [3, 3]
