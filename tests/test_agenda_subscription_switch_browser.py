"""Real-app Chromium test: the on/off switch of a subscribed calendar (Calendar settings → Calendars).

Two subscriptions (one fetched directly in the fetch worker, one through the relay with consent)
and two own calendars ('Agenda', 'Verjaardag'). Turning a subscription off with the keyboard hides
its events without a reload, and a refresh cycle then makes no request for its feed, neither direct
nor via /api/agenda/ics-relay. The off state is stored in the encrypted agenda pack (the server's
copy and data dir hold no plain text of it), reaches a second signed-in device through sync, and
survives a reload. Turning it on brings the events back with
exactly one refresh. Skips without Chromium.
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
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "FeedTogglePass1!abc"
FEED_A = "https://feed-a.example.invalid/rooster.ics?token=SECRET-A"
FEED_B = "https://feed-b.example.invalid/teams.ics?token=SECRET-B"
UNLOCKED_JS = "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()"


def _ics(uid, title):
    day = dt.date.today().strftime("%Y%m%d")
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
        f"UID:{uid}\r\nSUMMARY:{title}\r\nDTSTART:{day}T120000Z\r\nDTEND:{day}T130000Z\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )


@pytest.fixture(scope="module")
def env():
    data = Path(tempfile.mkdtemp(prefix="dg-sub-switch-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            hits = {"a": 0, "b_direct": 0, "relay": 0}

            def on_request(req):
                if req.url.startswith("https://feed-a.example.invalid/"):
                    hits["a"] += 1
                elif req.url.startswith("https://feed-b.example.invalid/"):
                    hits["b_direct"] += 1
                elif req.url.endswith("/api/agenda/ics-relay"):
                    hits["relay"] += 1

            page = context.new_page()
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "subswitch@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")

            def watch(ctx):
                """Count every feed request of this browser context (page and fetch worker)."""
                ctx.on("request", on_request)
                cors = {"Access-Control-Allow-Origin": "*", "Content-Type": "text/calendar"}
                ctx.route("https://feed-a.example.invalid/**", lambda r: r.fulfill(
                    status=200, headers=cors, body=_ics("a-1@example.invalid", "Rooster dienst")))
                ctx.route("https://feed-b.example.invalid/**", lambda r: r.abort())
                ctx.route("**/api/agenda/ics-relay", lambda r: r.fulfill(
                    status=200, headers={"Content-Type": "text/calendar"},
                    body=_ics("b-1@example.invalid", "Teams overleg")))

            watch(context)
            yield {"page": page, "hits": hits, "data": data, "browser": browser, "port": port, "watch": watch}
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _open_agenda(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    page.click('[data-agenda-view="week"]')


def _chip_titles(page):
    return " | ".join(page.eval_on_selector_all(".agenda-event-chip", "els => els.map(e => e.title)"))


def _open_settings(page):
    if page.locator("#agenda-calendar-settings:not([hidden])").count():
        return
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)


def _switch(page, name):
    return page.get_by_role("switch", name=f"Subscribed calendar {name}")


def _press_switch(page, name):
    _open_settings(page)
    _switch(page, name).focus()
    page.keyboard.press("Space")


def _wait_chips(page, title, present):
    page.wait_for_function(
        """([t, want]) => [...document.querySelectorAll('.agenda-event-chip')]
              .some(c => (c.title || '').includes(t)) === want""",
        arg=[title, present], timeout=30_000)


def _wait_hits(page, hits, key, want, timeout_ms=30_000):
    """Wait until `want` requests for one feed were seen, then a moment longer to catch extra ones."""
    waited = 0
    while hits[key] < want and waited < timeout_ms:
        page.wait_for_timeout(100)
        waited += 100
    page.wait_for_timeout(1000)


def _refresh_cycle(page):
    """One automatic pass as if the 30-minute interval had passed, plus a direct refresh call."""
    return page.evaluate("""async () => {
      const ids = NotesStore.listAgendaSubscriptions().map((s) => s.id);
      const out = await NotesAgendaSubs.tick(Date.now() + 2 * NotesAgendaSubs.AUTO_REFRESH_MS);
      const manual = await Promise.all(ids.map((id) => NotesAgendaSubs.refresh(id)));
      return { auto: out.length, manual: manual.map((r) => r.code || 'ok') };
    }""")


def test_switch_off_hides_and_pauses_then_on_refreshes_once(env):
    page, hits = env["page"], env["hits"]
    _open_agenda(page)
    page.evaluate("""async ([a, b]) => {
      const S = NotesStore;
      const C = NotesAgendaCalendars;
      const bday = C.createCalendar('Verjaardag', 'pink');
      const start = new Date();
      start.setHours(9, 0, 0, 0);
      const base = { start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), all_day: false };
      S.upsertAgendaEvent('44444444-4444-4444-8444-444444444444', { ...base, title: 'Eigen afspraak', calendarId: S.DEFAULT_CALENDAR_ID });
      S.upsertAgendaEvent('55555555-5555-4555-8555-555555555555', { ...base, title: 'Taart Oma', calendarId: bday });
      const subA = S.addAgendaSubscription({ name: 'Team Rooster', url: a });
      const subB = S.addAgendaSubscription({ name: 'Teams <b>B</b>', url: b });
      S.updateAgendaSubscription(subB.id, { mode: 'relay', relay_consent: true });
      await NotesAgendaSubs.refresh(subA.id);
      await NotesAgendaSubs.refresh(subB.id);
      NotesAgenda.render();
    }""", [FEED_A, FEED_B])
    assert hits["a"] == 1 and hits["relay"] == 1, hits  # both routes are really observed
    titles = _chip_titles(page)
    for t in ("Rooster dienst", "Teams overleg", "Eigen afspraak", "Taart Oma"):
        assert t in titles, titles

    _open_settings(page)
    # Exactly one switch per subscription; own calendars keep their Show checkbox.
    assert page.locator("#agenda-calendars-subs [role=switch]").count() == 2
    assert _switch(page, "Team Rooster").count() == 1
    assert _switch(page, "Teams <b>B</b>").count() == 1  # name rendered as text
    assert page.locator("#agenda-calendar-settings b, #agenda-calendar-settings img").count() == 0
    assert page.get_by_role("checkbox", name="Show Agenda").is_checked()
    assert page.get_by_role("checkbox", name="Show Verjaardag").is_checked()
    assert page.locator("#agenda-subscriptions-list [role=switch], #agenda-subscriptions-list input:not([type=radio])").count() == 0

    # Off with the keyboard: events disappear without a reload, panel stays open.
    _press_switch(page, "Team Rooster")
    _wait_chips(page, "Rooster dienst", False)
    _press_switch(page, "Teams <b>B</b>")
    _wait_chips(page, "Teams overleg", False)
    assert page.locator("#agenda-calendar-settings:not([hidden])").count() == 1
    assert _switch(page, "Team Rooster").is_checked() is False
    assert page.evaluate("() => document.activeElement.getAttribute('role')") == "switch"
    row = page.locator("#agenda-calendars-subs li", has_text="Team Rooster")
    assert "Subscribed · off" in row.inner_text()
    card = page.locator(".agenda-subscription-row", has_text="Team Rooster")
    assert "Off" in card.locator(".agenda-subscription-head").inner_text()
    assert card.get_by_role("button", name="Refresh").is_disabled()
    for name in ("Rename", "Delete"):
        assert card.get_by_role("button", name=name).is_enabled()
    titles = _chip_titles(page)
    assert "Eigen afspraak" in titles and "Taart Oma" in titles, titles

    # A refresh cycle while off: no request for either feed (direct or relay).
    before = dict(hits)
    res = _refresh_cycle(page)
    page.wait_for_timeout(500)
    assert res == {"auto": 0, "manual": ["E_OFF", "E_OFF"]}, res
    assert hits == before, (before, hits)

    # Stored in the encrypted pack and synced; the server holds no plain text of it.
    server = page.evaluate("""async () => {
      await NotesStore.flush();
      await NotesStore.pushDirty({ quiet: true });
      return JSON.stringify(await NotesStore.fetchServerItem(NotesStore.AGENDA_PACK_UUID));
    }""")
    assert "ciphertext" in server
    blobs = server.encode() + b"".join(p.read_bytes() for p in env["data"].rglob("*") if p.is_file())
    for plain in (b"Team Rooster", b"feed-a.example.invalid", b'"enabled"'):
        assert plain not in blobs, plain

    # Another device signs in: it decrypts the off state from the server and fetches nothing.
    other = env["browser"].new_context(viewport={"width": 1280, "height": 800})
    env["watch"](other)
    page2 = other.new_page()
    page2.goto(f"http://127.0.0.1:{env['port']}/login", wait_until="domcontentloaded")
    page2.fill('#login-form [name="email"]', "subswitch@e2e.invalid")
    page2.fill("#login-password", PASSWORD)
    page2.click("#login-submit")
    page2.wait_for_function(UNLOCKED_JS, timeout=120_000)
    page2.wait_for_function("""() => {
      const subs = NotesStore.listAgendaSubscriptions();
      return subs.length === 2 && subs.every((s) => s.enabled === false);
    }""", timeout=60_000)
    _open_agenda(page2)
    page2.wait_for_timeout(1000)
    titles2 = _chip_titles(page2)
    assert "Rooster dienst" not in titles2 and "Teams overleg" not in titles2, titles2
    assert "Eigen afspraak" in titles2, titles2
    assert hits == before, (before, hits)
    other.close()

    # Survives a reload (vault unlocked again): still off, events still hidden, still no fetch.
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="attached", timeout=60_000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120_000)
    _open_agenda(page)
    page.wait_for_timeout(1000)
    assert hits == before, (before, hits)
    titles = _chip_titles(page)
    assert "Rooster dienst" not in titles and "Teams overleg" not in titles, titles
    assert "Eigen afspraak" in titles and "Taart Oma" in titles, titles
    _open_settings(page)
    assert _switch(page, "Team Rooster").is_checked() is False
    assert _switch(page, "Teams <b>B</b>").is_checked() is False

    # On again: events back and exactly one refresh of that feed; the other stays paused.
    _press_switch(page, "Team Rooster")
    _wait_chips(page, "Rooster dienst", True)
    _wait_hits(page, hits, "a", before["a"] + 1)
    assert hits["a"] == before["a"] + 1, (before, hits)
    assert hits["relay"] == before["relay"] and hits["b_direct"] == 0, (before, hits)
    assert _switch(page, "Team Rooster").is_checked() is True
    assert page.locator(".agenda-subscription-row", has_text="Team Rooster").get_by_role(
        "button", name="Refresh").is_enabled()
    _press_switch(page, "Teams <b>B</b>")
    _wait_chips(page, "Teams overleg", True)
    _wait_hits(page, hits, "relay", before["relay"] + 1)
    assert hits["relay"] == before["relay"] + 1 and hits["b_direct"] == 0, (before, hits)

    # Own calendars still hide and show with their own checkbox.
    page.get_by_role("checkbox", name="Show Verjaardag").focus()
    page.keyboard.press("Space")
    _wait_chips(page, "Taart Oma", False)
    page.get_by_role("checkbox", name="Show Verjaardag").focus()
    page.keyboard.press("Space")
    _wait_chips(page, "Taart Oma", True)
    page.click("#agenda-calendar-settings-close")
