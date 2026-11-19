"""E2E: paging and wheel scrolling in the inline document viewer's Full screen
mode, whatever `overflow-y: clip` next to `overflow-x: auto` computes to.

Chromium 156 (the Playwright build) keeps `clip`; current stable Chromium,
Brave, Firefox and Safari compute `hidden`. Every check therefore runs twice:
as is, and with `.doc-inline-card .doc-inline-main{overflow-y:hidden!important}`
injected, which is what those browsers compute. The browser is a real
1200x800 window on a 1920x1080 screen, so entering full screen resizes it.
Positions are measured on the pages themselves (getBoundingClientRect of the
target page against the bottom of the toolbar), not read from the indicator.
Synthetic data, throwaway account.

    python tests/e2e_doc_inline_fullscreen_scroll.py
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_doc_large_pdf import check, open_list_note, pdf_bytes  # noqa: E402
from e2e_doc_page_nav import SEED_JS  # noqa: E402
from e2e_layout_actions import DISMISS_JS, register, run_server, stop_server  # noqa: E402

PAGES = 12
FORCE_HIDDEN = ".doc-inline-card .doc-inline-main{overflow-y:hidden!important}"

# Page positions relative to the bottom of the toolbar, the page with the most
# visible area, the indicator and the drawn canvases.
STATE_JS = """() => {
  const card = document.querySelector('.doc-inline-card');
  const bar = card.querySelector('.doc-inline-toolbar').getBoundingClientRect();
  const wraps = [...card.querySelectorAll('.doc-page-wrap')];
  const inline = document.getElementById('doc-inline').getBoundingClientRect();
  const full = document.fullscreenElement === card;
  const viewTop = Math.max(bar.bottom, full ? 0 : inline.top);
  const viewBottom = Math.min(innerHeight, full ? innerHeight : inline.bottom);
  let shown = 0, most = -1;
  const tops = wraps.map((w, i) => {
    const r = w.getBoundingClientRect();
    const vis = Math.min(r.bottom, viewBottom) - Math.max(r.top, viewTop);
    if (vis > most) { most = vis; shown = i + 1; }
    return r.top - bar.bottom;
  });
  const main = card.querySelector('.doc-inline-main');
  return {
    full, shown, tops, viewBottom,
    bottoms: wraps.map((w) => w.getBoundingClientRect().bottom),
    input: card.querySelector('.doc-inline-page-input').value,
    mainOverflowY: getComputedStyle(main).overflowY,
    mainClient: main.clientHeight, mainScroll: main.scrollHeight,
    cardScroll: card.scrollTop, mainTop: main.scrollTop, innerHeight,
  };
}"""


def state(page, wait=400):
    page.wait_for_timeout(wait)
    return page.evaluate(STATE_JS)


def agrees(label, s, n):
    ok = abs(s["tops"][n - 1]) <= 3 and s["input"] == str(n) and s["shown"] == n
    return check(f"{label}: page {n} at the top below the toolbar, field shows {n}", ok, s)


def wait_canvas(page, n) -> bool:
    try:
        page.wait_for_function(
            "(n) => { const c = document.querySelectorAll('.doc-inline-card .doc-page-wrap')[n - 1]"
            ".querySelector('canvas'); return !!c && c.width > 0 && c.height > 0; }",
            arg=n, timeout=15000)
        return True
    except Exception:  # noqa: BLE001
        return False


def enter_full(page):
    page.click(".doc-ctl-fullscreen")
    page.wait_for_function(
        "() => document.fullscreenElement && document.fullscreenElement.classList.contains('doc-inline-card')",
        timeout=5000)
    page.wait_for_timeout(700)


def exit_full(page):
    page.click(".doc-ctl-fullscreen")
    page.wait_for_function("() => !document.fullscreenElement", timeout=5000)
    page.wait_for_timeout(700)


def exercise(page, tag) -> int:
    bad = 0
    enter_full(page)
    s = state(page)
    bad += not check(f"{tag}: window grew to the screen", s["innerHeight"] > 900, s)
    bad += not agrees(f"{tag}: start", s, 1)
    for i in (2, 3, 4):
        page.click(".doc-ctl-next")
        bad += not agrees(f"{tag}: next -> {i}", state(page), i)
    bad += not check(f"{tag}: page 4 drawn after the jump", wait_canvas(page, 4))
    page.click(".doc-ctl-prev")
    bad += not agrees(f"{tag}: previous", state(page), 3)
    page.fill(".doc-inline-page-input", "7")
    page.press(".doc-inline-page-input", "Enter")
    bad += not agrees(f"{tag}: typed 7", state(page), 7)
    bad += not check(f"{tag}: page 7 drawn after the jump", wait_canvas(page, 7))
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    page.mouse.move(600, 500)
    page.keyboard.press("PageDown")
    bad += not agrees(f"{tag}: PageDown", state(page), 8)
    page.keyboard.press("PageUp")
    bad += not agrees(f"{tag}: PageUp", state(page), 7)
    page.keyboard.press("Home")
    bad += not agrees(f"{tag}: Home", state(page), 1)
    page.keyboard.press("End")
    s = state(page)
    bad += not agrees(f"{tag}: End", state(page), PAGES)
    bad += not check(f"{tag}: last page drawn", wait_canvas(page, PAGES))
    page.keyboard.press("Home")
    # The wheel scrolls the document and the indicator follows.
    before = state(page)
    for _ in range(4):
        page.mouse.wheel(0, 600)
        page.wait_for_timeout(100)
    after = state(page, 600)
    moved = before["tops"][0] - after["tops"][0]
    bad += not check(f"{tag}: wheel scrolled the document (page 1 moved up by {moved:.0f}px)", moved > 1000, (before, after))
    bad += not check(f"{tag}: indicator follows the wheel and shows the page in view",
                     int(after["input"]) in (after["shown"] - 1, after["shown"]) and int(after["input"]) >= 2
                     and after["tops"][int(after["input"]) - 1] < after["viewBottom"], after)
    # Leaving and entering full screen keeps the page.
    page.fill(".doc-inline-page-input", "5")
    page.press(".doc-inline-page-input", "Enter")
    bad += not agrees(f"{tag}: typed 5", state(page), 5)
    exit_full(page)
    s = state(page)
    bad += not check(f"{tag}: leaving full screen keeps page 5 in view", s["input"] == "5" and s["shown"] == 5, s)
    bad += not check(f"{tag}: page 5 drawn inline", wait_canvas(page, 5))
    # Paging works in the normal inline view too.
    page.click(".doc-ctl-next")
    s = state(page)
    bad += not check(f"{tag}: inline next shows page 6 in view", s["input"] == "6" and s["shown"] == 6, s)
    enter_full(page)
    s = state(page)
    bad += not check(f"{tag}: entering full screen keeps page 6 in view", s["input"] == "6" and s["shown"] == 6, s)
    exit_full(page)
    return bad


def run_mode(p, base, force) -> int:
    tag = "forced overflow-y:hidden" if force else "as is"
    browser = p.chromium.launch(
        headless=True,
        args=["--headless=new", "--window-size=1200,800", "--screen-info={1920x1080}"])
    page = browser.new_context(no_viewport=True).new_page()
    register(page, base)
    page.evaluate(DISMISS_JS)
    page.evaluate(SEED_JS, ["Doc pages", base64.b64encode(pdf_bytes(PAGES)).decode(), "pages.pdf", "application/pdf"])
    open_list_note(page, "Doc pages")
    page.wait_for_selector(".doc-inline-stage .doc-page-wrap", timeout=60000)
    page.wait_for_timeout(800)
    if force:
        page.add_style_tag(content=FORCE_HIDDEN)
    bad = exercise(page, tag)
    browser.close()
    return bad


def run() -> int:
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            bad += run_mode(p, base, False)
            bad += run_mode(p, base, True)
    finally:
        stop_server(proc)
    print("FAILURES:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run())
