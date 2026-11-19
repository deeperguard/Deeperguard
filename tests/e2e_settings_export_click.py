"""E2E: the export buttons in Settings are the topmost element and clickable without force.

Beta runs 232 and 242 reported "Locator.click: Timeout 6000ms exceeded ... covered by
something else" on 'Export current note', 'Export everything readable (ZIP)' and
'How to get this' (docs/notes/settings-export-click.md). For every one of those buttons
this test asks document.elementFromPoint at the middle of the button and requires the
button itself (or a child of it), then clicks it normally:

  - right after opening Settings, at 1280x720 and at phone width (390x844);
  - after a 'How to get this' click and after an 'Export current note' click;
  - after the ZIP password dialog was opened and cancelled with Escape.

While that dialog is open it is a modal: its #confirm-backdrop (or the dialog sheet on a
phone) must be what covers the buttons, which is what the beta log most likely saw, and
it must be gone after Escape.

    python tests/e2e_settings_export_click.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright  # noqa: E402

import e2e_layout_actions as base  # noqa: E402

NOTE = "Export click note"
BUTTONS = {
    "export note": "#btn-export-note",
    "export zip": "#btn-export-readable-zip",
    "how to get this": "details.cloud-howto > summary",
}
TOP_JS = """(sel) => {
  const el = document.querySelector(sel);
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (top && (top === el || el.contains(top))) return null;
  return top ? `${top.tagName}#${top.id}.${top.className}` : 'nothing';
}"""


def covering(page, selector: str) -> str | None:
    return page.evaluate(TOP_JS, selector)


def click(page, selector: str) -> None:
    """Normal click; when it times out, report which element covers the button."""
    try:
        page.click(selector, timeout=6000)
    except Exception as exc:
        raise AssertionError(f"click on {selector} failed, covered by {covering(page, selector)}: {exc}") from exc


def dialog_part(page, selector: str) -> str | None:
    """'#confirm-backdrop' or '#confirm-dialog' when that element (or a child) is on top of the button."""
    return page.evaluate(
        """(sel) => {
  const el = document.querySelector(sel);
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const hit = top && top.closest('#confirm-backdrop, #confirm-dialog');
  return hit ? '#' + hit.id : null;
}""",
        selector,
    )


def assert_all_on_top(page, where: str) -> None:
    for name, selector in BUTTONS.items():
        cover = covering(page, selector)
        assert cover is None, f"{where}: '{name}' is covered by {cover}"


def open_settings(page, opener: str) -> None:
    page.click(opener, timeout=10000)
    page.wait_for_selector("#btn-export-note", state="visible", timeout=10000)
    page.wait_for_timeout(500)


def run(playwright, url: str, viewport: tuple[int, int], opener: str) -> None:
    where = f"{viewport[0]}x{viewport[1]}"
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}).new_page()
        base.register(page, url)
        page.evaluate(base.DISMISS_JS)
        base.seed_note(page, NOTE)
        if viewport[0] >= 800:
            base.open_by_title(page, NOTE)
        open_settings(page, opener)
        assert_all_on_top(page, f"{where} after opening Settings")

        # Help click, then export-note click (a toast appears), then the ZIP dialog.
        click(page, BUTTONS["how to get this"])
        assert_all_on_top(page, f"{where} after 'How to get this'")
        click(page, BUTTONS["export note"])
        page.wait_for_function("() => document.getElementById('toast') && !document.getElementById('toast').hidden")
        assert_all_on_top(page, f"{where} after 'Export current note' with a toast open")

        click(page, BUTTONS["export zip"])
        page.wait_for_selector("#confirm-dialog:not([hidden])", timeout=10000)
        for name, selector in BUTTONS.items():
            assert dialog_part(page, selector), (
                f"{where}: while the ZIP password dialog is open '{name}' should sit under "
                f"#confirm-dialog or #confirm-backdrop, got {covering(page, selector)}"
            )
        page.keyboard.press("Escape")
        page.wait_for_selector("#confirm-dialog", state="hidden", timeout=10000)
        assert_all_on_top(page, f"{where} after cancelling the ZIP dialog with Escape")

        # Same action twice: both buttons still take a normal click, no force.
        click(page, BUTTONS["export zip"])
        page.wait_for_selector("#confirm-dialog:not([hidden])", timeout=10000)
        page.keyboard.press("Escape")
        page.wait_for_selector("#confirm-dialog", state="hidden", timeout=10000)
        click(page, BUTTONS["export note"])
        click(page, BUTTONS["how to get this"])
        assert_all_on_top(page, f"{where} after repeating the clicks")
    finally:
        browser.close()


def main() -> int:
    proc, url = base.run_server()
    try:
        with sync_playwright() as pw:
            run(pw, url, (1280, 720), "#btn-settings-nav")
            run(pw, url, (390, 844), "#btn-settings-head")
    finally:
        base.stop_server(proc)
    print("OK: export buttons are on top and clickable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
