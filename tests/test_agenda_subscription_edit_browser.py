"""Real-app Chromium test: Edit on a subscribed calendar changes its feed link (Calendar settings).

The edit form is pre-filled, goes through the same link check, preview and relay consent as
"Add a subscription", and keeps the old link and events until the new preview is saved. After
saving, the old feed's events are replaced by the new feed's; name, colour and on/off state stay.
Skips without Chromium.
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

PASSWORD = "FeedEditPass1!abc"
FEED_A = "https://feed-a.example.invalid/rooster.ics?token=SECRET-A"
FEED_C = "https://feed-c.example.invalid/nieuw.ics?token=SECRET-C"
FEED_BLOCKED = "https://feed-blocked.example.invalid/x.ics?token=SECRET-X"
BAD_LINK = "http://plain.example.invalid/x.ics"
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
    data = Path(tempfile.mkdtemp(prefix="dg-sub-edit-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            hits = {"a": 0, "c": 0, "blocked": 0, "relay": 0}
            logs = []

            def on_request(req):
                for key, host in (("a", "feed-a"), ("c", "feed-c"), ("blocked", "feed-blocked")):
                    if req.url.startswith(f"https://{host}.example.invalid/"):
                        hits[key] += 1
                if req.url.endswith("/api/agenda/ics-relay"):
                    hits["relay"] += 1

            page = context.new_page()
            page.on("console", lambda m: logs.append(m.text))
            context.on("request", on_request)
            cors = {"Access-Control-Allow-Origin": "*", "Content-Type": "text/calendar"}
            context.route("https://feed-a.example.invalid/**", lambda r: r.fulfill(
                status=200, headers=cors, body=_ics("a-1@example.invalid", "Rooster dienst")))
            context.route("https://feed-c.example.invalid/**", lambda r: r.fulfill(
                status=200, headers=cors, body=_ics("c-1@example.invalid", "Nieuwe training")))
            context.route("https://feed-blocked.example.invalid/**", lambda r: r.abort())
            context.route("**/api/agenda/ics-relay", lambda r: r.fulfill(
                status=200, headers={"Content-Type": "text/calendar"},
                body=_ics("x-1@example.invalid", "Via server")))
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "subedit@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            yield {"page": page, "hits": hits, "logs": logs}
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _chips(page):
    return " | ".join(page.eval_on_selector_all(".agenda-event-chip", "els => els.map(e => e.title)"))


def _wait_chip(page, title, present):
    page.wait_for_function(
        """([t, want]) => [...document.querySelectorAll('.agenda-event-chip')]
              .some(c => (c.title || '').includes(t)) === want""",
        arg=[title, present], timeout=30_000)


def _sub(page):
    return page.evaluate("() => NotesStore.listAgendaSubscriptions()[0]")


def _link(page):
    return page.locator(".agenda-subscription-edit").get_by_label("Feed link", exact=True)


def _name(page):
    return page.locator(".agenda-subscription-edit").get_by_label("Name", exact=True)


def test_edit_feed_link(env):
    page, hits = env["page"], env["hits"]
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    page.click('[data-agenda-view="week"]')
    page.evaluate("""async (a) => {
      const sub = NotesStore.addAgendaSubscription({ name: 'Team <i>Rooster</i>', url: a, color: 'teal' });
      await NotesAgendaSubs.refresh(sub.id);
      NotesAgenda.render();
    }""", FEED_A)
    _wait_chip(page, "Rooster dienst", True)
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    before = _sub(page)
    card = page.locator(".agenda-subscription-row").first
    edit = card.get_by_role("button", name="Edit")

    # Opens pre-filled; labels are tied to the inputs; the name field has focus.
    edit.click()
    assert _name(page).input_value() == "Team <i>Rooster</i>"
    assert _link(page).input_value() == FEED_A
    assert page.evaluate("() => document.activeElement.id").endswith("-name")

    # Cancel changes nothing and make no request.
    _link(page).fill(FEED_C)
    page.get_by_role("button", name="Cancel").click()
    assert _sub(page) == before and hits["c"] == 0
    assert page.evaluate("() => document.activeElement.textContent") == "Edit"

    # Refused link: same message as "Add a subscription"; subscription unchanged.
    page.fill("#agenda-subscribe-url", BAD_LINK)
    page.click("#agenda-subscribe-form button[type=submit]")
    add_error = page.locator("#agenda-subscribe-preview [role=alert]").inner_text()
    page.fill("#agenda-subscribe-url", "")
    edit.click()
    _link(page).fill(BAD_LINK)
    page.keyboard.press("Enter")
    edit_error = page.locator(".agenda-subscription-edit [role=alert]").inner_text()
    assert edit_error == add_error and add_error
    assert _sub(page) == before

    # Changed link: nothing saved before the preview is confirmed; old events stay until then.
    _link(page).fill(FEED_C)
    _name(page).fill("Nieuwe naam")
    page.keyboard.press("Enter")
    page.wait_for_selector(".agenda-subscription-edit .agenda-import-counts", timeout=30_000)
    assert hits["c"] == 1
    assert _sub(page) == before and "Rooster dienst" in _chips(page)
    page.get_by_role("button", name="Save new link").click()
    _wait_chip(page, "Nieuwe training", True)
    _wait_chip(page, "Rooster dienst", False)
    after = _sub(page)
    assert after["url"].startswith(FEED_C) and after["name"] == "Nieuwe naam"
    assert after["color"] == "teal" and after.get("enabled", True) is True and after["mode"] == "direct"
    assert page.locator(".agenda-subscription-edit").count() == 0

    # Blocked feed: error + offer of the server; nothing goes to the relay before consent.
    edit.click()
    _link(page).fill(FEED_BLOCKED)
    page.keyboard.press("Enter")
    page.get_by_role("button", name="Fetch via server…").wait_for(timeout=30_000)
    assert hits["relay"] == 0
    page.get_by_role("button", name="Fetch via server…").click()
    page.locator(".agenda-relay-consent").wait_for()
    assert hits["relay"] == 0
    page.get_by_role("button", name="No, keep direct").click()
    page.wait_for_timeout(500)
    assert hits["relay"] == 0 and _sub(page)["url"] == after["url"]
    page.get_by_role("button", name="Fetch via server…").click()
    page.get_by_role("button", name="Yes, use the server").click()
    page.wait_for_selector(".agenda-subscription-edit .agenda-import-counts", timeout=30_000)
    assert hits["relay"] == 1 and _sub(page)["url"] == after["url"]
    page.get_by_role("button", name="Save new link").click()
    _wait_chip(page, "Via server", True)
    _wait_chip(page, "Nieuwe training", False)
    via = _sub(page)
    assert via["mode"] == "relay" and via["relay_consent_at"] and via["color"] == "teal"
    assert "via server" in card.inner_text()

    # A subscription already using the server asks consent again for a new link before any fetch.
    relay_before = hits["relay"]
    edit.click()
    _link(page).fill(FEED_C)
    page.keyboard.press("Enter")
    page.locator(".agenda-relay-consent").wait_for()
    assert hits["relay"] == relay_before
    page.get_by_role("button", name="No, keep direct").click()
    page.wait_for_timeout(300)
    assert hits["relay"] == relay_before and _sub(page)["url"] == via["url"]
    page.get_by_role("button", name="Cancel").click()

    # Rename without changing the link needs no fetch.
    seen = dict(hits)
    edit.click()
    _name(page).fill("Alleen naam")
    page.keyboard.press("Enter")
    page.wait_for_function("() => NotesStore.listAgendaSubscriptions()[0].name === 'Alleen naam'")
    assert hits == seen

    # The link never shows up in logs, the page URL or unencrypted storage.
    assert not any("SECRET" in m for m in env["logs"]), env["logs"]
    assert "SECRET" not in page.url
    leaked = page.evaluate("() => JSON.stringify([localStorage, sessionStorage]) + document.cookie")
    assert "SECRET" not in leaked and "example.invalid" not in leaked


def test_edit_uses_current_mode_not_form_snapshot(env):
    page, hits = env["page"], env["hits"]
    # The previous test leaves the settings panel open; open it from the agenda only when it is closed.
    if not page.locator("#agenda-calendar-settings").is_visible():
        page.click("#app-tab-agenda")
        page.wait_for_selector("#agenda-add-event", timeout=30_000)
        page.click('[data-agenda-view="week"]')
    page.evaluate("""(a) => {
      const sub = NotesStore.addAgendaSubscription({ name: 'Mode probe', url: a });
      NotesStore.updateAgendaSubscription(sub.id, { mode: 'relay', relay_consent: true });
      NotesAgendaSubs.renderList();
      NotesAgenda.render();
    }""", FEED_A)
    if not page.locator("#agenda-calendar-settings").is_visible():
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)
    page.locator(".agenda-subscription-row", has_text="Mode probe").get_by_role("button", name="Edit").click()

    # The subscription switches to direct while the form is open: saving must use that, not the mode the form was opened with.
    page.evaluate("""() => {
      const s = NotesStore.listAgendaSubscriptions().find((x) => x.name === 'Mode probe');
      NotesStore.updateAgendaSubscription(s.id, { mode: 'direct' });
    }""")
    direct_before, relay_before = hits["c"], hits["relay"]
    _link(page).fill(FEED_C)
    page.keyboard.press("Enter")
    page.wait_for_selector(".agenda-subscription-edit .agenda-import-counts", timeout=30_000)
    assert page.locator(".agenda-relay-consent").count() == 0
    assert hits["c"] == direct_before + 1 and hits["relay"] == relay_before
    page.get_by_role("button", name="Cancel").click()
