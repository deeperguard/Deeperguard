"""E2E (Playwright): drag and drop in the sidebar label tree.

Mouse: drop between two labels reorders, drop on a label nests, a drop of a label onto
its own sub-label is refused (nothing changes). Touch: dragging the grip nests a label.
After a reload and a new unlock the order and parents are still there.

    python tests/e2e_label_drag_drop.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_own_order import SYNCED_JS, unlock  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

LAYOUT_JS = """() => {
  const out = [];
  const walk = (ul, depth) => ul.querySelectorAll(':scope > li > [data-label]').forEach((item) => {
    out.push('-'.repeat(depth) + item.querySelector('.label-name').textContent);
    const sub = item.parentElement.querySelector(':scope > ul:not([hidden])');
    if (sub) walk(sub, depth + 1);
  });
  walk(document.querySelector('#tag-list .label-tree'), 0);
  return out.join(',');
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-labeldrag-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 1400, "height": 1000}, has_touch=True)
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
            page.evaluate(
                """() => {
                  const a = NotesStore.createTag('Alpha');
                  NotesStore.createTag('Beta');
                  NotesStore.createTag('Gamma');
                  NotesStore.createTag('Alpha child', a);
                }"""
            )
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.locator('#tag-list [data-label-toggle]').first.click()
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,Gamma"

            def row(name: str):
                return page.locator(f'#tag-list [role=treeitem][aria-label^="{name},"]')

            def mouse_drag(src: str, dst: str, frac: float) -> None:
                s = row(src).bounding_box()
                d = row(dst).bounding_box()
                page.mouse.move(s["x"] + 60, s["y"] + s["height"] / 2)
                page.mouse.down()
                page.mouse.move(s["x"] + 60, s["y"] + s["height"] / 2 + 12, steps=3)
                page.mouse.move(d["x"] + 60, d["y"] + d["height"] * frac, steps=8)
                indicator = page.locator("#tag-list .drop-before, #tag-list .drop-after, #tag-list .drop-into, #tag-list .drop-invalid")
                assert indicator.count() == 1  # the drop indicator is visible while dragging
                page.mouse.up()

            # Reorder: Gamma between Alpha's group and Beta -> before Beta.
            mouse_drag("Gamma", "Beta", 0.1)
            page.wait_for_function("() => document.querySelector('#tag-list .label-name').textContent === 'Alpha'")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Gamma,Beta", page.evaluate(LAYOUT_JS)

            # Refused: Alpha onto its own sub-label changes nothing and shows a message.
            mouse_drag("Alpha", "Alpha child", 0.5)
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Gamma,Beta"
            assert page.locator("#tag-list .drop-invalid, #tag-list .is-dragging").count() == 0

            # Nest: Beta onto Gamma.
            mouse_drag("Beta", "Gamma", 0.5)
            page.wait_for_function("() => document.querySelectorAll('#tag-list .label-name').length === 4")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Gamma,-Beta", page.evaluate(LAYOUT_JS)

            # Touch: drag the grip of Gamma up to the top edge of Alpha (before it).
            cdp = context.new_cdp_session(page)
            grip = row("Gamma").locator("[data-label-grip]").bounding_box()
            alpha = row("Alpha").bounding_box()
            x = grip["x"] + grip["width"] / 2
            y0 = grip["y"] + grip["height"] / 2
            y1 = alpha["y"] + 2

            def touch(kind: str, y: float) -> None:
                points = [] if kind == "touchEnd" else [{"x": x, "y": y}]
                cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

            touch("touchStart", y0)
            for i in range(1, 9):
                touch("touchMove", y0 + (y1 - y0) * i / 8)
            page.wait_for_selector("#tag-list .drop-before")  # the indicator shows where it will land
            assert page.locator("#tag-list .drop-before").count() == 1
            touch("touchEnd", y1)
            page.wait_for_function("() => document.querySelector('#tag-list .label-name').textContent === 'Gamma'")
            expected = "Gamma,-Beta,Alpha,-Alpha child"
            assert page.evaluate(LAYOUT_JS) == expected, page.evaluate(LAYOUT_JS)

            # Survives a reload and a new unlock.
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.wait_for_selector("#tag-list .label-tree")
            for toggle in page.locator("#tag-list [data-label-toggle]").all():
                if toggle.inner_text().strip() == "▸":
                    toggle.click()
            assert page.evaluate(LAYOUT_JS) == expected, page.evaluate(LAYOUT_JS)
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
