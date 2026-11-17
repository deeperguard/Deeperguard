"""E2E (Playwright): move notes between folders.

A note is moved with the "Move to folder…" picker (opened from the note's "⋯"
menu, picked with the keyboard), the editor's "Move to folder…" button opens the
same picker and keeps Tab inside it, and another note is dragged onto a folder in
the sidebar. After a reload and a new unlock, both notes are still in their new
folders. Moving an open note to "No folder" updates the editor's Folder field and
survives a reload. Any pageerror / console.error fails the test.

    python tests/e2e_move_note_folder.py
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

# {note title: folder title or ''} for every note.
PLACEMENT_JS = """() => {
  const folders = new Map(NotesStore.listFolders().map((f) => [f.uuid, f.content.title]));
  const out = {};
  for (const n of NotesStore.listNotes()) {
    if (n.content.type !== 'note') continue;
    out[n.content.title] = folders.get(n.content.folder_id) || '';
  }
  return out;
}"""

SEED_JS = """() => {
  const work = NotesStore.createFolder('Work');
  NotesStore.createFolder('Projects', work);
  for (const title of ['Alpha', 'Beta']) {
    NotesStore.upsert(crypto.randomUUID(), { type: 'note', title, body: title, folder_id: '' });
  }
}"""

# ["folder" if a folder is selected else "", shown text] of the editor's Folder select.
FOLDER_FIELD_JS = """() => {
  const s = document.getElementById('note-folder-select');
  return [s.value ? 'folder' : '', s.options[s.selectedIndex].textContent];
}"""

LEVELS_JS ="""() => [...document.querySelectorAll('#folder-move-tree [role=treeitem]')]
  .map((e) => [e.textContent.trim(), e.getAttribute('aria-level')])"""


def unlock(page) -> None:
    page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(UNLOCKED_JS, timeout=120000)


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-movenote-"))
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
            page.evaluate("() => { document.getElementById('folder-section').open = true; }")

            page.evaluate(SEED_JS)
            page.wait_for_timeout(1000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#folder-section").evaluate("(el) => { el.open = true; }")
            work = page.locator("#folder-list [role=treeitem][aria-label^='Work,']")
            work.wait_for(state="visible")
            work.focus()
            page.keyboard.press("ArrowRight")
            page.locator("#folder-list [role=treeitem][aria-label^='Projects,']").wait_for(state="visible")
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "", "Beta": ""}

            # 1) Picker from the "⋯" menu, keyboard only: No folder, Work, Projects (level 2).
            page.locator(".note-row", has_text="Alpha").locator(".note-row-more").focus()
            page.keyboard.press("Enter")
            page.locator("#note-row-menu-move").click()
            page.locator("#folder-move").wait_for(state="visible")
            levels = page.evaluate(LEVELS_JS)
            assert levels == [["No folder (current)", "1"], ["Work", "1"], ["Projects", "2"]], levels
            assert page.evaluate("() => document.activeElement.textContent") == "No folder (current)"
            page.keyboard.press("ArrowDown")
            page.keyboard.press("ArrowDown")
            page.keyboard.press("Enter")
            page.locator("#folder-move").wait_for(state="hidden")
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "Projects", "Beta": ""}

            # Escape cancels without moving.
            page.locator(".note-row", has_text="Beta").locator(".note-row-more").focus()
            page.keyboard.press("Enter")
            page.locator("#note-row-menu-move").click()
            page.keyboard.press("Escape")
            page.locator("#folder-move").wait_for(state="hidden")
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "Projects", "Beta": ""}

            # 1b) The editor's "Move to folder…" button opens the same picker. Tab and
            # Shift+Tab stay inside it; Escape closes it and returns focus to the button.
            page.locator(".note-row", has_text="Beta").click()
            page.locator("#btn-move-note").click()
            page.locator("#folder-move").wait_for(state="visible")
            for key in ["Tab"] * 4 + ["Shift+Tab"] * 6:
                page.keyboard.press(key)
                inside = page.evaluate("() => !!document.activeElement.closest('#folder-move')")
                assert inside, f"{key} left the picker"
            page.keyboard.press("Escape")
            page.locator("#folder-move").wait_for(state="hidden")
            assert page.evaluate("() => document.activeElement.id") == "btn-move-note"
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "Projects", "Beta": ""}

            # 2) Drag Beta onto the Work folder in the sidebar.
            page.locator(".note-row", has_text="Beta").drag_to(
                page.locator("#folder-list [role=treeitem][aria-label^='Work,']"),
                source_position={"x": 40, "y": 10},
                target_position={"x": 52, "y": 8},
            )
            page.wait_for_function(
                "() => NotesStore.listNotes().some((n) => n.content.title === 'Beta' && n.content.folder_id)"
            )
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "Projects", "Beta": "Work"}
            # "All notes" is a filter, not a drop target: dragging there changes nothing.
            page.locator(".note-row", has_text="Beta").drag_to(
                page.locator("#folder-list [role=treeitem][aria-label='All notes']"),
                source_position={"x": 40, "y": 10},
            )
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "Projects", "Beta": "Work"}

            # 3) Reload and unlock again: the notes are in their new folders.
            page.wait_for_timeout(500)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 2")
            placement = page.evaluate(PLACEMENT_JS)
            assert placement == {"Alpha": "Projects", "Beta": "Work"}, placement

            # 4) Open Alpha (in Projects): the editor's Folder field shows it. Moving it
            # to "No folder" from the "⋯" menu while it is open must update that field.
            page.locator(".note-row", has_text="Alpha").click()
            assert page.evaluate(FOLDER_FIELD_JS) == ["folder", "Projects"], page.evaluate(FOLDER_FIELD_JS)
            page.locator(".note-row", has_text="Alpha").locator(".note-row-more").focus()
            page.keyboard.press("Enter")
            page.locator("#note-row-menu-move").click()
            page.locator("#folder-move").wait_for(state="visible")
            page.locator("#folder-move-tree [data-move-target='']").click()
            page.locator("#folder-move").wait_for(state="hidden")
            assert page.evaluate(FOLDER_FIELD_JS) == ["", "No folder"], page.evaluate(FOLDER_FIELD_JS)
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "", "Beta": "Work"}

            # Same through the editor's own button, Beta (in Work) now open.
            page.locator(".note-row", has_text="Beta").click()
            assert page.evaluate(FOLDER_FIELD_JS) == ["folder", "Work"]
            page.locator("#btn-move-note").click()
            page.locator("#folder-move-tree [data-move-target='']").click()
            page.locator("#folder-move").wait_for(state="hidden")
            assert page.evaluate(FOLDER_FIELD_JS) == ["", "No folder"], page.evaluate(FOLDER_FIELD_JS)

            # After a reload and unlock, neither note is in its old folder any more.
            page.wait_for_timeout(500)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 2")
            assert page.evaluate(PLACEMENT_JS) == {"Alpha": "", "Beta": ""}
            page.locator(".note-row", has_text="Alpha").click()
            assert page.evaluate(FOLDER_FIELD_JS) == ["", "No folder"], page.evaluate(FOLDER_FIELD_JS)
            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_move_note_folder ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
