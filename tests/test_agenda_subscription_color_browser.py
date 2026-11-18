"""Real-app Chromium test: colour of a subscribed calendar (Calendar settings → Subscribed calendars).

Picking another colour changes the dot in the Calendars list and the week-view events of that
subscription at once, without a reload; it stays after a reload and is stored in the encrypted pack
(the server holds no plain text of it). A subscription without a chosen colour keeps its old slate.
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

PASSWORD = "FeedColorPass1!abc"
FEED = "https://feed-c.example.invalid/rooster.ics"
UNLOCKED_JS = "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()"
SLATE = "rgb(71, 85, 105)"
PURPLE = "rgb(109, 40, 217)"


def _ics():
    day = dt.date.today().strftime("%Y%m%d")
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
        f"UID:c-1@example.invalid\r\nSUMMARY:Rooster dienst\r\nDTSTART:{day}T120000Z\r\nDTEND:{day}T130000Z\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )


@pytest.fixture(scope="module")
def env():
    data = Path(tempfile.mkdtemp(prefix="dg-sub-color-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            context.route("https://feed-c.example.invalid/**", lambda r: r.fulfill(
                status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "text/calendar"},
                body=_ics()))
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "subcolor@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            yield {"page": page, "data": data}
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _open_agenda(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector("#agenda-add-event", timeout=30_000)
    page.click('[data-agenda-view="week"]')


def _open_settings(page):
    if not page.locator("#agenda-calendar-settings:not([hidden])").count():
        page.locator("#agenda-calendar-settings-btn:visible").first.click()
        page.wait_for_selector("#agenda-calendar-settings:not([hidden])", timeout=30_000)


def _colors(page):
    return page.evaluate("""() => ({
      dot: getComputedStyle(document.querySelector('#agenda-calendars-subs .agenda-cal-dot')).backgroundColor,
      chip: getComputedStyle(document.querySelector('.agenda-event-chip')).getPropertyValue('--agenda-accent').trim(),
      label: document.querySelector('.agenda-event-chip .agenda-cal-label')?.textContent || '',
    })""")


def test_pick_colour_changes_dot_and_events_and_persists(env):
    page = env["page"]
    _open_agenda(page)
    page.evaluate("""async (url) => {
      const sub = NotesStore.addAgendaSubscription({ name: 'Team <i>Rooster</i>', url });
      await NotesAgendaSubs.refresh(sub.id);
      NotesAgenda.render();
    }""", FEED)
    page.wait_for_selector(".agenda-event-chip", timeout=30_000)
    _open_settings(page)

    # No colour chosen yet: looks as before (slate), nothing stored.
    assert page.evaluate("() => 'color' in NotesStore.listAgendaSubscriptions()[0]") is False
    before = _colors(page)
    assert before["dot"] == SLATE and before["chip"].lower() == "#475569", before
    group = page.get_by_role("group", name="Colour of Team <i>Rooster</i>")
    assert group.count() == 1
    assert page.locator("#agenda-calendar-settings i").count() == 0
    assert group.get_by_role("radio", name="Slate").is_checked()
    names = group.locator("input[type=radio]").evaluate_all(
        "els => els.map(e => e.closest('label').textContent.replace('Aa', '').trim())")
    assert len(names) >= 8 and all(names), names

    # Pick purple with the keyboard: dot and week-view chip change at once, name label stays.
    group.get_by_role("radio", name="Purple").focus()
    page.keyboard.press("Space")
    page.wait_for_function(
        "c => getComputedStyle(document.querySelector('#agenda-calendars-subs .agenda-cal-dot')).backgroundColor === c",
        arg=PURPLE, timeout=10_000)
    after = _colors(page)
    assert after["chip"].lower() == "#6d28d9" and after["label"] == "Team <i>Rooster</i>", after

    # Encrypted at rest: the server copy has no plain text of the colour key.
    server = page.evaluate("""async () => {
      await NotesStore.flush();
      await NotesStore.pushDirty({ quiet: true });
      return JSON.stringify(await NotesStore.fetchServerItem(NotesStore.AGENDA_PACK_UUID));
    }""")
    assert "ciphertext" in server
    blobs = server.encode() + b"".join(p.read_bytes() for p in env["data"].rglob("*") if p.is_file())
    assert b"purple" not in blobs

    # Stays after a reload.
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="attached", timeout=60_000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120_000)
    _open_agenda(page)
    page.wait_for_selector(".agenda-event-chip", timeout=30_000)
    _open_settings(page)
    again = _colors(page)
    assert again["dot"] == PURPLE and again["chip"].lower() == "#6d28d9", again
    assert page.get_by_role("group", name="Colour of Team <i>Rooster</i>").get_by_role(
        "radio", name="Purple").is_checked()


def _lum(rgb):
    chans = []
    for v in rgb:
        v /= 255
        chans.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2]


def _ratio(fg, bg):
    hi, lo = sorted([_lum(fg), _lum(bg)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _rgb(css):
    return [float(v) for v in css[css.index("(") + 1:css.index(")")].replace(",", " ").split()[:3]]


def test_add_form_colour_resets_after_subscribing(env):
    page = env["page"]
    _open_settings(page)
    form = page.locator("#agenda-subscribe-form")

    def subscribe(name, colour=None):
        before = page.evaluate("() => NotesStore.listAgendaSubscriptions().length")
        page.fill("#agenda-subscribe-url", f"https://feed-c.example.invalid/{name}.ics")
        page.fill("#agenda-subscribe-name", name)
        if colour:
            form.get_by_role("radio", name=colour).check()
        form.locator("button[type=submit]").click()
        page.locator("#agenda-subscribe-preview").get_by_role("button", name="Subscribe", exact=True).click()
        page.wait_for_function("n => NotesStore.listAgendaSubscriptions().length === n", arg=before + 1)
        return page.evaluate("() => NotesStore.listAgendaSubscriptions().slice(-1)[0]")

    first = subscribe("Tweede", "Purple")
    assert first["color"] == "purple"
    # The choice does not carry over into the form for the next subscription.
    assert form.locator("input:checked").count() == 0
    second = subscribe("Derde")
    assert "color" not in second
    assert page.get_by_role("group", name="Colour of Derde").get_by_role("radio", name="Slate").is_checked()


def test_palette_text_contrast_in_both_themes(env):
    page = env["page"]
    _open_settings(page)
    keys = page.evaluate("() => NotesAgendaCalendars.PALETTE.map((p) => p.key)")
    for theme in ("light", "dark"):
        page.evaluate("t => document.querySelector(`[data-theme-opt=\"${t}\"]`).click()", theme)
        page.wait_for_function("t => document.documentElement.dataset.theme === t", arg=theme)
        swatches = page.evaluate("""() => [...document.querySelectorAll('#agenda-subscribe-form .agenda-cal-color')].map((l) => {
          const s = getComputedStyle(l.querySelector('.agenda-cal-color-swatch'));
          return { key: l.querySelector('input').value, fg: s.color, bg: s.backgroundColor };
        })""")
        assert sorted(s["key"] for s in swatches) == sorted(keys), swatches
        for s in swatches:
            ratio = _ratio(_rgb(s["fg"]), _rgb(s["bg"]))
            assert ratio >= 4.5, (theme, s["key"], round(ratio, 2))
    page.evaluate("() => document.querySelector('[data-theme-opt=\"light\"]').click()")


def test_add_form_has_optional_colour(env):
    page = env["page"]
    _open_settings(page)
    group = page.locator("#agenda-subscribe-form").get_by_role("group", name="Colour (optional)")
    assert group.count() == 1
    assert group.locator("input:checked").count() == 0
