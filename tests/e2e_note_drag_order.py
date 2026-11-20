"""E2E (Playwright): drag notes into an own order inside a label, plus keyboard moves.

Four notes carry one label. In "Recent" the rows have no grip and a mouse drag changes
nothing. In "Own order" a mouse drag of a row and a touch drag of the grip move a note,
Alt+Down and the row's "Move up" / "Move down" menu items move it with the keyboard, and
after a reload and a new unlock the order is the same. Any pageerror / console.error
fails the test.

    python tests/e2e_note_drag_order.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_own_order import SEED_JS as _SEED3, SYNCED_JS, TITLES_JS, unlock  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

SEED_JS = _SEED3.replace("['Alpha', 'Beta', 'Gamma']", "['Alpha', 'Beta', 'Gamma', 'Delta']")
ORDER_IS_JS = (
    "(t) => JSON.stringify([...document.querySelectorAll('#note-list .note-row h3')]"
    ".map((e) => e.textContent.trim())) === JSON.stringify(t)"
)


def wait_order(page, expected: list[str]) -> None:
    try:
        page.wait_for_function(ORDER_IS_JS, arg=expected, timeout=15000)
    except Exception as exc:
        raise AssertionError(f"order {page.evaluate(TITLES_JS)} != {expected}") from exc


def row(page, title: str):
    return page.locator("#note-list .note-row", has=page.locator("h3", has_text=title))


def open_label(page) -> None:
    page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
    page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
    page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 4")


def touch_drag(cdp, start: tuple[float, float], end: tuple[float, float]) -> None:
    x0, y0 = start
    x1, y1 = end
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for i in range(1, 9):
        f = i / 8
        point = {"x": x0 + (x1 - x0) * f, "y": y0 + (y1 - y0) * f}
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-dragorder-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 1400, "height": 1500}, has_touch=True)
            context.set_default_timeout(30000)
            page = context.new_page()
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
            open_label(page)

            # Recent: no grip, and dragging a row onto another changes nothing.
            recent = page.evaluate(TITLES_JS)
            assert page.locator(".note-row-grip").count() == 0
            row(page, recent[0]).drag_to(row(page, recent[-1]), target_position={"x": 40, "y": 30})
            page.wait_for_timeout(300)
            assert page.evaluate(TITLES_JS) == recent, page.evaluate(TITLES_JS)
            assert page.evaluate("(id) => NotesStore.get(id).content.note_keys", label) is None

            page.select_option("#sort-select", "manual")
            page.wait_for_function("() => document.querySelectorAll('.note-row-grip').length === 4")
            order = page.evaluate(TITLES_JS)

            # Mouse: drag the last row onto the upper half of the first row.
            last = row(page, order[-1])
            last.drag_to(row(page, order[0]), target_position={"x": 40, "y": 4})
            order = [order[-1], *order[:-1]]
            wait_order(page, order)

            # Mouse: drag the first row onto the lower half of the third row.
            third_box = row(page, order[2]).bounding_box()
            row(page, order[0]).drag_to(row(page, order[2]), target_position={"x": 40, "y": third_box["height"] - 4})
            order = [order[1], order[2], order[0], order[3]]
            wait_order(page, order)

            # Dropping a row on itself keeps the order.
            row(page, order[1]).drag_to(row(page, order[1]), target_position={"x": 40, "y": 4})
            page.wait_for_timeout(300)
            assert page.evaluate(TITLES_JS) == order

            # Touch: drag the grip of the fourth row onto the upper half of the second row.
            cdp = context.new_cdp_session(page)
            grip = row(page, order[3]).locator(".note-row-grip").bounding_box()
            target = row(page, order[1]).bounding_box()
            touch_drag(
                cdp,
                (grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2),
                (target["x"] + 60, target["y"] + 5),
            )
            order = [order[0], order[3], order[1], order[2]]
            wait_order(page, order)
            # A tap on the grip does not open the note.
            grip = row(page, order[0]).locator(".note-row-grip").bounding_box()
            spot = (grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2)
            touch_drag(cdp, spot, spot)
            page.wait_for_timeout(300)
            assert page.locator("#note-list .note-row.active").count() == 0
            assert page.evaluate(TITLES_JS) == order

            # Keyboard: Alt+Down on the first row moves it one place down, focus stays on it.
            moved = order[0]
            row(page, moved).locator(".note-item").focus()
            page.keyboard.press("Alt+ArrowDown")
            order = [order[1], order[0], order[2], order[3]]
            wait_order(page, order)
            assert page.evaluate("() => document.activeElement.closest('.note-row').querySelector('h3').textContent.trim()") == moved

            # Keyboard via the row's "⋯" menu.
            more = row(page, order[3]).locator(".note-row-more")
            more.focus()
            page.keyboard.press("Enter")
            page.wait_for_selector("#note-row-menu:not([hidden])")
            assert page.locator("#note-row-menu-up").is_visible()
            menu_box = page.locator("#note-row-menu").bounding_box()
            assert menu_box["y"] + menu_box["height"] <= 1500, menu_box
            page.locator("#note-row-menu-up").focus()
            page.keyboard.press("Enter")
            order = [order[0], order[1], order[3], order[2]]
            wait_order(page, order)
            assert page.locator("#note-row-menu").is_hidden()
            row(page, order[0]).locator(".note-row-more").focus()
            page.keyboard.press("Enter")
            page.wait_for_selector("#note-row-menu:not([hidden])")
            page.locator("#note-row-menu-down").focus()
            page.keyboard.press("Enter")
            order = [order[1], order[0], order[2], order[3]]
            wait_order(page, order)

            # Outside own order the menu has no move items.
            page.select_option("#sort-select", "updated")
            page.wait_for_function("() => document.querySelectorAll('.note-row-grip').length === 0")
            row(page, order[0]).locator(".note-row-more").focus()
            page.keyboard.press("Enter")
            page.wait_for_selector("#note-row-menu:not([hidden])")
            assert page.locator("#note-row-menu-up").is_hidden()
            assert page.locator("#note-row-menu-down").is_hidden()
            page.keyboard.press("Escape")
            page.select_option("#sort-select", "manual")
            wait_order(page, order)

            # Kept after reload and a new unlock.
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.wait_for_function("() => NotesStore.listNotes().length >= 4")
            open_label(page)
            wait_order(page, order)

            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_drag_order ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
