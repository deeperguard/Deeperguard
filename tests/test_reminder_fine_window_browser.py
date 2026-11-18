"""Real-app Chromium test: the opt-in 5-minute reminder window in Calendar settings.

Starts the real Flask app with a Pro account, opens Calendar settings and drives the select by
keyboard. Checks the label and description, that the choice is stored and restored, that the texts
naming the window follow it, and the layout at 390px and 1280px in light and dark.
Skips when Playwright/Chromium is unavailable.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "WindowPass1!abc"
SELECT = "#agenda-reminder-window"
PREF = "() => JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}').reminder_window_min"
TEXT = "(id) => document.getElementById(id).textContent"


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-fine-window-"))
    port = free_port()
    real_popen = subprocess.Popen

    def pro_popen(args, **kw):
        kw["env"] = {**kw["env"], "NOTES_DEFAULT_PLAN": "pro"}
        return real_popen(args, **kw)

    with mock.patch("run_agenda_editor_browser.subprocess.Popen", pro_popen):
        proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            pg = browser.new_page(viewport={"width": 1280, "height": 800})
            pg.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', "window@e2e.invalid")
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
            pg.click("#agenda-calendar-settings-btn")
            pg.wait_for_selector(SELECT, state="visible", timeout=30_000)
            yield pg
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def test_default_is_fifteen_minutes_with_label_and_disclosure(page):
    assert page.input_value(SELECT) == "15"
    assert page.evaluate(PREF) is None
    assert page.get_by_label("Timing when Deeperguard is closed").evaluate("el => el.id") == "agenda-reminder-window"
    described = page.get_attribute(SELECT, "aria-describedby")
    note = page.locator(f"#{described}")
    assert note.is_visible()
    text = " ".join(note.inner_text().split())
    for needed in (
        "at most 5 minutes early instead of 15",
        "our server then learns when each of those reminders is due to within 5 minutes instead of 15",
        "can tell that you chose this",
        "never sent",
        "once every 5 minutes",
    ):
        assert needed in text, needed
    assert "15-minute window" in page.evaluate(TEXT, "agenda-reminder-email-explainer")


def test_email_checkbox_is_off_and_announces_what_the_server_sees(page):
    email = page.locator("#agenda-reminder-email")
    assert not email.is_checked()
    assert page.get_by_label("Email reminders").evaluate("el => el.id") == "agenda-reminder-email"
    # The accessible description a screen reader announces with the checkbox: the disclosure, then the
    # status line (this account has not confirmed its address, so the checkbox is disabled and says why).
    assert email.is_disabled()
    sync_api.expect(email).to_have_accessible_description(re.compile(
        r"^Off by default\..*only the 15-minute window.*never which event\..*not end-to-end encrypted\."
        r" Confirm your email address to receive email reminders\.\s*$"))


def test_keyboard_choice_is_stored_restored_and_reflected_in_the_texts(page):
    page.focus(SELECT)
    assert page.evaluate("(s) => document.querySelector(s).matches(':focus-visible')", SELECT)
    ring = page.evaluate(
        "(s) => { const c = getComputedStyle(document.querySelector(s));"
        " return c.outlineStyle !== 'none' || c.boxShadow !== 'none'; }", SELECT)
    assert ring, "the focused select shows a focus ring"
    page.keyboard.press("ArrowDown")
    assert page.input_value(SELECT) == "5"
    assert page.evaluate(PREF) == 5
    assert page.evaluate("() => NotesAgendaReminders.serverWindowSec()") == 300
    email = page.evaluate(TEXT, "agenda-reminder-email-explainer")
    assert "only the 5-minute window" in email and "up to 5 minutes early" in email and "15" not in email
    assert "Email reminders show only a 5-minute window" in page.evaluate(TEXT, "agenda-reminder-visibility")
    assert "learns a 5-minute window" in page.evaluate(TEXT, "note-reminder-hint")

    # Reopening the settings shows the stored choice, not the markup default.
    page.evaluate("(s) => { document.querySelector(s).value = '15'; }", SELECT)
    page.evaluate("() => NotesAgendaReminders.wireAgendaReminderSettings()")
    assert page.input_value(SELECT) == "5"

    # The same choice again changes nothing; going back restores the default everywhere.
    page.select_option(SELECT, "5")
    assert page.evaluate(PREF) == 5
    page.focus(SELECT)
    page.keyboard.press("ArrowUp")
    assert page.input_value(SELECT) == "15"
    assert page.evaluate(PREF) is None
    assert page.evaluate("() => NotesAgendaReminders.serverWindowSec()") == 900
    assert "only the 15-minute window" in page.evaluate(TEXT, "agenda-reminder-email-explainer")
    assert "Email reminders show only a 15-minute window" in page.evaluate(TEXT, "agenda-reminder-visibility")
    assert "learns a 15-minute window" in page.evaluate(TEXT, "note-reminder-hint")


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_fits_and_is_readable(page, width, theme):
    page.set_viewport_size({"width": width, "height": 844 if width < 500 else 800})
    page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)
    page.locator(SELECT).scroll_into_view_if_needed()
    box = page.evaluate(
        """(s) => {
          const el = document.querySelector(s);
          const panel = document.getElementById('agenda-calendar-settings').getBoundingClientRect();
          const note = document.getElementById('agenda-reminder-window-explainer');
          const r = el.getBoundingClientRect();
          const n = note.getBoundingClientRect();
          const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
          const cs = getComputedStyle(el);
          return { left: r.left, right: r.right, height: r.height, pl: panel.left, pr: panel.right,
                   nl: n.left, nr: n.right, clipped: note.scrollWidth > note.clientWidth + 1,
                   contrast: Math.abs(lum(cs.color) - lum(cs.backgroundColor)) };
        }""", SELECT)
    assert box["left"] >= box["pl"] - 1 and box["right"] <= box["pr"] + 1, box
    assert box["nl"] >= box["pl"] - 1 and box["nr"] <= box["pr"] + 1, box
    assert not box["clipped"], box
    assert box["height"] >= 24, box
    assert box["contrast"] > 80, box
