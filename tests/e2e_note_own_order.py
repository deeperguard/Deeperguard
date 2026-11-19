"""E2E (Playwright): "Own order" sort choice inside a label.

Three notes carry one label. "Own order" is picked in the sort select, a note is moved
with Alt+Up (focus stays on the moved row) and with the row's move-down button, and
after a reload and a new unlock the select still says "Own order" and the order is the
same. Any pageerror / console.error
fails the test.

    python tests/e2e_note_own_order.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

SYNCED_JS = "() => NotesStore.state.dirty.size === 0"
UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

SEED_JS = """() => {
  const label = NotesStore.createTag('Trip');
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    NotesStore.upsert(crypto.randomUUID(), { type: 'note', title, body: title, tags: [label] });
  }
  return label;
}"""

TITLES_JS = "() => [...document.querySelectorAll('#note-list .note-row h3')].map((e) => e.textContent.trim())"


def unlock(page) -> None:
    page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-ownorder-"))
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
            page.locator("#btn-nav-pin").click()
            page.wait_for_function("() => document.body.classList.contains('nav-pinned')")
            label = page.evaluate(SEED_JS)
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
            page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 3")

            # Without a chosen order the list is Recent; Own order shows no move buttons yet.
            assert page.locator(".note-row-move").count() == 0
            page.select_option("#sort-select", "manual")
            page.wait_for_function("() => document.querySelectorAll('.note-row-move').length === 6")
            # Old notes without keys: newest created first, nothing missing.
            assert sorted(page.evaluate(TITLES_JS)) == ["Alpha", "Beta", "Gamma"]
            start = page.evaluate(TITLES_JS)

            # Alt+Up on the last row moves it up; focus stays on that note.
            last = start[-1]
            page.locator(".note-row", has_text=last).locator(".note-item").focus()
            page.keyboard.press("Alt+ArrowUp")
            expected = [start[0], last, start[1]]
            page.wait_for_function(
                "(t) => JSON.stringify([...document.querySelectorAll('#note-list .note-row h3')].map((e) => e.textContent.trim())) === JSON.stringify(t)",
                arg=expected,
            )
            assert page.evaluate("() => document.activeElement.closest('.note-row').querySelector('h3').textContent.trim()") == last
            # Move-down button on the first row.
            page.locator(".note-row").first.locator(".note-row-move[data-dir='1']").click()
            expected = [expected[1], expected[0], expected[2]]
            page.wait_for_function(
                "(t) => JSON.stringify([...document.querySelectorAll('#note-list .note-row h3')].map((e) => e.textContent.trim())) === JSON.stringify(t)",
                arg=expected,
            )
            assert page.evaluate(TITLES_JS) == expected

            # The order is stored in the label, not in the notes.
            keys = page.evaluate("(id) => Object.keys(NotesStore.get(id).content.note_keys || {}).length", label)
            assert keys == 3, keys

            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 3")
            assert page.evaluate("() => document.getElementById('sort-select').value") == "manual"
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
            page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 3")
            assert page.evaluate(TITLES_JS) == expected, page.evaluate(TITLES_JS)

            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_own_order ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
