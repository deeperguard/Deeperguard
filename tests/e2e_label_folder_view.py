"""E2E (Playwright): folder view of a label (breadcrumb, include-sublabels toggle, New note).

Selecting a label shows a breadcrumb whose parents are clickable, a checkbox
"Include sublabels" (remembered per device in localStorage) that adds or removes
the notes of sublabels, and a "New note" button that gives the new note the
current label. Any pageerror / console.error fails the test.

    python tests/e2e_label_folder_view.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_own_order import SYNCED_JS, unlock  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

TITLES_JS = "() => [...document.querySelectorAll('.note-row')].map((r) => r.textContent).join('|')"


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-labelfolder-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_context(viewport={"width": 1400, "height": 1000}).new_page()
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
            page.evaluate(
                """() => {
                  const work = NotesStore.createTag('Work');
                  const proj = NotesStore.createTag('Projects', work);
                  const mk = (title, tag) => NotesStore.upsert(crypto.randomUUID(),
                    { ...NotesStore.defaultNote(), title, title_manual: true, content: title, tags: tag ? [tag] : [] });
                  mk('NoteInWork', work); mk('NoteInProjects', proj); mk('NoteLoose', '');
                }"""
            )
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            assert page.locator("#label-folder-bar").is_hidden()

            def pick(name: str) -> None:
                page.locator(f'#tag-list [role=treeitem][aria-label^="{name},"]').click(position={"x": 52, "y": 8})

            def rows(n: int) -> None:
                page.wait_for_function(f"() => document.querySelectorAll('.note-row').length === {n}")

            # Sublabels are shown by default; the breadcrumb of a top-level label is All notes / Work.
            pick("Work")
            page.wait_for_selector("#label-folder-bar:not([hidden])")
            assert page.locator("#label-crumbs [aria-current=page]").inner_text() == "Work"
            rows(2)
            assert page.locator("#label-include-subs").is_checked()

            # Unchecking hides the sublabel's note; the choice is stored on the device.
            page.locator("#label-include-subs").uncheck()
            rows(1)
            assert "NoteInWork" in page.evaluate(TITLES_JS)
            assert page.evaluate("() => localStorage.getItem('notes_label_include_subs')") == "0"
            page.locator("#label-include-subs").check()
            rows(2)

            # In a sublabel the breadcrumb lists the parents as buttons that navigate up.
            page.locator('#tag-list [data-label-toggle]').first.click()
            pick("Projects")
            rows(1)
            crumbs = page.locator("#label-crumbs button").all_inner_texts()
            assert crumbs == ["All notes", "Work"], crumbs
            assert page.locator("#label-subs-wrap").is_hidden()  # no sublabels below Projects
            page.locator('#label-crumbs button:has-text("Work")').click()
            rows(2)
            assert page.locator("#label-crumbs [aria-current=page]").inner_text() == "Work"

            # New note from the folder view carries the current label.
            pick("Projects")
            rows(1)
            before = page.evaluate("() => NotesStore.listNotes().length")
            page.locator("#label-folder-new").click()
            page.wait_for_function(f"() => NotesStore.listNotes().length === {before + 1}")
            tags = page.evaluate(
                """() => {
                  const proj = NotesStore.listTags().find((t) => t.content.name === 'Projects').uuid;
                  const fresh = NotesStore.listNotes().find((n) => !n.content.title);
                  return { proj, tags: fresh.content.tags };
                }"""
            )
            assert tags["tags"] == [tags["proj"]], tags

            # "All notes" in the breadcrumb leaves the label view.
            page.locator('#label-crumbs button:has-text("All notes")').click()
            page.wait_for_selector("#label-folder-bar", state="hidden")
            browser.close()
    finally:
        proc.terminate()
    if errors:
        print("\n".join(errors))
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
