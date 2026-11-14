"""E2E (Playwright): typing `[[Bo` opens the note link picker and inserts a link.

Regression for "listNotes is not defined": the picker's candidate list called a
bare listNotes() instead of NotesStore.listNotes(), so no picker appeared and
the console logged a script error. Any pageerror / console.error fails the test.

    python tests/e2e_note_link_picker.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402


def new_note(page) -> None:
    page.locator("#btn-new, #btn-empty-new, #btn-new-list, #fab-add").locator("visible=true").first.click()


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-linkpicker-"))
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

            # Note A with a known title.
            new_note(page)
            page.wait_for_selector("#note-title", state="visible")
            page.fill("#note-title", "Boodschappen")
            page.fill("#note-body", "melk en brood")
            page.evaluate("() => NotesStore.flush && NotesStore.flush()")

            # Second note: type [[Bo.
            new_note(page)
            page.wait_for_selector("#note-title", state="visible")
            page.fill("#note-title", "Tweede")
            page.click("#note-body")
            page.keyboard.type("Zie ook [[Bo")

            option = page.locator(".note-link-picker-option", has_text="Boodschappen")
            option.wait_for(state="visible", timeout=10000)
            option.dispatch_event("mousedown")

            page.wait_for_function(
                "() => /\\[[^\\]]*Boodschappen[^\\]]*\\]/.test(document.getElementById('note-body').value)"
                " && !document.getElementById('note-body').value.includes('[[Bo')",
                timeout=10000,
            )
            # Chromium logs this on every page load because the CSP is delivered
            # via <meta>; it is unrelated to the picker.
            errors = [e for e in errors if "'frame-ancestors' is ignored" not in e]
            assert not errors, errors
            browser.close()
        print("e2e_note_link_picker ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
