"""E2E (Playwright): a touch drag of a grip scrolls the note list at its top and bottom edge.

Forty notes carry one label, in "Own order". The grip of the top row is held at the bottom
edge of the list until the list stops scrolling: the note is dropped below the rows that
were in view when the drag began, and the rest of the order is unchanged. The same note is
then held at the top edge until the list is back at the top and lands near the top. Any
pageerror / console.error fails the test.

    python tests/e2e_note_grip_autoscroll.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_note_drag_order import wait_order  # noqa: E402
from e2e_note_own_order import SYNCED_JS, TITLES_JS, unlock  # noqa: E402
from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

SEED_JS = """() => {
  const label = NotesStore.createTag('Trip');
  for (let i = 1; i <= 40; i++) {
    const title = `Note ${String(i).padStart(2, '0')}`;
    NotesStore.upsert(crypto.randomUUID(), { type: 'note', title, body: title, tags: [label] });
  }
  return label;
}"""
LIST_BOX_JS = """() => {
  const r = document.getElementById('note-list').getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}"""
# Index (in the shown order) of the last row that is completely inside the list.
LAST_FULL_ROW_JS = """() => {
  const list = document.getElementById('note-list').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#note-list .note-row')];
  let last = -1;
  rows.forEach((el, i) => {
    const b = el.getBoundingClientRect();
    if (b.top >= list.top && b.bottom <= list.bottom) last = i;
  });
  return last;
}"""
AT_BOTTOM_JS = "() => { const l = document.getElementById('note-list'); return l.scrollTop + l.clientHeight >= l.scrollHeight - 2; }"
AT_TOP_JS = "() => document.getElementById('note-list').scrollTop === 0"


def aborted_off_origin(message, base: str) -> bool:
    """The browser logs the request this test aborted on purpose (an off-origin resource)."""
    return message.text == "Failed to load resource: net::ERR_FAILED" and not message.location.get("url", "").startswith(base)


def row(page, title: str):
    return page.locator("#note-list .note-row", has=page.locator("h3", has_text=title))


def grip_centre(page, title: str) -> tuple[float, float]:
    box = row(page, title).locator(".note-row-grip").bounding_box()
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def touch_hold(page, cdp, start: tuple[float, float], end: tuple[float, float], until_js: str) -> None:
    """Touch at start, move to end, keep the finger there until until_js is true (max 8 s)."""
    x0, y0 = start
    x1, y1 = end
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for i in range(1, 9):
        f = i / 8
        point = {"x": x0 + (x1 - x0) * f, "y": y0 + (y1 - y0) * f}
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point]})
    for _ in range(80):
        page.wait_for_timeout(100)
        if page.evaluate(until_js):
            break
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x1, "y": y1}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-gripscroll-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            context = browser.new_context(viewport={"width": 1400, "height": 1000}, has_touch=True)
            context.set_default_timeout(30000)
            # Only this server is reachable: the Turnstile widget (Cloudflare) is aborted, register sends its own token.
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on(
                "console",
                lambda m: errors.append(f"console.error: {m.text}")
                if m.type == "error" and "frame-ancestors" not in m.text and not aborted_off_origin(m, base)
                else None,
            )
            register(page, base)
            page.locator("#btn-nav-pin").click()
            page.wait_for_function("() => document.body.classList.contains('nav-pinned')")
            label = page.evaluate(SEED_JS)
            page.wait_for_function(SYNCED_JS, timeout=30000)
            page.reload(wait_until="domcontentloaded")
            unlock(page)
            page.locator("#tag-section").evaluate("(el) => { el.open = true; }")
            page.locator("#tag-list [role=treeitem][aria-label^='Trip']").first.click()
            page.wait_for_function("() => document.querySelectorAll('#note-list .note-row').length === 40")
            page.select_option("#sort-select", "manual")
            page.wait_for_function("() => document.querySelectorAll('.note-row-grip').length === 40")
            cdp = context.new_cdp_session(page)

            # The list is taller than the window, so the bottom rows start out of view.
            order = page.evaluate(TITLES_JS)
            last_visible = page.evaluate(LAST_FULL_ROW_JS)
            assert 0 < last_visible < len(order) - 5, (last_visible, len(order))
            assert page.evaluate("() => document.getElementById('note-list').scrollTop") == 0

            # Touch: the grip of the top row is held at the bottom edge until the list is at its end.
            moved = order[0]
            box = page.locator("#note-list").bounding_box()
            touch_hold(page, cdp, grip_centre(page, moved), (box["x"] + box["width"] / 2, box["y"] + box["height"] - 40), AT_BOTTOM_JS)
            after = page.evaluate(TITLES_JS)
            assert page.evaluate("() => document.getElementById('note-list').scrollTop") > 0
            landed = after.index(moved)
            assert landed >= last_visible + 3, (landed, last_visible)
            expected = [t for t in order if t != moved]
            expected.insert(landed, moved)
            wait_order(page, expected)
            order = expected

            # Touch: the same note's grip is held at the top edge until the list is back at the top.
            box = page.locator("#note-list").bounding_box()
            touch_hold(page, cdp, grip_centre(page, moved), (box["x"] + box["width"] / 2, box["y"] + 40), AT_TOP_JS)
            after = page.evaluate(TITLES_JS)
            landed = after.index(moved)
            assert landed <= 1, landed
            expected = [t for t in order if t != moved]
            expected.insert(landed, moved)
            wait_order(page, expected)

            browser.close()
        for line in errors:
            print("FAIL:", line)
        if not errors:
            print("e2e_note_grip_autoscroll ok")
        return 1 if errors else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
