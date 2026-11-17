"""E2E (Playwright): typing `[[Bo` opens the note link picker and inserts a link;
in the preview, clicking that link opens the target note, and once the target is
deleted the link is shown dead and clicking it opens the repair panel.

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
            target = page.wait_for_function(
                "() => NotesStore.listNotes().find((n) => n.content.title === 'Boodschappen')?.uuid",
                timeout=10000,
            ).json_value()
            source = page.wait_for_function(
                "() => NotesStore.listNotes().find((n) => n.content.title === 'Tweede')?.uuid",
                timeout=10000,
            ).json_value()
            page.evaluate("() => NotesStore.flush && NotesStore.flush()")

            def open_source():
                page.locator(f'.note-row[data-id="{source}"]').click()
                page.wait_for_function(
                    "() => document.getElementById('note-title').value === 'Tweede'", timeout=10000
                )

            def opened_target():
                page.wait_for_function(
                    "() => document.getElementById('note-title').value === 'Boodschappen'", timeout=10000
                )

            # Plain editor: the link in the text is clickable and opens note A.
            link = page.locator(f'#note-body-links a.note-link[data-dg-note="{target}"]')
            link.wait_for(state="visible", timeout=10000)
            assert link.get_attribute("data-dead") is None
            link.click()
            opened_target()

            # Keyboard: caret inside the link, Ctrl+Enter follows it.
            open_source()
            page.evaluate("() => { const b = document.getElementById('note-body'); b.focus(); b.setSelectionRange(10, 10); }")
            page.keyboard.press("Control+Enter")
            opened_target()

            # Markdown preview: rendered with the live title, click opens A.
            open_source()
            def show_preview():
                if page.locator("#preview").is_visible():
                    return
                if not page.locator("#btn-preview").is_visible():
                    page.locator("#btn-editor-overflow-desktop").click()
                page.locator("#btn-preview").click()
                page.locator("#preview").wait_for(state="visible", timeout=10000)

            page.select_option("#note-editor-type", "markdown")
            show_preview()
            preview_link = page.locator(f'#preview a.note-link[data-dg-note="{target}"]')
            preview_link.wait_for(state="visible", timeout=10000)
            assert preview_link.inner_text() == "Boodschappen", preview_link.inner_text()
            preview_link.click()
            opened_target()

            # Delete A for good: in the preview the link is dead, and clicking
            # it opens the repair panel instead of throwing or navigating.
            page.evaluate(f"() => NotesStore.remove('{target}', {{ force: true }})")
            open_source()
            show_preview()
            dead = page.locator(f'#preview a.note-link-dead[data-dg-note="{target}"]')
            dead.wait_for(state="visible", timeout=10000)
            assert dead.get_attribute("data-dead") == "missing"
            dead.click()
            panel = page.locator("#note-link-dead-panel")
            panel.wait_for(state="visible", timeout=10000)
            assert "deleted" in panel.inner_text()
            assert page.locator("#note-title").input_value() == "Tweede"
            panel.get_by_role("button", name="Close").click()

            # Same in the plain editor.
            page.select_option("#note-editor-type", "plain")
            dead_edit = page.locator(f'#note-body-links a.note-link-dead[data-dg-note="{target}"]')
            if not dead_edit.is_visible():
                page.click("#note-body")
            dead_edit.wait_for(state="visible", timeout=10000)
            dead_edit.click()
            panel.wait_for(state="visible", timeout=10000)
            assert "deleted" in panel.inner_text()
            assert page.locator("#note-title").input_value() == "Tweede"
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
