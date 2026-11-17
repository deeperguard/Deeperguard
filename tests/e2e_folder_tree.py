"""E2E (Playwright): the Notes sidebar folder tree.

A folder and a subfolder are created, renamed and deleted from the sidebar
(context menu and keyboard); a click filters the note list on that folder,
"All notes" shows every note again, and the tree follows the WAI-ARIA tree
pattern (role=tree/treeitem, aria-expanded, arrow keys, Home, End, Enter).
Deleting a folder asks for confirmation that says what happens to its notes
and subfolders. Any pageerror / console.error fails the test.

    python tests/e2e_folder_tree.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

ITEMS_JS = """() => [...document.querySelectorAll('#folder-list [role=treeitem]')].map((e) => ({
  name: e.getAttribute('aria-label'), level: e.getAttribute('aria-level'),
  expanded: e.getAttribute('aria-expanded'), selected: e.getAttribute('aria-selected'),
  tab: e.getAttribute('tabindex'),
}))"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-foldertree-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_context(viewport={"width": 1400, "height": 1500}).new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            # The app's <meta> CSP always logs one frame-ancestors notice; it is not a script error.
            page.on(
                "console",
                lambda m: errors.append(f"console.error: {m.text}")
                if m.type == "error" and "frame-ancestors" not in m.text
                else None,
            )
            register(page, base)
            page.locator("#btn-nav-pin").click()
            page.wait_for_function("() => document.body.classList.contains('nav-pinned')")
            page.evaluate("() => { document.getElementById('folder-section').open = true; }")

            def item(name: str):
                if name == "All notes":
                    return page.locator('#folder-list [role=treeitem][aria-label="All notes"]')
                return page.locator(f'#folder-list [role=treeitem][aria-label^="{name},"]')

            def pick(name: str) -> None:
                # Click the name end of the row: on hover the action buttons overlay the right side.
                item(name).click(position={"x": 52, "y": 8})

            def names() -> list[str]:
                return [i["name"] for i in page.evaluate(ITEMS_JS)]

            def focused_name() -> str:
                return page.evaluate("() => document.activeElement.getAttribute('aria-label')")

            # --- create a folder, then a subfolder through the context menu ---
            page.locator("#btn-new-folder").click()
            page.fill("#folder-name-input", "Work")
            page.keyboard.press("Enter")
            item("Work").wait_for(state="visible", timeout=10000)
            assert page.locator("#folder-list [role=tree]").get_attribute("aria-label") == "Folders"

            item("Work").click(button="right")
            page.get_by_role("menuitem", name="New subfolder").click()
            page.fill("#folder-name-input", "Projects")
            page.keyboard.press("Enter")
            item("Projects").wait_for(state="visible", timeout=10000)
            info = {i["name"].split(",")[0]: i for i in page.evaluate(ITEMS_JS)}
            assert info["Work"]["level"] == "1" and info["Work"]["expanded"] == "true", info
            assert info["Projects"]["level"] == "2" and info["Projects"]["expanded"] is None, info
            assert page.locator("#folder-list [role=group] [role=treeitem]").count() == 1

            # A duplicate name next to an existing folder is refused.
            item("Work").click(button="right")
            page.get_by_role("menuitem", name="New subfolder").click()
            page.fill("#folder-name-input", "projects")
            page.keyboard.press("Enter")
            page.wait_for_function("() => document.getElementById('toast')?.textContent.includes('already exists')")
            page.keyboard.press("Escape")
            assert names() == ["All notes", "Work, 0", "Projects, 0"], names()

            # --- three notes: one in Work, one in Projects, one loose ---
            page.evaluate(
                """() => {
                  const folders = NotesStore.listFolders();
                  const id = (t) => folders.find((f) => f.content.title === t).uuid;
                  [['In work', id('Work')], ['In projects', id('Projects')], ['Loose', '']].forEach(([title, fid]) => {
                    NotesStore.upsert(crypto.randomUUID(), { ...NotesStore.defaultNote(), title, title_manual: true, content: title, folder_id: fid });
                  });
                }"""
            )
            pick("All notes")
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 3", timeout=10000)

            # --- clicking a folder filters; All notes shows everything ---
            pick("Work")
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 1")
            assert "In work" in page.locator(".note-row").first.inner_text()
            assert item("Work").get_attribute("aria-selected") == "true"
            pick("Projects")
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 1")
            assert "In projects" in page.locator(".note-row").first.inner_text()
            pick("All notes")
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 3")
            assert item("All notes").get_attribute("aria-selected") == "true"

            # --- keyboard: arrows, Home, End, Enter ---
            item("All notes").focus()
            page.keyboard.press("ArrowDown")
            assert focused_name() == "Work, 1", focused_name()
            page.keyboard.press("ArrowRight")  # open: moves to first child
            assert focused_name() == "Projects, 1", focused_name()
            page.keyboard.press("ArrowLeft")  # to the parent
            assert focused_name() == "Work, 1", focused_name()
            page.keyboard.press("ArrowLeft")  # collapse
            assert item("Work").get_attribute("aria-expanded") == "false"
            assert names() == ["All notes", "Work, 1"], names()
            page.keyboard.press("ArrowRight")  # expand again
            assert item("Work").get_attribute("aria-expanded") == "true"
            page.keyboard.press("End")
            assert focused_name() == "Projects, 1", focused_name()
            page.keyboard.press("Home")
            assert focused_name() == "All notes", focused_name()
            page.keyboard.press("ArrowDown")
            page.keyboard.press("Enter")
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 1")
            assert item("Work").get_attribute("aria-selected") == "true"
            tabbable = page.evaluate("() => document.querySelectorAll('#folder-list [role=treeitem][tabindex=\"0\"]').length")
            assert tabbable == 1, tabbable
            page.keyboard.press("Tab")
            assert not page.evaluate("() => !!document.activeElement.closest('#folder-list')"), "tree is one tab stop"

            # --- the context menu closed from the keyboard drops its outside-click listener ---
            item("Work").focus()
            page.evaluate(
                """() => {
                  window.pointerdownListeners = { added: 0, removed: 0 };
                  const add = document.addEventListener.bind(document);
                  const remove = document.removeEventListener.bind(document);
                  document.addEventListener = (type, fn, capture) => {
                    if (type === 'pointerdown') window.pointerdownListeners.added += 1;
                    return add(type, fn, capture);
                  };
                  document.removeEventListener = (type, fn, capture) => {
                    if (type === 'pointerdown') window.pointerdownListeners.removed += 1;
                    return remove(type, fn, capture);
                  };
                }"""
            )
            page.keyboard.press("Shift+F10")
            page.get_by_role("menuitem", name="Rename").wait_for(state="visible", timeout=10000)
            page.wait_for_function("() => window.pointerdownListeners.added === 1")  # registered after the open
            page.keyboard.press("Tab")
            assert page.locator("#folder-menu").count() == 0
            assert page.evaluate("() => window.pointerdownListeners") == {"added": 1, "removed": 1}, page.evaluate("() => window.pointerdownListeners")

            # --- rename with F2 ---
            item("Work").focus()
            page.keyboard.press("F2")
            page.locator(".folder-rename-input").fill("Klanten")
            page.keyboard.press("Enter")
            item("Klanten").wait_for(state="visible", timeout=10000)
            assert any(n.startswith("Projects") for n in names()), names()
            assert page.evaluate("() => NotesStore.listFolders().some((f) => f.content.title === 'Klanten')")

            # --- delete: the dialog states what happens; cancel keeps everything ---
            item("Klanten").focus()
            page.keyboard.press("Delete")
            page.locator("#confirm-dialog").wait_for(state="visible", timeout=10000)
            message = page.locator("#confirm-message").inner_text()
            assert "1 note" in message and "1 subfolder" in message and "top level" in message, message
            assert "No notes are deleted" in message, message
            page.locator("#confirm-cancel").click()
            assert item("Klanten").count() == 1

            item("Klanten").focus()
            page.keyboard.press("Delete")
            page.locator("#confirm-ok").click()
            page.wait_for_function("() => !document.querySelector('#folder-list [aria-label^=\"Klanten,\"]')")
            info = {i["name"].split(",")[0]: i for i in page.evaluate(ITEMS_JS)}
            assert info["Projects"]["level"] == "1", info  # subfolder moved up
            assert page.evaluate("() => NotesStore.listNotes().filter((n) => n.content.folder_id).length") == 1
            page.wait_for_function("() => document.querySelectorAll('.note-row').length === 3")  # back on All notes

            # --- delete the last folder from its context menu ---
            item("Projects").click(button="right")
            page.get_by_role("menuitem", name="Delete…").click()
            message = page.locator("#confirm-message").inner_text()
            assert "1 note" in message and "subfolder" not in message, message
            page.locator("#confirm-ok").click()
            page.wait_for_function("() => document.querySelectorAll('#folder-list [role=treeitem]').length === 0")
            assert page.locator(".note-row").count() == 3
            assert page.evaluate("() => NotesStore.listNotes().every((n) => !n.content.folder_id)")

            browser.close()
    finally:
        proc.terminate()
    assert not errors, errors
    print("e2e_folder_tree: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
