"""Real-app Chromium test: agenda event editor and subscribe form polish.

Starts the real Flask app, registers, opens the event editor through the
agenda UI and checks Escape + focus return, linked labels / error texts and
horizontal overflow at 390px and 1280px in light and dark theme.
Skips when Playwright/Chromium is unavailable.
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
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "EditorPass1!abc"
EDITOR_FIELDS = [
    "agenda-edit-title", "agenda-edit-allday", "agenda-edit-start", "agenda-edit-end",
    "agenda-edit-repeat", "agenda-edit-until", "agenda-edit-reminders-custom",
    "agenda-edit-location", "agenda-edit-tz", "agenda-edit-calendar",
    "agenda-edit-webcall", "agenda-edit-notes", "agenda-edit-attendees",
]
# Text fields whose value the browser can reject; each needs a linked, visible error text.
TEXT_ERROR_VALUES = {
    "agenda-edit-reminders-custom": "abc",
    "agenda-edit-webcall": "http://example.com",
    "agenda-subscribe-url": "not a url",
}
# Date inputs only become invalid while partially typed.
DATE_ERROR_FIELDS = ["agenda-edit-start", "agenda-edit-end", "agenda-edit-until"]


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-editor-polish-"))
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
            page.fill('input[name="email"]', "polish@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.evaluate("""async () => {
              const start = new Date(); start.setHours(10, 30, 0, 0);
              if (start.getTime() < Date.now()) start.setDate(start.getDate() + 1);
              NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
                title: 'Polish event', start: start.toISOString(),
                end: new Date(start.getTime() + 3600000).toISOString(), all_day: false });
              await NotesStore.flush();
            }""")
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-root [data-agenda-id]", timeout=30_000)
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _setup(page, width, theme):
    page.set_viewport_size({"width": width, "height": 800 if width > 500 else 844})
    page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)


def _open_editor(page):
    opener = page.locator("[data-agenda-id]").first
    opener.click()
    page.wait_for_timeout(150)
    if page.locator("#agenda-detail-card:not([hidden])").count():
        page.click("#agenda-detail-edit")
        page.wait_for_timeout(150)
    if page.locator("#agenda-scope-chooser:not([hidden])").count():
        page.click('[data-agenda-edit-scope="series"]')
    page.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)


def _assert_error_linked(page, fid, bad_value=None):
    err_id = fid + "-error"
    assert page.evaluate("(id) => document.getElementById(id).getAttribute('aria-describedby')", fid) == err_id
    assert page.evaluate("(id) => document.getElementById(id).tagName", err_id) == "P"
    field = page.locator("#" + fid)
    field.scroll_into_view_if_needed()
    assert not page.locator("#" + err_id).is_visible(), f"{fid}: error shown while pristine"
    if bad_value is None:
        # Leave the date incomplete by clearing one segment of a filled-in value.
        if not page.evaluate("(id) => !!document.getElementById(id).value", fid):
            field.fill("2030-01-15")
        field.click()
        page.keyboard.press("Backspace")
    else:
        field.fill(bad_value)
    field.blur()
    assert page.evaluate("(id) => document.getElementById(id).validity.valid", fid) is False, fid
    assert page.locator("#" + err_id).is_visible(), f"{fid}: error text not shown"
    assert page.locator("#" + err_id).inner_text().strip(), fid


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_editor_escape_focus_labels_and_overflow(session, width, theme):
    page = session
    _setup(page, width, theme)
    _open_editor(page)

    ov = page.evaluate("""() => {
      const de = document.documentElement, ed = document.getElementById('agenda-editor');
      const r = ed.getBoundingClientRect(), sc = ed.querySelector('.agenda-editor-scroll');
      return { page: de.scrollWidth - de.clientWidth, dialog: sc.scrollWidth - sc.clientWidth,
               inView: r.left >= -0.5 && r.right <= de.clientWidth + 0.5 };
    }""")
    assert ov["page"] <= 0 and ov["dialog"] <= 0 and ov["inView"], ov

    # Heading matches the shared dialog heading. Delete leads as the destructive action; Cancel comes
    # before the primary action, the same relative order as the buttons in #confirm-dialog.
    heading, order, confirm_order = page.evaluate("""() => {
      const h = document.getElementById('agenda-edit-visible-title'), c = document.getElementById('confirm-title');
      const btns = (sel) => Array.from(document.querySelectorAll(sel)).filter(b => !b.hidden).map(b => b.id);
      return [
        [getComputedStyle(h).fontSize, getComputedStyle(h).fontWeight],
        btns('#agenda-editor .agenda-editor-actions .btn'),
        btns('#confirm-dialog .confirm-dialog-actions .btn')];
    }""")
    assert heading[0] == "18px"
    assert heading[1] == page.evaluate("() => getComputedStyle(document.getElementById('confirm-title')).fontWeight")
    assert order == ["agenda-edit-delete", "agenda-edit-cancel", "agenda-edit-save"]
    assert confirm_order == ["confirm-cancel", "confirm-ok"]

    page.keyboard.press("Escape")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=5000)
    # Focus is back on the agenda element that opened the editor.
    assert page.evaluate("document.activeElement.closest('[data-agenda-id]') !== null")


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_editor_labels_and_linked_error_texts(session, width, theme):
    page = session
    _setup(page, width, theme)
    _open_editor(page)
    for fid in EDITOR_FIELDS:
        text = page.evaluate(
            "(id) => { const l = document.getElementById(id).labels; return l.length ? l[0].textContent.trim() : ''; }",
            fid)
        assert text, f"{fid} has no linked label"
    for fid in DATE_ERROR_FIELDS:
        _assert_error_linked(page, fid)
    for fid, bad in TEXT_ERROR_VALUES.items():
        if fid.startswith("agenda-edit"):
            _assert_error_linked(page, fid, bad)
    # The editor is now dirty: Escape asks before discarding, and confirming closes it.
    page.keyboard.press("Escape")
    page.wait_for_selector("#confirm-dialog:not([hidden])", timeout=5000)
    page.click("#confirm-ok")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=5000)


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_subscribe_form_labels_error_and_overflow(session, width, theme):
    page = session
    _setup(page, width, theme)
    # On phones the calendar menu sits inside the "⋯" agenda menu. The agenda renders
    # two buttons with this id (side rail / phone menu); only one is visible.
    if page.locator("#agenda-calendar-settings:not([hidden])").count():
        page.click("#agenda-calendar-settings-close")
    page.evaluate("document.getElementById('agenda-subscribe-form').reset()")  # clears user-invalid state
    if not page.locator("#agenda-calendar-settings-btn:visible").count():
        page.click("#agenda-phone-more")
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])")
    for fid in ("agenda-subscribe-url", "agenda-subscribe-name"):
        assert page.evaluate("(id) => document.getElementById(id).labels.length", fid) == 1
    _assert_error_linked(page, "agenda-subscribe-url", TEXT_ERROR_VALUES["agenda-subscribe-url"])
    ov = page.evaluate("""() => { const de = document.documentElement,
      p = document.getElementById('agenda-calendar-settings');
      return { page: de.scrollWidth - de.clientWidth, panel: p.scrollWidth - p.clientWidth }; }""")
    assert ov["page"] <= 0 and ov["panel"] <= 0, ov
    page.click("#agenda-calendar-settings-close")
    page.wait_for_selector("#agenda-calendar-settings", state="hidden", timeout=5000)


REMINDER_SAMPLES = [
    "20", "20, 120", " 20 ; 30 ", "00020", "0", "40320", "40321", "99999", "1234567", "20,,30", " , ", "20 abc", "abc",
]
WEBCALL_SAMPLES = [
    "HTTPS://example.com/meet", "https://example.com", "Https://example.com/x", "http://example.com",
    "https:/example.com", "https://", "https://a b",
]


@pytest.mark.parametrize("width", [390, 1280])
def test_reminder_and_meeting_link_patterns_match_parser(session, width):
    page = session
    _setup(page, width, "light")
    _open_editor(page)
    # Each field's own pattern (or type=url) must accept exactly what agenda.js accepts when it saves.
    result = page.evaluate("""([reminderSamples, webcallSamples]) => {
      const R = window.NotesAgendaReminders, I = window.NotesAgendaIcs;
      const custom = document.getElementById('agenda-edit-reminders-custom');
      const webcall = document.getElementById('agenda-edit-webcall');
      const reminderMismatch = [], webcallMismatch = [];
      for (const s of reminderSamples) {
        custom.value = s;
        const tokens = s.split(/[\\s,;]+/).filter(Boolean);
        const parsed = tokens.length > 0 && tokens.every(t => R.offsetMinutes([t]).length === 1);
        if (custom.validity.patternMismatch === parsed) reminderMismatch.push(s);
      }
      for (const s of webcallSamples) {
        webcall.value = s;
        const parsed = I.sanitizeHttpsUrl(s) !== '';
        if (webcall.validity.valid !== parsed) webcallMismatch.push(s);
      }
      return { reminderMismatch, webcallMismatch };
    }""", [REMINDER_SAMPLES, WEBCALL_SAMPLES])
    assert result == {"reminderMismatch": [], "webcallMismatch": []}, result
    _close_editor_discarding(page)


def test_invalid_editor_fields_set_aria_invalid(session):
    page = session
    _setup(page, 1280, "light")
    _open_editor(page)
    field = page.locator("#agenda-edit-webcall")
    field.fill("http://example.com")
    field.blur()
    assert page.locator("#agenda-edit-webcall-error").is_visible()
    assert field.get_attribute("aria-invalid") == "true"
    field.fill("https://example.com")
    field.blur()
    assert field.get_attribute("aria-invalid") == "false"
    _close_editor_discarding(page)


@pytest.mark.parametrize("width", [390, 1280])
def test_editor_stacked_labels_share_one_column(session, width):
    page = session
    _setup(page, width, "light")
    _open_editor(page)
    # Top-level fields sit in one single-column grid: same left edge and width, label above field.
    grid = page.evaluate("""() => Array.from(document.querySelectorAll('#agenda-editor .agenda-editor-scroll > .settings-row.stacked'))
      .filter(l => l.getClientRects().length > 0)
      .map(l => { const cs = getComputedStyle(l), r = l.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), dir: cs.flexDirection, gap: cs.rowGap }; })""")
    assert len(grid) == 7, grid
    assert len({g["left"] for g in grid}) == 1, grid
    assert len({g["width"] for g in grid}) == 1, grid
    assert {(g["dir"], g["gap"]) for g in grid} == {("column", "8px")}, grid
    _close_editor_discarding(page)


def _close_editor_discarding(page):
    page.keyboard.press("Escape")
    if page.locator("#confirm-dialog:not([hidden])").count():
        page.click("#confirm-ok")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=5000)
