"""E2E (Playwright): an open table editor closes when the Markdown source is typed in outside it, and says so.

Checks in the real page: a cell edit made in the table editor keeps the panel open and shows no
notice; typing in the Markdown source closes the panel and shows the notice "Table editor closed";
the notice is shown once per close, not again on the next keystroke. Any page error fails the run.

Missing Playwright is a failure, not a skip.

    python tests/e2e_table_editor_outside_change.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

BODY = "Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
NOTICE = "Table editor closed"


def new_note(page) -> None:
    page.locator("#btn-new, #btn-empty-new, #btn-new-list, #fab-add").locator("visible=true").first.click()


def panel_open(page) -> bool:
    return page.evaluate("() => !document.getElementById('table-editor').hidden")


def toast_text(page) -> str:
    return page.evaluate("() => document.getElementById('toast').textContent")


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-table-editor-outside-"))
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
            page.fill("#note-title", "Tabel")
            page.select_option("#note-editor-type", "markdown")
            page.fill("#note-body", BODY)
            page.evaluate("() => NotesStore.flush && NotesStore.flush()")

            # Caret inside the table ("1"), then the Table button opens the editor for it.
            caret = BODY.index("| 1 |") + 2
            page.click("#note-body")
            page.evaluate(f"() => {{ const t = document.getElementById('note-body'); t.setSelectionRange({caret}, {caret}); }}")
            page.click('button[data-md="table"]:visible')
            page.wait_for_function("() => !document.getElementById('table-editor').hidden", timeout=5000)

            # The editor's own cell edit keeps the panel open and shows no notice.
            page.focus('[data-row="1"][data-col="0"]')
            page.keyboard.press("End")
            page.keyboard.type("9")
            page.wait_for_function(
                "() => document.getElementById('note-body').value.includes('| 19 |')", timeout=5000
            )
            assert panel_open(page), "a cell edit closed the table editor"
            assert NOTICE not in toast_text(page), f"a cell edit showed the notice: {toast_text(page)!r}"

            # Typing in the Markdown source closes the panel and says so.
            page.click("#note-body")
            page.keyboard.press("Control+End")
            page.keyboard.type("x")
            page.wait_for_function("() => document.getElementById('table-editor').hidden", timeout=5000)
            page.wait_for_function(
                "(t) => !document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes(t)",
                arg=NOTICE,
                timeout=5000,
            )

            # Further typing does not repeat the notice: the panel was already closed.
            page.evaluate("() => { document.getElementById('toast').textContent = 'seen'; }")
            page.keyboard.type("y")
            page.wait_for_timeout(200)
            assert toast_text(page) == "seen", f"notice repeated: {toast_text(page)!r}"

            # Chromium logs this on every page load because the CSP is delivered via <meta>.
            errors = [e for e in errors if "'frame-ancestors' is ignored" not in e]
            assert not errors, errors
            browser.close()
        print("e2e_table_editor_outside_change ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
