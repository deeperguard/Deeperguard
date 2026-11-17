"""E2E: right after #btn-nav-pin expands or collapses the sidebar, the folder
action 'Rename folder Werk' is clickable at once (no sleep, 1000 ms timeout).

The sidebar has no animation that blocks clicks. The folder actions are only
live while their row is hovered (opacity 0 and pointer-events none otherwise),
so a click on the pencil without a pointer over the row lands on the folder
name button. The test checks that cause as well as the click that works.

    python tests/e2e_sidebar_pin_click.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_layout_actions as base  # noqa: E402

PIN = "#btn-nav-pin"
RENAME = '[aria-label="Rename folder Werk"]'
ROW = '#folder-list [role=treeitem][data-folder-title="Werk"]'
TOP_JS = """(sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return top && top.className;
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    report = base.Report()
    proc, url = base.run_server()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
            base.register(page, url)
            page.evaluate(base.DISMISS_JS)
            page.click("#app-tab-notes", timeout=10000)
            page.locator(PIN).click(timeout=1000)
            page.wait_for_function("() => document.body.classList.contains('nav-pinned')")
            page.evaluate("() => { document.getElementById('folder-section').open = true; }")
            page.locator("#btn-new-folder").click(timeout=1000)
            page.fill("#folder-name-input", "Werk")
            page.keyboard.press("Enter")
            page.wait_for_selector(RENAME, state="attached", timeout=10000)

            for step in range(4):
                want_pinned = step % 2 == 1  # collapse first, then expand, and so on
                label = "expanding" if want_pinned else "collapsing"
                page.locator(PIN).click(timeout=1000)
                # No wait: the class flips synchronously in the click handler.
                pinned = page.evaluate("() => document.body.classList.contains('nav-pinned')")
                report.check(f"{label}: state flipped by the click", pinned is want_pinned)
                report.check(f"{label}: pointer not over the row, actions are not hit",
                             page.evaluate(TOP_JS, RENAME) == "folder-select")
                page.locator(ROW).hover(timeout=1000)
                try:
                    page.locator(RENAME).click(timeout=1000)
                    page.wait_for_selector(".folder-rename-input", timeout=1000)
                    opened = True
                except Exception as err:  # noqa: BLE001
                    opened = False
                    print(base.first_line(err))
                report.check(f"{label}: Rename folder opens right after the pin click", opened)
                # Leave the field again (the first Escape after creating the folder did not
                # close the field in the browser, so press until it is gone).
                for _ in range(2):
                    if page.locator(".folder-rename-input").count():
                        page.keyboard.press("Escape")
                page.wait_for_selector(".folder-rename-input", state="detached", timeout=1000)
            browser.close()
    finally:
        base.stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {report.checked} sidebar pin click checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
