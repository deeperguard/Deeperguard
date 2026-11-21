"""E2E (Playwright): Alt+Down / Alt+Up move a note in "Own order" after it was opened by a click.

Clicking a row opens the note and leaves focus on <body> (the list re-renders), so the
Alt+Arrow handler must act on the open note, not only on a focused row. Two notes carry
one label; the first row is clicked, Alt+Down puts it one place lower, Alt+Up puts it back,
Alt+Down again and, after a reload and a new unlock, the saved order is still the new one.
Any pageerror / console.error fails the test.

    python tests/e2e_note_own_order_click.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_own_order import SYNCED_JS, TITLES_JS, unlock  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

SEED_JS = """() => {
  const label = NotesStore.createTag('Trip');
  for (const title of ['Testnotitie A', 'Boodschappen']) {
    NotesStore.upsert(crypto.randomUUID(), { type: 'note', title, body: title, tags: [label] });
  }
}"""
SAME_ORDER_JS = "(t) => JSON.stringify([...document.querySelectorAll('#note-list .note-row h3')].map((e) => e.textContent.trim())) === JSON.stringify(t)"


def open_label(page) -> None:
    page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
    page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
    page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 2")


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-ownorder-click-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_context(viewport={"width": 1400, "height": 1500}).new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on(
                "console",
                lambda m: errors.append(f"console.error: {m.text}")
                if m.type == "error" and "frame-ancestors" not in m.text
                else None,
            )
            register(page, base)
            page.evaluate(SEED_JS)
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#btn-nav-pin").click()
            open_label(page)
            page.select_option("#sort-select", "manual")
            page.wait_for_function("() => document.querySelectorAll('.note-row-move').length === 4")
            start = page.evaluate(TITLES_JS)
            assert sorted(start) == ["Boodschappen", "Testnotitie A"], start
            first, second = start

            # Click (not focus) the top note, then Alt+Down moves it one place down.
            page.locator(".note-row", has_text=first).locator(".note-item").click()
            page.wait_for_function("() => document.activeElement === document.body")
            page.keyboard.press("Alt+ArrowDown")
            page.wait_for_function(SAME_ORDER_JS, arg=[second, first])
            # Alt+Up puts it back one place up.
            page.keyboard.press("Alt+ArrowUp")
            page.wait_for_function(SAME_ORDER_JS, arg=[first, second])
            page.keyboard.press("Alt+ArrowDown")
            page.wait_for_function(SAME_ORDER_JS, arg=[second, first])

            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 2")
            open_label(page)
            assert page.evaluate("() => document.getElementById('sort-select').value") == "manual"
            assert page.evaluate(TITLES_JS) == [second, first], page.evaluate(TITLES_JS)

            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_own_order_click ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
