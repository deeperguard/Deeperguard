"""E2E: page navigation in the desktop inline document viewer and in its own
"Full screen" mode (the .doc-ctl-fullscreen button, a real click).

A 12 page PDF is opened in the note's inline viewer at 1280x860 and 1920x1080.
Previous/next, the page field, Left/Right, PageUp/PageDown and Home/End must
each move the page that fills the view and the indicator together, in the
normal inline view and in full screen. The zoom level is kept when the page
changes, Left/Right scroll sideways when zoomed wider than the view, and a
one-page PDF and an image show no page controls. Synthetic data, throwaway
account.

    python tests/e2e_doc_inline_page_nav.py
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_doc_large_pdf import check, open_list_note, pdf_bytes  # noqa: E402
from e2e_doc_page_nav import SEED_JS, png_bytes  # noqa: E402
from e2e_layout_actions import DISMISS_JS, register, run_server, stop_server  # noqa: E402

PAGES = 12

# The visible page is measured on its own: the page with the most height in the
# scrolling container, below the sticky bar.
STATE_JS = """() => {
  const card = document.querySelector('.doc-inline-card');
  const full = document.fullscreenElement === card;
  const sc = full ? card : document.getElementById('doc-inline');
  const bar = card.querySelector('.doc-inline-toolbar');
  const view = sc.getBoundingClientRect();
  const top = Math.max(view.top, bar.getBoundingClientRect().bottom);
  const bottom = Math.min(view.bottom, innerHeight);
  let page = 0, most = -1;
  [...card.querySelectorAll('.doc-page-wrap')].forEach((w, i) => {
    const r = w.getBoundingClientRect();
    const shown = Math.min(r.bottom, bottom) - Math.max(r.top, top);
    if (shown > most) { most = shown; page = i + 1; }
  });
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return !el.closest('[hidden]') && r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
      && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  };
  const q = (s) => card.querySelector(s);
  const prev = q('.doc-ctl-prev'), next = q('.doc-ctl-next'), input = q('.doc-inline-page-input');
  const nav = q('.doc-inline-pagenav');
  const wrap = card.querySelector('.doc-page-wrap').getBoundingClientRect();
  return {
    full, page, scrollTop: sc.scrollTop,
    hasNav: !!nav && !nav.hidden,
    prevOn: !!prev && onScreen(prev), nextOn: !!next && onScreen(next), inputOn: !!input && onScreen(input),
    prevOff: prev ? prev.disabled : null, nextOff: next ? next.disabled : null,
    prevName: prev ? prev.getAttribute('aria-label') : null, nextName: next ? next.getAttribute('aria-label') : null,
    input: input ? input.value : null,
    total: q('.doc-inline-page-total') ? q('.doc-inline-page-total').textContent : null,
    status: q('.doc-inline-page-status') ? q('.doc-inline-page-status').textContent : null,
    zoom: card.dataset.zoom, wrapW: wrap.width, sticky: getComputedStyle(bar).position,
    barTop: bar.getBoundingClientRect().top - view.top,
  };
}"""

SCROLL_TO_PAGE_5_JS = """() => {
  const card = document.querySelector('.doc-inline-card');
  const sc = document.fullscreenElement === card ? card : document.getElementById('doc-inline');
  const bar = card.querySelector('.doc-inline-toolbar').getBoundingClientRect().height;
  const w = card.querySelectorAll('.doc-page-wrap')[4].getBoundingClientRect();
  sc.scrollTop += w.top - sc.getBoundingClientRect().top - bar + 20;
}"""

SIDEWAYS_JS = """() => [...document.querySelectorAll('#doc-inline, .doc-inline-main, .doc-inline-card')]
  .some((e) => e.scrollLeft > 0)"""


def state(page, wait=300):
    page.wait_for_timeout(wait)
    return page.evaluate(STATE_JS)


def agrees(label, s, expected):
    ok = s["page"] == expected and s["input"] == str(expected) and s["total"] == str(PAGES)
    return check(f"{label}: page {expected} visible and shown in the field", ok, s)


def open_inline(page, title):
    open_list_note(page, title)
    page.wait_for_selector(".doc-inline-stage .doc-page-wrap", timeout=60000)
    page.wait_for_timeout(800)


def exercise(page, tag, expect_full) -> int:
    bad = 0
    s = state(page)
    bad += not check(f"{tag}: full screen is {expect_full}", s["full"] == expect_full, s)
    bad += not check(f"{tag}: previous, next and page field are on screen", s["hasNav"] and s["prevOn"] and s["nextOn"] and s["inputOn"], s)
    bad += not check(f"{tag}: buttons have accessible names", s["prevName"] == "Previous page" and s["nextName"] == "Next page", s)
    bad += not check(f"{tag}: sticky bar stays at the top edge", s["sticky"] == "sticky" and abs(s["barTop"]) <= 1, s)
    bad += not agrees(f"{tag}: start", s, 1)
    bad += not check(f"{tag}: previous disabled on page 1", s["prevOff"] and not s["nextOff"], s)
    page.click(".doc-ctl-next")
    s = state(page)
    bad += not agrees(f"{tag}: next", s, 2)
    page.wait_for_timeout(300)
    bad += not check(f"{tag}: status announces the change", state(page)["status"] == f"Page 2 of {PAGES}", s)
    page.click(".doc-ctl-prev")
    bad += not agrees(f"{tag}: previous", state(page), 1)
    page.fill(".doc-inline-page-input", "7")
    page.press(".doc-inline-page-input", "Enter")
    bad += not agrees(f"{tag}: typed page", state(page), 7)
    page.fill(".doc-inline-page-input", "99")
    page.press(".doc-inline-page-input", "Enter")
    bad += not agrees(f"{tag}: page past the end clamps", state(page), PAGES)
    # Keys act with the pointer over the viewer and no text field focused.
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    box = page.locator(".doc-inline-card .doc-page-wrap").first.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, 400)
    page.keyboard.press("Home")
    bad += not agrees(f"{tag}: Home", state(page), 1)
    page.keyboard.press("PageDown")
    bad += not agrees(f"{tag}: PageDown", state(page), 2)
    page.keyboard.press("ArrowRight")
    bad += not agrees(f"{tag}: ArrowRight", state(page), 3)
    page.keyboard.press("ArrowLeft")
    bad += not agrees(f"{tag}: ArrowLeft", state(page), 2)
    page.keyboard.press("PageUp")
    bad += not agrees(f"{tag}: PageUp", state(page), 1)
    page.keyboard.press("End")
    s = state(page)
    bad += not agrees(f"{tag}: End", s, PAGES)
    bad += not check(f"{tag}: next disabled on the last page", s["nextOff"] and not s["prevOff"], s)
    page.keyboard.press("Home")
    state(page)
    # Scrolling moves the indicator along.
    page.evaluate(SCROLL_TO_PAGE_5_JS)
    bad += not agrees(f"{tag}: indicator follows scrolling", state(page, 500), 5)
    # Zoom is kept when the page changes.
    page.click(".doc-ctl-zoom-in")
    page.click(".doc-ctl-zoom-in")
    z = state(page)
    page.click(".doc-ctl-next")
    n = state(page)
    bad += not check(f"{tag}: zoom kept on page change", n["zoom"] == z["zoom"] != "1" and abs(n["wrapW"] - z["wrapW"]) < 2, (z, n))
    # Zoomed wider than the view: Left/Right scroll sideways, PageDown still pages.
    page.mouse.move(box["x"] + 50, 400)
    before = state(page)
    page.keyboard.press("ArrowRight")
    after = state(page)
    bad += not check(f"{tag}: ArrowRight scrolls sideways when zoomed, page unchanged",
                     after["page"] == before["page"] and page.evaluate(SIDEWAYS_JS), (before, after))
    page.keyboard.press("PageDown")
    after = state(page)
    bad += not check(f"{tag}: PageDown still pages when zoomed", after["page"] == before["page"] + 1, after)
    page.click(".doc-ctl-fit")
    return bad


def run_viewport(p, base, width, height) -> int:
    bad = 0
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": width, "height": height}).new_page()
    register(page, base)
    page.evaluate(DISMISS_JS)
    page.evaluate(SEED_JS, ["Doc pages", base64.b64encode(pdf_bytes(PAGES)).decode(), "pages.pdf", "application/pdf"])
    page.evaluate(SEED_JS, ["Doc single", base64.b64encode(pdf_bytes(1)).decode(), "single.pdf", "application/pdf"])
    page.evaluate(SEED_JS, ["Doc image", base64.b64encode(png_bytes()).decode(), "photo.png", "image/png"])
    open_inline(page, "Doc pages")
    bad += exercise(page, f"{width}px inline", False)
    # Full screen keeps the current page, so start it from page 1.
    page.fill(".doc-inline-page-input", "1")
    page.press(".doc-inline-page-input", "Enter")
    page.click(".doc-ctl-fullscreen")
    page.wait_for_function(
        "() => document.fullscreenElement && document.fullscreenElement.classList.contains('doc-inline-card')",
        timeout=5000,
    )
    page.wait_for_timeout(500)
    bad += exercise(page, f"{width}px full screen", True)
    page.click(".doc-ctl-fullscreen")
    page.wait_for_timeout(400)
    s = state(page)
    bad += not check(f"{width}px: back in the inline view, controls still there", not s["full"] and s["hasNav"] and s["prevOn"], s)
    if width == 1280:
        for title in ("Doc single", "Doc image"):
            open_list_note(page, title)
            page.wait_for_timeout(1500)
            n = page.evaluate(
                "() => [...document.querySelectorAll('.doc-inline-pagenav, .doc-ctl-prev, .doc-ctl-next')]"
                ".filter((e) => e.getClientRects().length).length"
            )
            bad += not check(f"{title}: no page controls", n == 0, n)
    browser.close()
    return bad


def run() -> int:
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            bad += run_viewport(p, base, 1280, 860)
            bad += run_viewport(p, base, 1920, 1080)
    finally:
        stop_server(proc)
    print("FAILURES:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run())
