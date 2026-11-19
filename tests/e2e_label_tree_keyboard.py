"""E2E (Playwright): keyboard moves and ARIA roles in the sidebar label tree.

The tree exposes role=tree / treeitem with aria-level and aria-expanded. With the keyboard
alone Alt+Up/Down reorder, Alt+Right indents and Alt+Left outdents; "Move to..." in the
actions menu puts a label under a chosen parent and does not offer its own sub-labels.
Moves are announced in the polite live region and survive a reload.

    python tests/e2e_label_tree_keyboard.py
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

    root = Path(tempfile.mkdtemp(prefix="e2e-labelkbd-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 1400, "height": 1000})
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
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
            page.locator("#tag-list [data-label-toggle]").first.click()
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,Gamma"

            def row(name: str):
                return page.locator(f'#tag-list [role=treeitem][aria-label^="{name},"]')

            # ARIA roles and attributes.
            assert page.locator('#tag-list [role=tree]').count() == 1
            assert page.locator("#tag-list [role=treeitem]").count() == 4
            assert row("Alpha").get_attribute("aria-level") == "1"
            assert row("Alpha").get_attribute("aria-expanded") == "true"
            assert row("Alpha child").get_attribute("aria-level") == "2"
            assert row("Beta").get_attribute("aria-expanded") is None

            def press(name: str, chord: str) -> None:
                row(name).focus()
                page.keyboard.press(chord)

            # Down: Beta below Gamma.
            press("Beta", "Alt+ArrowDown")
            page.wait_for_function("() => document.querySelector('#toast').textContent.includes('moved')")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Gamma,Beta", page.evaluate(LAYOUT_JS)
            assert page.evaluate("() => document.activeElement.getAttribute('aria-label')").startswith("Beta,")
            assert page.locator("#toast[role=status][aria-live=polite]").count() == 1
            # Up again.
            press("Beta", "Alt+ArrowUp")
            page.wait_for_function("() => document.querySelector('#tag-list .label-tree').textContent.indexOf('Beta') < document.querySelector('#tag-list .label-tree').textContent.indexOf('Gamma')")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,Gamma"
            # Indent: Gamma becomes the last child of Beta.
            press("Gamma", "Alt+ArrowRight")
            page.wait_for_function("() => document.querySelectorAll('#tag-list [aria-level=\\'2\\']').length === 2")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,-Gamma", page.evaluate(LAYOUT_JS)
            assert row("Beta").get_attribute("aria-expanded") == "true"
            assert row("Gamma").get_attribute("aria-level") == "2"
            # Outdent: Gamma back to top level, after Beta.
            press("Gamma", "Alt+ArrowLeft")
            page.wait_for_function("() => document.querySelectorAll('#tag-list [aria-level=\\'2\\']').length === 1")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,Gamma", page.evaluate(LAYOUT_JS)
            # Outdent at top level is refused with a message and changes nothing.
            press("Gamma", "Alt+ArrowLeft")
            assert "top level" in page.locator("#toast").inner_text()
            assert page.locator("#toast").get_attribute("role") == "status"
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,Gamma"

            # Move to...: Gamma under Beta via the menu; Alpha cannot go under its own child.
            press("Alpha", "Shift+F10")
            page.locator('#label-menu [data-act="move"]').click()
            options = page.locator("#label-move-select option").all_inner_texts()
            assert "Alpha / Alpha child" not in options and "Beta" in options, options
            page.keyboard.press("Escape")
            # Escape leaves the first menu's pointerdown listener attached. A press inside the
            # new Gamma menu must not close it through that stale listener (openLabelMenu `away`).
            press("Gamma", "Shift+F10")
            page.locator('#label-menu [data-act="move"]').click()
            assert page.locator("#label-move-select").count() == 1, "press inside a newer label menu closed it"
            page.locator("#label-move-select").select_option(label="Beta")
            page.locator("[data-move-ok]").click()
            page.wait_for_function("() => document.querySelectorAll('#tag-list [aria-level=\\'2\\']').length === 2")
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,-Gamma", page.evaluate(LAYOUT_JS)

            # Persisted through the same store path.
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.wait_for_selector("#tag-list .label-tree")
            for toggle in page.locator("#tag-list [data-label-toggle]").all():
                if toggle.inner_text().strip() == "▸":
                    toggle.click()
            assert page.evaluate(LAYOUT_JS) == "Alpha,-Alpha child,Beta,-Gamma", page.evaluate(LAYOUT_JS)
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
