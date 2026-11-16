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

PASSWORD = "EmptyTitlePass1!abc"


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
            pg.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', "emptytitle@e2e.invalid")
            pg.fill("#register-password", PASSWORD)
            pg.fill("#register-password2", PASSWORD)
            pg.check("#register-terms")
            pg.check("#register-recover-ack")
            pg.click("#register-submit")
            pg.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
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
    page.click("#agenda-edit-cancel")
    if page.locator("#confirm-ok:visible").count():
        page.click("#confirm-ok")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=5000)


def test_valid_title_saves_then_edit_blank_blocked_and_untitled_renamable(page):
    _add_event(page)
    page.fill("#agenda-edit-title", "Planning")
    page.click("#agenda-edit-save")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    titles = page.evaluate("() => NotesStore.listAgendaEvents().map(e => e.title)")
    assert "Planning" in titles

    # Edit: blank title does not save.
    page.locator("#agenda-root [data-agenda-id]").first.click()
    page.wait_for_timeout(200)
    if page.locator("#agenda-detail-card:not([hidden])").count():
        page.click("#agenda-detail-edit")
    if page.locator("#agenda-scope-chooser:not([hidden])").count():
        page.click('[data-agenda-edit-scope="series"]')
    page.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)
    page.fill("#agenda-edit-title", "  ")
    page.click("#agenda-edit-save")
    _assert_blocked(page, "")
    titles = page.evaluate("() => NotesStore.listAgendaEvents().map(e => e.title)")
    assert titles == ["Planning"]

    # An existing event titled 'Untitled' opens and can get a new title.
    page.fill("#agenda-edit-title", "Untitled")
    page.click("#agenda-edit-save")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    page.locator("#agenda-root [data-agenda-id]").first.click()
    page.wait_for_timeout(200)
    if page.locator("#agenda-detail-card:not([hidden])").count():
        page.click("#agenda-detail-edit")
    if page.locator("#agenda-scope-chooser:not([hidden])").count():
        page.click('[data-agenda-edit-scope="series"]')
    page.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)
    assert page.input_value("#agenda-edit-title") == "Untitled"
    page.fill("#agenda-edit-title", "Renamed")
    page.click("#agenda-edit-save")
    page.wait_for_selector("#agenda-editor", state="hidden", timeout=10_000)
    titles = page.evaluate("() => NotesStore.listAgendaEvents().map(e => e.title)")
    assert titles == ["Renamed"]
