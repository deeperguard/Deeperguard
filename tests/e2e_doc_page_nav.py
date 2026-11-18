"""E2E: page navigation in the full document preview.

Opens a 12 page PDF in the full preview at 390px (touch) and 1280px and turns
pages with the buttons, the page number field and the keyboard; after every
step the indicator, the page that fills most of the view and the live region
must agree. At 390px a one-finger swipe turns the page, a vertical scroll moves
the indicator along, and a two-finger pinch zooms in (after which a swipe no
longer turns the page). Reopening the document returns to the last page; no
storage write mentions it, and locking forgets it. A one-page PDF and an image
show no page controls. Synthetic data, throwaway account.

    python tests/e2e_doc_page_nav.py
"""
from __future__ import annotations

import base64
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_doc_large_pdf import close_viewer, open_list_note, open_viewer, pdf_bytes  # noqa: E402
from e2e_layout_actions import DISMISS_JS, register, run_server, stop_server  # noqa: E402
from e2e_signup_autounlock import PASSWORD  # noqa: E402

PAGES = 12

# Records every localStorage/sessionStorage write, to show the page position is not stored.
INIT_JS = """() => {
  window.__storageWrites = [];
  const native = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    window.__storageWrites.push([String(key), String(value)]);
    return native.call(this, key, value);
  };
}"""

SEED_JS = """async ([title, b64, name, type]) => {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, content: '', attachments: [] });
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  const attId = await NotesStore.addAttachment(id, new File([bytes], name, { type }), { displayName: name });
  NotesStore.setAttachmentOcr(attId, 'page text', 'client', []);
  NotesStore.refreshNoteSearchText(id);
  return attId;
}"""

# The visible page is measured here on its own: the page with the most height inside the stage.
STATE_JS = """() => {
  const nav = document.getElementById('doc-page-nav');
  const stage = document.getElementById('doc-stage');
  const view = stage.getBoundingClientRect();
  const wraps = [...stage.querySelectorAll('.doc-page-wrap')];
  let visiblePage = 0;
  let most = -1;
  wraps.forEach((wrap, i) => {
    const r = wrap.getBoundingClientRect();
    const shown = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
    if (shown > most) { most = shown; visiblePage = i + 1; }
  });
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return !el.closest('[hidden]') && r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
      && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  };
  const button = (id) => {
    const b = document.getElementById(id);
    const r = b.getBoundingClientRect();
    return { w: r.width, h: r.height, disabled: b.disabled, name: b.getAttribute('aria-label') || '', onScreen: onScreen(b) };
  };
  const status = document.getElementById('doc-page-status');
  const input = document.getElementById('doc-page-input');
  const navRect = nav.getBoundingClientRect();
  const top = wraps[visiblePage - 1] ? wraps[visiblePage - 1].getBoundingClientRect().top - view.top : null;
  return {
    pages: wraps.length,
    navHidden: nav.hidden,
    navOnScreen: !nav.hidden && onScreen(nav),
    navCoversStage: !nav.hidden && navRect.top < view.bottom - 1 && navRect.bottom > view.top,
    input: input.value,
    inputOnScreen: onScreen(input),
    inputName: input.getAttribute('aria-label') || '',
    total: document.getElementById('doc-page-total').textContent.trim(),
    visiblePage,
    pageTop: top,
    atScrollEnd: stage.scrollTop >= stage.scrollHeight - stage.clientHeight - 1,
    scrollTop: stage.scrollTop,
    scale: stage._docZoom ? stage._docZoom.getScale() : 1,
    status: status.textContent,
    statusLive: status.getAttribute('aria-live'),
    focusInViewer: document.getElementById('doc-viewer').contains(document.activeElement),
    focusId: document.activeElement ? document.activeElement.id : '',
    prev: button('doc-page-prev'),
    next: button('doc-page-next'),
  };
}"""


def png_bytes(width: int = 40, height: int = 30) -> bytes:
    raw = b"".join(b"\x00" + bytes((x * 5 + y * 3) % 256 for x in range(width)) for y in range(height))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name, "" if cond else detail)
    return bool(cond)


def state(page, wait=350):
    page.wait_for_timeout(wait)
    return page.evaluate(STATE_JS)


def at_page(label, s, expected):
    """Indicator, visible page and announcement all name `expected`; the page is at the top unless the end is reached."""
    bad = 0
    bad += not check(f"{label}: indicator shows page {expected}", s["input"] == str(expected), s)
    bad += not check(f"{label}: page {expected} fills most of the view", s["visiblePage"] == expected, s)
    bad += not check(f"{label}: live region says 'Page {expected} of {PAGES}'",
                     s["status"] == f"Page {expected} of {PAGES}" and s["statusLive"] == "polite", s["status"])
    if not s["atScrollEnd"]:
        bad += not check(f"{label}: page {expected} is scrolled to the top", abs(s["pageTop"]) < 2, s["pageTop"])
    bad += not check(f"{label}: focus stays in the viewer", s["focusInViewer"], s["focusId"])
    return bad


def wait_viewer_media(page, selector):
    page.wait_for_function("(sel) => !!document.querySelector(sel)", arg=selector, timeout=60000)
    page.wait_for_timeout(800)


