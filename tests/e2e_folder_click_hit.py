"""E2E (Playwright): every folder button in the Notes sidebar is the top element
at its own click point and a plain click() selects it.

Folder 'Werk' gets the subfolder 'Projecten' (through 'New subfolder in Werk') and
is renamed to 'Werk & Co 🚀'. For each folder name button the test measures with
document.elementFromPoint which element lies on its centre, at rest and while the
pointer hovers the row (the hover action strip must not cover it). Then it does a
real click() without force and checks that the folder is selected and the note
list is filtered. Enter, the arrow keys and the 'New subfolder in' button must
keep working. The hard-coded --folder-strip-w must equal the rendered width of the
action strip, for a fine pointer (hover) and for a coarse (touch) pointer.

    python tests/e2e_folder_click_hit.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

RENAMED = "Werk & Co 🚀"
# Whether the element on the centre of the given control is the control itself or a child.
TOP_JS = """([selector, key]) => {
  const btn = document.querySelector(`#folder-list [${selector}="${CSS.escape(key)}"]`);
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { covered: !top || !btn.contains(top),
           top: top ? `${top.tagName.toLowerCase()}.${top.className}` : null };
}"""
STRIP_JS = """(name) => {
  const head = [...document.querySelectorAll('#folder-list [role=treeitem]')]
    .find((h) => h.getAttribute('aria-label').startsWith(name + ','));
  return { strip: head.querySelector('.folder-head-actions').getBoundingClientRect().width,
           declared: parseFloat(getComputedStyle(head).getPropertyValue('--folder-strip-w')) };
}"""
SELECTED_JS = """([id]) => document.querySelector(`#folder-list [data-folder-item="${id}"]`).getAttribute('aria-selected') === 'true'"""
ROWS_JS = "(n) => document.querySelectorAll('.note-row').length === n"
ONLY_NOTE_JS = """(title) => { const rows = document.querySelectorAll('.note-row'); return rows.length === 1 && rows[0].innerText.includes(title); }"""
SEED_JS ="""() => {
  const folders = NotesStore.listFolders();
  const id = (t) => folders.find((f) => f.content.title === t).uuid;
  [['In werk', id('Werk & Co 🚀')], ['In projecten', id('Projecten')], ['Los', '']].forEach(([title, fid]) => {
    NotesStore.upsert(crypto.randomUUID(), { ...NotesStore.defaultNote(), title, title_manual: true, content: title, folder_id: fid });
  });
}"""


def touch_strip_measure(browser, base: str) -> dict:
    """Creates 'Werk' in a touch context (coarse pointer) and measures its action strip there."""
    context = browser.new_context(viewport={"width": 1400, "height": 900}, has_touch=True)
    page = context.new_page()
    register(page, base)
    cdp = context.new_cdp_session(page)
    cdp.send("Emulation.setEmulatedMedia", {"features": [
        {"name": "pointer", "value": "coarse"}, {"name": "any-pointer", "value": "coarse"},
        {"name": "hover", "value": "none"}, {"name": "any-hover", "value": "none"},
    ]})
    page.wait_for_function("() => matchMedia('(pointer: coarse)').matches")
    page.locator("#btn-nav-pin").click()
    page.wait_for_function("() => document.body.classList.contains('nav-pinned')")
    page.evaluate("() => { document.getElementById('folder-section').open = true; }")
    page.locator("#btn-new-folder").click()
    page.fill("#folder-name-input", "Werk")
    page.keyboard.press("Enter")
    page.locator('#folder-list [role=treeitem][aria-label^="Werk,"]').wait_for(state="attached", timeout=10000)
    got = page.evaluate(STRIP_JS, "Werk")
    context.close()
    return got


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-folderhit-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()

            def assert_strip_width(name: str, label: str) -> None:
                got = page.evaluate(STRIP_JS, name)
                assert abs(got["strip"] - got["declared"]) < 0.5, f"{label}: {got}"

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

            def item(name: str):
                return page.locator(f'#folder-list [role=treeitem][aria-label^="{name},"]')

            page.locator("#btn-new-folder").click()
            page.fill("#folder-name-input", "Werk")
            page.keyboard.press("Enter")
            item("Werk").wait_for(state="visible", timeout=10000)
            assert_strip_width("Werk", "fine pointer")
            touch = touch_strip_measure(browser, base)
            assert abs(touch["strip"] - touch["declared"]) < 0.5, f"coarse pointer: {touch}"

            item("Werk").hover()
            page.get_by_role("button", name="New subfolder in Werk").click()
            page.fill("#folder-name-input", "Projecten")
            page.keyboard.press("Enter")
            item("Projecten").wait_for(state="visible", timeout=10000)

            item("Werk").hover()
            page.get_by_role("button", name="Rename folder Werk").click()
            page.locator(".folder-rename-input").fill(RENAMED)
            page.keyboard.press("Enter")
            item(RENAMED).wait_for(state="visible", timeout=10000)
            page.wait_for_function("() => !document.querySelector('.folder-rename-input')")

            page.evaluate(SEED_JS)
            page.locator('#folder-list [aria-label="All notes"]').click()
            page.wait_for_function(ROWS_JS, arg=3, timeout=10000)

            for name, note in ((RENAMED, "In werk"), ("Projecten", "In projecten")):
                fid = item(name).get_attribute("data-folder-item")
                idle = page.evaluate(TOP_JS, ["data-folder-select", fid])
                assert not idle["covered"], f"{name} covered at rest by {idle['top']}"
                button = page.locator(f'#folder-list [data-folder-select="{fid}"]')
                button.hover()
                hovered = page.evaluate(TOP_JS, ["data-folder-select", fid])
                assert not hovered["covered"], f"{name} covered while hovered by {hovered['top']}"
                button.click()  # no force: Playwright itself fails when something covers it
                page.wait_for_function(SELECTED_JS, arg=[fid])
                page.wait_for_function(ONLY_NOTE_JS, arg=note)

            # The 'New subfolder in' button is the top element at its own centre and still works.
            item(RENAMED).hover()
            fid = item(RENAMED).get_attribute("data-folder-item")
            add = page.get_by_role("button", name=f"New subfolder in {RENAMED}")
            top = page.evaluate(TOP_JS, ["data-folder-add", fid])
            assert not top["covered"], f"New subfolder button covered by {top['top']}"
            add.click()
            page.fill("#folder-name-input", "Extra")
            page.keyboard.press("Enter")
            item("Extra").wait_for(state="visible", timeout=10000)

            # Keyboard: arrows and Enter still select.
            page.locator('#folder-list [aria-label="All notes"]').focus()
            page.keyboard.press("Enter")
            page.wait_for_function(ROWS_JS, arg=3)
            page.keyboard.press("ArrowDown")
            page.keyboard.press("Enter")
            page.wait_for_function(ONLY_NOTE_JS, arg="In werk")
            assert item(RENAMED).get_attribute("aria-selected") == "true"
            browser.close()
    finally:
        proc.terminate()
    assert not errors, errors
    print("e2e_folder_click_hit: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
