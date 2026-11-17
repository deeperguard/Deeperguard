"""E2E (Playwright): a private reminder on a note.

The reminder is set and changed in the note info panel, shows as a chip in the
note list, survives reload + unlock, and can be removed. Its time never appears
in clear in any request to the server, and a note saved before the field existed
loads without errors. Any pageerror / console.error fails the test.

    python tests/e2e_note_private_reminder.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

SEED_JS = """() => {
  // Old shape: no `reminders` key at all.
  NotesStore.upsert(crypto.randomUUID(), { type: 'note', title: 'Legacy', body: 'old', folder_id: '' });
  NotesStore.upsert(crypto.randomUUID(), { type: 'note', title: 'Fresh', body: 'new', folder_id: '' });
}"""

STORED_JS = """() => Object.fromEntries(NotesStore.listNotes()
  .filter((n) => n.content.type === 'note')
  .map((n) => [n.content.title, n.content.reminders || null]))"""

# Compact rows show a bell glyph, comfortable rows a chip.
INDICATOR = ".note-glyph-reminder, .note-tag-reminder"
WHEN_LOCAL = "2031-03-04T05:06"
# Plaintext forms of the two times used below (browser runs in UTC).
LEAK_NEEDLES = ("2031-03-04", "2031-01-02", "05:06", "1930838760", "1925795040")


def unlock(page) -> None:
    page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


def open_info(page, title: str) -> None:
    page.locator(".note-row", has_text=title).first.click()
    page.locator("#btn-editor-overflow-desktop").click()
    page.locator("#btn-note-info").click()
    page.locator("#note-reminder-at").wait_for(state="visible")


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-notereminder-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    sent: list[tuple[str, str]] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 1400, "height": 1500}, timezone_id="UTC")
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on(
                "console",
                lambda m: errors.append(f"console.error: {m.text}")
                if m.type == "error" and "frame-ancestors" not in m.text
                else None,
            )
            page.on(
                "request",
                lambda r: sent.append((r.url, r.post_data or "")) if r.method != "GET" else None,
            )
            register(page, base)
            page.evaluate(SEED_JS)
            page.wait_for_timeout(1500)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator(".note-row", has_text="Fresh").first.wait_for()
            assert page.locator(INDICATOR).count() == 0
            assert page.evaluate(STORED_JS) == {"Legacy": None, "Fresh": None}

            # Set, then change, the reminder.
            open_info(page, "Fresh")
            page.fill("#note-reminder-at", "2031-01-02T03:04")
            page.locator("#note-reminder-save").click()
            page.fill("#note-reminder-at", WHEN_LOCAL)
            page.locator("#note-reminder-save").click()
            chip = page.locator(".note-row", has_text="Fresh").locator(INDICATOR)
            chip.wait_for(state="visible")
            assert "Reminder" in (chip.get_attribute("aria-label") or "")
            # Compact rows: the glyph is the same SVG bell as the chip, not an emoji.
            assert page.locator(".note-glyph-reminder svg").count() == 1
            assert "🔔" not in page.locator(".note-glyph-reminder").inner_text()
            stored = page.evaluate(STORED_JS)
            assert stored["Fresh"] == [{"at": "2031-03-04T05:06:00.000Z", "push": False}], stored
            assert stored["Legacy"] is None
            page.wait_for_timeout(2500)

            # Reload + unlock: still there.
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator(".note-row", has_text="Fresh").locator(INDICATOR).wait_for()
            assert page.locator(".note-row", has_text="Legacy").locator(INDICATOR).count() == 0
            # Comfortable rows: own style, not the e-mail warning's; a future time is not shown as passed.
            page.locator("#btn-list-density").click()
            page.locator(".note-tag-reminder").wait_for(state="visible")
            assert page.locator(".note-tag-reminder").count() == 1
            assert page.locator(".note-tag-reminder.note-tag-warn").count() == 0
            assert page.locator(".note-tag-reminder-past").count() == 0
            assert page.locator(".note-tag-reminder svg").count() == 1
            page.locator("#btn-list-density").click()
            open_info(page, "Fresh")
            assert page.input_value("#note-reminder-at") == WHEN_LOCAL

            # The time is nowhere in clear in what was sent, and no plaintext reminder row was made.
            assert any("/api/sync" in url for url, _ in sent), "expected the encrypted note to be synced"
            for url, body in sent:
                assert "/api/reminders" not in url, url
                for needle in LEAK_NEEDLES:
                    assert needle not in body, (url, needle)

            # Clear: chip goes, and it stays gone after reload.
            page.locator("#note-reminder-clear").click()
            page.wait_for_function("() => !document.querySelector('.note-glyph-reminder, .note-tag-reminder')")
            page.wait_for_timeout(2500)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator(".note-row", has_text="Fresh").first.wait_for()
            assert page.locator(INDICATOR).count() == 0
            assert page.evaluate(STORED_JS) == {"Legacy": None, "Fresh": None}
            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_private_reminder ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