def touch(cdp, kind, points):
    cdp.send("Input.dispatchTouchEvent", {
        "type": kind,
        "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(points)],
    })


def swipe(page, cdp, x0, y0, x1, y1, steps=6):
    touch(cdp, "touchStart", [(x0, y0)])
    for i in range(1, steps + 1):
        touch(cdp, "touchMove", [(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)])
        page.wait_for_timeout(16)
    touch(cdp, "touchEnd", [])


def pinch_out(page, cdp, cx, cy):
    touch(cdp, "touchStart", [(cx - 30, cy), (cx + 30, cy)])
    for i in range(1, 9):
        touch(cdp, "touchMove", [(cx - 30 - i * 15, cy), (cx + 30 + i * 15, cy)])
        page.wait_for_timeout(16)
    touch(cdp, "touchEnd", [])


def run_viewport(p, base, width, height, mobile) -> int:
    bad = 0
    tag = f"{width}px"
    browser = p.chromium.launch(headless=True)
    opts = {"viewport": {"width": width, "height": height}}
    if mobile:
        opts.update(has_touch=True, is_mobile=True)
    ctx = browser.new_context(**opts)
    page = ctx.new_page()
    page.add_init_script(f"({INIT_JS})()")
    register(page, base)
    page.evaluate(DISMISS_JS)
    att_id = page.evaluate(SEED_JS, ["Doc pages", base64.b64encode(pdf_bytes(PAGES)).decode(), "pages.pdf", "application/pdf"])
    page.evaluate(SEED_JS, ["Doc single", base64.b64encode(pdf_bytes(1)).decode(), "single.pdf", "application/pdf"])
    img_id = page.evaluate(SEED_JS, ["Doc image", base64.b64encode(png_bytes()).decode(), "photo.png", "image/png"])

    open_viewer(page, "Doc pages")
    s = state(page)
    bad += not check(f"{tag}: all {PAGES} pages are in the preview", s["pages"] == PAGES, s["pages"])
    bad += not check(f"{tag}: page controls visible on screen", s["navOnScreen"] and s["inputOnScreen"], s)
    bad += not check(f"{tag}: controls sit below the document, not over it", not s["navCoversStage"], s)
    bad += not check(f"{tag}: indicator reads 'Page 1 of {PAGES}'", s["input"] == "1" and s["total"] == str(PAGES), s)
    for key in ("prev", "next"):
        b = s[key]
        bad += not check(f"{tag}: {key} button at least 44x44 and on screen", b["w"] >= 44 and b["h"] >= 44 and b["onScreen"], b)
        bad += not check(f"{tag}: {key} button has an accessible name", b["name"] in ("Previous page", "Next page"), b)
    bad += not check(f"{tag}: page field has an accessible name", s["inputName"].startswith("Page number"), s["inputName"])
    bad += not check(f"{tag}: previous disabled on the first page", s["prev"]["disabled"] and not s["next"]["disabled"], s)

    page.evaluate("() => { window.__storageWrites.length = 0; }")

    # Buttons.
    page.click("#doc-page-next")
    bad += at_page(f"{tag} button next", state(page), 2)
    page.click("#doc-page-next")
    bad += at_page(f"{tag} button next again", state(page), 3)
    page.click("#doc-page-prev")
    bad += at_page(f"{tag} button previous", state(page), 2)

    # Typed page numbers (Enter), including the first and last page and an out-of-range number.
    for typed, expected in (("7", 7), ("1", 1), (str(PAGES), PAGES), ("99", PAGES), ("4", 4)):
        page.fill("#doc-page-input", typed)
        page.press("#doc-page-input", "Enter")
        bad += at_page(f"{tag} typed {typed}", state(page), expected)

    # While the page field has focus the arrow keys edit the text, not the page.
    page.focus("#doc-page-input")
    page.keyboard.press("ArrowRight")
    s = state(page)
    bad += not check(f"{tag}: ArrowRight in the page field does not turn the page", s["visiblePage"] == 4 and s["input"] == "4", s)

    # Keyboard, with focus on a viewer button (not a text field).
    page.focus("#doc-page-prev")
    for key, expected in (("ArrowRight", 5), ("PageDown", 6), ("ArrowLeft", 5), ("PageUp", 4), ("End", PAGES), ("Home", 1)):
        page.keyboard.press(key)
        bad += at_page(f"{tag} key {key}", state(page), expected)
    s = state(page, 0)
    bad += not check(f"{tag}: previous disabled at page 1, focus moved to next", s["prev"]["disabled"] and s["focusId"] == "doc-page-next", s)
    page.keyboard.press("End")
    s = state(page)
    bad += not check(f"{tag}: next disabled at the last page", s["next"]["disabled"] and not s["prev"]["disabled"], s)
    page.keyboard.press("Home")
    state(page)

    # Scrolling moves the indicator to the page that fills most of the view.
    page.evaluate("""() => {
      const stage = document.getElementById('doc-stage');
      const wrap = stage.querySelector('.doc-page-wrap[data-page="5"]');
      stage.scrollTop += wrap.getBoundingClientRect().top - stage.getBoundingClientRect().top + 20;
    }""")
    s = state(page, 900)
    bad += not check(f"{tag}: indicator follows scroll to page 5", s["input"] == "5" and s["visiblePage"] == 5, s)
    bad += not check(f"{tag}: scroll change announced", s["status"] == f"Page 5 of {PAGES}", s["status"])

    # Zoom is kept when changing page.
    page.evaluate("() => document.getElementById('doc-zoom-in').click()")
    page.wait_for_timeout(600)
    before = state(page)["scale"]
    page.click("#doc-page-next")
    s = state(page)
    bad += not check(f"{tag}: zoom level kept after next page", before > 1.2 and abs(s["scale"] - before) < 0.01, (before, s["scale"]))
    bad += at_page(f"{tag} zoomed next", s, 6)
    page.evaluate("() => document.getElementById('doc-zoom-reset').click()")
    page.wait_for_timeout(600)

    if mobile:
        cdp = ctx.new_cdp_session(page)
        page.click("#doc-page-input")
        page.fill("#doc-page-input", "3")
        page.press("#doc-page-input", "Enter")
        state(page)
        mid_y = height // 2
        swipe(page, cdp, width - 60, mid_y, 60, mid_y + 10)
        bad += not check(f"{tag}: swipe left goes to the next page", state(page)["input"] == "4")
        swipe(page, cdp, 60, mid_y, width - 60, mid_y - 10)
        bad += not check(f"{tag}: swipe right goes to the previous page", state(page)["input"] == "3")
        before = state(page, 0)["scrollTop"]
        swipe(page, cdp, width // 2, height - 150, width // 2 + 5, 150, steps=20)
        s = state(page, 900)
        bad += not check(f"{tag}: vertical touch scroll still scrolls", s["scrollTop"] > before + 300, (before, s["scrollTop"]))
        bad += not check(f"{tag}: indicator follows the touch scroll", s["input"] == str(s["visiblePage"]) and s["visiblePage"] > 3, s)
        page_before_pinch = s["input"]
        pinch_out(page, cdp, width // 2, mid_y)
        s = state(page, 600)
        bad += not check(f"{tag}: pinch-zoom still zooms in", s["scale"] > 1.2, s["scale"])
        swipe(page, cdp, width - 60, mid_y, 60, mid_y + 10)
        s = state(page)
        bad += not check(f"{tag}: swipe does not turn the page while zoomed", s["input"] == page_before_pinch, s)
        page.evaluate("() => document.getElementById('doc-zoom-reset').click()")
        page.wait_for_timeout(600)

    # Reopen in the same session: back at the last page.
    page.fill("#doc-page-input", "9")
    page.press("#doc-page-input", "Enter")
    state(page)
    close_viewer(page)
    bad += not check(f"{tag}: controls hidden after close", page.evaluate("() => document.getElementById('doc-page-nav').hidden"))
    open_viewer(page, "Doc pages")
    s = state(page, 600)
    bad += not check(f"{tag}: reopening returns to page 9", s["input"] == "9" and s["visiblePage"] == 9, s)
    writes = page.evaluate("() => window.__storageWrites")
    leaked = [w for w in writes if att_id in w[0] or att_id in w[1] or "page" in w[0].lower()]
    bad += not check(f"{tag}: no storage write about the page position", not leaked, leaked)
    close_viewer(page)

    # A one-page document and an image show no page controls.
    open_viewer(page, "Doc single")
    s = state(page)
    bad += not check(f"{tag}: single-page PDF shows no page controls", s["pages"] == 1 and s["navHidden"], s)
    close_viewer(page)
    open_list_note(page, "Doc image")
    page.wait_for_selector(f'[data-preview="{img_id}"]', state="attached", timeout=30000)
    page.evaluate("(id) => document.querySelector(`[data-preview=\"${id}\"]`).click()", img_id)
    wait_viewer_media(page, "#doc-viewer:not([hidden]) #doc-stage img")
    s = state(page)
    bad += not check(f"{tag}: image shows no page controls", s["navHidden"], s)
    close_viewer(page)

    # Locking forgets the position (memory only) and closes the viewer.
    open_viewer(page, "Doc pages")
    page.locator("#btn-lock-head:visible, #btn-lock-nav:visible, #btn-lock-now").first.evaluate("(el) => el.click()")
    page.wait_for_selector("#unlock-form", state="visible", timeout=20000)
    bad += not check(f"{tag}: lock closes the viewer", page.evaluate("() => document.getElementById('doc-viewer').hidden"))
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function("() => document.body.classList.contains('unlocked')", timeout=60000)
    page.evaluate(DISMISS_JS)
    open_viewer(page, "Doc pages")
    s = state(page, 600)
    bad += not check(f"{tag}: after lock the document opens at page 1", s["input"] == "1" and s["visiblePage"] == 1, s)
    browser.close()
    return bad


def run() -> int:
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            bad += run_viewport(p, base, 390, 800, True)
            bad += run_viewport(p, base, 1280, 860, False)
    finally:
        stop_server(proc)
    print("FAILURES:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run())
