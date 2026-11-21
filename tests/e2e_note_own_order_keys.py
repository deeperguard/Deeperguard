"""E2E (Playwright): repeated Alt+Down / Alt+Up in "Own order" move a note one place per key press.

Three notes carry one label. The top note is clicked, then Alt+Down, Alt+Down, Alt+Up,
Alt+Down, Alt+Down are pressed: after every press the DOM order changed by exactly one
place (or stayed at the bottom) and the moved row still has focus. Every press also sets the
polite status region #toast to its announcement ("Moved to position N of 3", or "Already
first" / "Already last" at the edges). After a second click five more Alt+Down presses push
the note to the bottom. After a reload and a new unlock the saved order is the same. Any
pageerror / console.error fails the test.

    python tests/e2e_note_own_order_keys.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_own_order import SYNCED_JS, TITLES_JS, unlock  # noqa: E402
from e2e_note_own_order_click import SAME_ORDER_JS  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

SEED_JS = """() => {
  const label = NotesStore.createTag('Trip');
  for (const title of ['Testnotitie A', 'Boodschappen', 'Cadeaus']) {
    NotesStore.upsert(crypto.randomUUID(), { type: 'note', title, body: title, tags: [label] });
  }
}"""
FOCUSED_TITLE_JS = "() => document.activeElement.closest?.('.note-row')?.querySelector('h3')?.textContent.trim() || ''"
ANNOUNCED_JS = """(text) => {
  const el = document.getElementById('toast');
  return el.getAttribute('role') === 'status' && el.getAttribute('aria-live') === 'polite'
    && !el.hidden && el.textContent.trim() === text;
}"""


def open_label(page) -> None:
    page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
    page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
    page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 3")


def press_and_expect(page, key: str, moved: str, expected: list[str], announce: str) -> None:
    page.keyboard.press(key)
    page.wait_for_function(SAME_ORDER_JS, arg=expected, timeout=10000)
    assert page.evaluate(FOCUSED_TITLE_JS) == moved, (key, page.evaluate(FOCUSED_TITLE_JS))
    page.wait_for_function(ANNOUNCED_JS, arg=announce, timeout=10000)


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-ownorder-keys-"))
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
            page.wait_for_function("() => document.querySelectorAll('.note-row-move').length === 6")
            a, b, c = page.evaluate(TITLES_JS)
            assert sorted([a, b, c]) == ["Boodschappen", "Cadeaus", "Testnotitie A"]

            # Focus the top row by clicking it, then press Alt+Down / Alt+Up in turn.
            page.locator(".note-row", has_text=a).locator(".note-item").click()
            press_and_expect(page, "Alt+ArrowDown", a, [b, a, c], "Moved to position 2 of 3")
            press_and_expect(page, "Alt+ArrowDown", a, [b, c, a], "Moved to position 3 of 3")
            press_and_expect(page, "Alt+ArrowUp", a, [b, a, c], "Moved to position 2 of 3")
            press_and_expect(page, "Alt+ArrowDown", a, [b, c, a], "Moved to position 3 of 3")
            # Already last: nothing moves, the row keeps focus.
            press_and_expect(page, "Alt+ArrowDown", a, [b, c, a], "Already last")

            # Click the row again; two presses up to the top, then one more at the top, then five down.
            page.locator(".note-row", has_text=a).locator(".note-item").click()
            press_and_expect(page, "Alt+ArrowUp", a, [b, a, c], "Moved to position 2 of 3")
            press_and_expect(page, "Alt+ArrowUp", a, [a, b, c], "Moved to position 1 of 3")
            # Already first: nothing moves, the row keeps focus.
            press_and_expect(page, "Alt+ArrowUp", a, [a, b, c], "Already first")
            for expected, announce in (
                ([b, a, c], "Moved to position 2 of 3"),
                ([b, c, a], "Moved to position 3 of 3"),
                ([b, c, a], "Already last"),
                ([b, c, a], "Already last"),
                ([b, c, a], "Already last"),
            ):
                press_and_expect(page, "Alt+ArrowDown", a, expected, announce)

            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 3")
            open_label(page)
            assert page.evaluate("() => document.getElementById('sort-select').value") == "manual"
            page.wait_for_function(SAME_ORDER_JS, arg=[b, c, a], timeout=30000)

            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_own_order_keys ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
