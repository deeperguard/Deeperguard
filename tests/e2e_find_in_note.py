"""E2E (Playwright): Ctrl+F finds text inside the open note and only there.

Checks in the real page: Ctrl+F with focus outside the note leaves the find bar
closed; Ctrl+F with focus in the note opens it and focuses the find box; the
counter (#find-count, aria-live) reads "n/m" and follows Enter (next), Shift+Enter
(previous, wrapping at both ends) and a query with no hits reads "0/0"; Esc closes
the bar. Any page error fails the run.

Missing Playwright is a failure, not a skip.

    python tests/e2e_find_in_note.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

BODY = "alpha beta\nalpha gamma\nalpha"


def new_note(page) -> None:
    page.locator("#btn-new, #btn-empty-new, #btn-new-list, #fab-add").locator("visible=true").first.click()


def expect_counter(page, text: str) -> None:
    try:
        page.wait_for_function(
            "(t) => document.getElementById('find-count').textContent === t",
            arg=text,
            timeout=5000,
        )
    except Exception:
        got = page.text_content("#find-count")
        state = page.evaluate("() => [document.getElementById('find-input').value, document.getElementById('note-body').value]")
        raise AssertionError(f"find counter is {got!r}, wanted {text!r}; find input and body: {state!r}")


def bar_open(page) -> bool:
    return page.evaluate("() => !document.getElementById('find-bar').hidden")


def focused_id(page) -> str:
    return page.evaluate("() => document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : ''")


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-find-in-note-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on(
                "console",
                lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None,
            )
            register(page, base)

            new_note(page)
            page.wait_for_selector("#note-title", state="visible")
            page.fill("#note-title", "Zoeken")
            page.fill("#note-body", BODY)
            page.evaluate("() => NotesStore.flush && NotesStore.flush()")

            # Focus outside the note: Ctrl+F must not open the note's find bar.
            page.click("#search")
            page.keyboard.press("Control+f")
            page.wait_for_timeout(200)
            assert not bar_open(page), "Ctrl+F outside the note opened the find bar"

            # Focus in the note: Ctrl+F opens the bar and focuses its input.
            page.click("#note-body")
            page.keyboard.press("Control+f")
            page.wait_for_function("() => !document.getElementById('find-bar').hidden", timeout=5000)
            assert focused_id(page) == "INPUT#find-input", focused_id(page)
            page.fill("#find-input", "alpha")
            expect_counter(page, "1/3")
            assert page.get_attribute("#find-count", "aria-live") == "polite"

            # Selecting a match moves focus into the note, so the find box is
            # focused again before each key that is meant for it.
            page.focus("#find-input")
            page.keyboard.press("Enter")
            expect_counter(page, "2/3")
            page.focus("#find-input")
            page.keyboard.press("Enter")
            expect_counter(page, "3/3")
            page.focus("#find-input")
            page.keyboard.press("Enter")
            expect_counter(page, "1/3")
            page.focus("#find-input")
            page.keyboard.press("Shift+Enter")
            expect_counter(page, "3/3")

            page.fill("#find-input", "zzz")
            expect_counter(page, "0/0")
            page.fill("#find-input", "alpha")
            expect_counter(page, "1/3")

            # Ctrl+F from the note again while the bar is open keeps it open.
            page.click("#note-body")
            page.keyboard.press("Control+f")
            assert bar_open(page), "second Ctrl+F closed the find bar"
            assert page.input_value("#find-input") == "alpha"
            expect_counter(page, "1/3")

            page.focus("#find-input")
            page.keyboard.press("Escape")
            page.wait_for_function("() => document.getElementById('find-bar').hidden", timeout=5000)
            assert focused_id(page) != "INPUT#find-input", "Esc left focus in the closed find box"

            # Chromium logs this on every page load because the CSP is delivered
            # via <meta>; it is unrelated to find.
            errors = [e for e in errors if "'frame-ancestors' is ignored" not in e]
            assert not errors, errors
            browser.close()
        print("e2e_find_in_note ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
