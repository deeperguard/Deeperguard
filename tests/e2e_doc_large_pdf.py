"""E2E: large PDFs open page by page in the full preview and do not exhaust memory.

Generates PDFs in the test (20, 150 and 400 pages, plus one with tall pages and
a large image), opens each in the full preview at phone width and records how
many page canvases are alive, their pixel size and the JS heap. The 400 page
document is then scrolled to its last page, zoomed to every level and closed;
locking the vault and signing out are checked as well. Synthetic data, throwaway
account.

    python tests/e2e_doc_large_pdf.py
"""
from __future__ import annotations

import base64
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_layout_actions import (  # noqa: E402
    DISMISS_JS, phone_back_to_list, register, run_server, stop_server,
)
from e2e_signup_autounlock import PASSWORD  # noqa: E402

MAX_LIVE_CANVASES = 6  # five page canvases plus one zoom tile
ZOOM_PIXEL_BUDGET = 16_000_000
BASE_PIXEL_BUDGET = 9_000_000


def pdf_bytes(pages: int, width: int = 595, height: int = 842, image: int = 0) -> bytes:
    """A PDF with `pages` pages of text; image > 0 adds an image x image grey XObject."""
    objects: list[bytes] = [b"", b""]  # catalog, pages: filled below
    kids = []
    font = 3
    objects.append(b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>")
    img_ref = ""
    if image:
        raw = zlib.compress(bytes((x * 7 + y * 3) % 256 for y in range(image) for x in range(image)))
        objects.append(
            f"<</Type /XObject /Subtype /Image /Width {image} /Height {image} /ColorSpace /DeviceGray "
            f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(raw)}>>\nstream\n".encode() + raw + b"\nendstream"
        )
        img_ref = f"/XObject <</Im1 {len(objects)} 0 R>>"
    for n in range(1, pages + 1):
        draw = f"q {width - 40} 0 0 {width - 40} 20 100 cm /Im1 Do Q " if image else ""
        stream = f"{draw}BT /F1 40 Tf 1 0 0 1 40 {height - 80} Tm (Page {n} of {pages}) Tj ET".encode("latin-1")
        objects.append(b"<</Length " + str(len(stream)).encode() + b">>\nstream\n" + stream + b"\nendstream")
        content = len(objects)
        objects.append(
            f"<</Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
            f"/Resources <</Font <</F1 {font} 0 R>> {img_ref}>> /Contents {content} 0 R>>".encode()
        )
        kids.append(f"{len(objects)} 0 R")
    objects[0] = b"<</Type /Catalog /Pages 2 0 R>>"
    objects[1] = f"<</Type /Pages /Kids [{' '.join(kids)}] /Count {pages}>>".encode()
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objects) + 1} /Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


# Records every pdf.js worker, and samples the page canvases on screen every frame, so
# "alive" is measured. Page canvases live in the full preview (#doc-stage) and in the
# inline preview behind it (.doc-inline-stage).
INIT_JS = """() => {
  window.__workers = [];
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      this.__terminated = false;
      window.__workers.push(this);
    }
    terminate() { this.__terminated = true; return super.terminate(); }
  };
  window.__pageCanvases = (root) => [...document.querySelectorAll(root + ' canvas')].filter((c) => c.width * c.height > 0);
  window.__peak = { count: 0, inline: 0, pixels: 0, max: 0 };
  const tick = () => {
    const full = window.__pageCanvases('#doc-stage');
    const inline = window.__pageCanvases('.doc-inline-stage');
    const p = window.__peak;
    p.count = Math.max(p.count, full.length);
    p.inline = Math.max(p.inline, inline.length);
    p.pixels = Math.max(p.pixels, full.concat(inline).reduce((a, c) => a + c.width * c.height, 0));
    p.max = Math.max(p.max, ...full.concat(inline).map((c) => c.width * c.height));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}"""

SEED_JS = """async ([title, b64]) => {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, content: '', attachments: [] });
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  const file = new File([bytes], 'big.pdf', { type: 'application/pdf' });
  const attId = await NotesStore.addAttachment(id, file, { displayName: 'big.pdf' });
  NotesStore.setAttachmentOcr(attId, 'page text', 'client', []);
  NotesStore.refreshNoteSearchText(id);
  return attId;
}"""

STATE_JS = """async () => {
  if (window.gc) window.gc();
  const live = window.__pageCanvases('#doc-stage').concat(window.__pageCanvases('.doc-inline-stage'));
  const stage = document.getElementById('doc-stage');
  return {
    pages: stage.querySelectorAll('.doc-page-wrap').length,
    stageCanvases: stage.querySelectorAll('canvas').length,
    alive: live.length,
    maxPixels: live.reduce((a, c) => Math.max(a, c.width * c.height), 0),
    totalPixels: live.reduce((a, c) => a + c.width * c.height, 0),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    workers: window.__workers.filter((w) => !w.__terminated).length,
    pdfHosts: (NotesPreview.livePdfHosts ? NotesPreview.livePdfHosts() : []).map((h) => h.id || h.className),
    urls: NotesBlobUrls.count(),
    peak: { ...window.__peak },
  };
}"""

# Opens the full preview by double-clicking the inline stage (the app's own gesture).
OPEN_VIEWER_JS = """() => {
  const stage = document.querySelector('.doc-inline-stage');
  stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}"""

SCROLL_JS = """(frac) => {
  const stage = document.getElementById('doc-stage');
  const host = stage.closest('.doc-zoom-host') || stage;
  host.scrollTop = (host.scrollHeight - host.clientHeight) * frac;
  return host.scrollTop;
}"""

LAST_PAGE_JS = """(n) => {
  const stage = document.getElementById('doc-stage');
  const host = stage.closest('.doc-zoom-host') || stage;
  const wrap = stage.querySelector(`.doc-page-wrap[data-page="${n}"]`);
  const canvas = wrap && wrap.querySelector('canvas.doc-page');
  const r = wrap && wrap.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return { has: !!canvas && canvas.width > 0, visible: !!r && r.bottom > h.top && r.top < h.bottom };
}"""

# A canvas that was not painted stays black (the page canvases are opaque); a page is white.
PAINTED_JS = """() => {
  const host = document.getElementById('doc-stage').closest('.doc-zoom-host') || document.getElementById('doc-stage');
  const h = host.getBoundingClientRect();
  const wraps = [...document.querySelectorAll('#doc-stage .doc-page-wrap')].filter((w) => {
    const r = w.getBoundingClientRect();
    return r.bottom > h.top + 20 && r.top < h.bottom - 20 && w.querySelector('canvas.doc-page');
  });
  if (!wraps.length) return { pages: 0, painted: false };
  const canvas = wraps[0].querySelector('canvas.doc-page');
  const ctx = canvas.getContext('2d');
  const w = Math.min(256, canvas.width), hh = Math.min(256, canvas.height);
  const data = ctx.getImageData(Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - hh) / 2), w, hh).data;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  return { pages: wraps.length, painted: [...seen].some((c) => c !== 0) };
}"""


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name, "" if cond else detail)
    return bool(cond)


def open_list_note(page, title):
    # Notes seeded straight into the store show up at the next list redraw.
    phone_back_to_list(page)
    page.click("#app-tab-notes", timeout=10000)
    page.fill("#search", "Doc")
    page.wait_for_timeout(500)
    page.fill("#search", "")
    page.wait_for_timeout(500)
    page.locator(".note-item", has_text=title).first.click(timeout=10000, position={"x": 30, "y": 14})
    page.wait_for_function("(t) => document.getElementById('note-title')?.value === t", arg=title, timeout=10000)


def open_viewer(page, title):
    open_list_note(page, title)
    page.wait_for_selector(".doc-inline-stage .doc-page-wrap", timeout=60000)
    page.wait_for_timeout(500)
    page.evaluate(OPEN_VIEWER_JS)
    page.wait_for_function("() => { const v = document.getElementById('doc-viewer'); return v && !v.hidden; }", timeout=20000)
    page.wait_for_function(
        "() => document.querySelectorAll('#doc-stage .doc-page-wrap').length > 0", timeout=120000
    )
    # Settle: the number of canvases stops changing.
    last, stable = -1, 0
    for _ in range(60):
        page.wait_for_timeout(400)
        now = page.evaluate("() => document.querySelectorAll('#doc-stage canvas').length")
        stable = stable + 1 if now == last else 0
        last = now
        if stable >= 3 and now > 0:
            break


def close_viewer(page):
    # On a phone the full preview hides its header; the floating button closes it.
    page.evaluate(
        """() => {
          const floating = document.getElementById('doc-immersive-close');
          (floating && !floating.hidden ? floating : document.getElementById('doc-close')).click();
        }"""
    )
    page.wait_for_timeout(500)


def run() -> int:
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True, args=["--enable-precise-memory-info", "--js-flags=--expose-gc"]
            )
            ctx = browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
            page = ctx.new_page()
            page.add_init_script(f"({INIT_JS})()")
            register(page, base)
            page.evaluate(DISMISS_JS)

            docs = [
                ("Doc 20", pdf_bytes(20)),
                ("Doc 150", pdf_bytes(150)),
                ("Doc 400", pdf_bytes(400)),
            ]
            for title, data in docs:
                page.evaluate(SEED_JS, [title, base64.b64encode(data).decode("ascii")])
            page.evaluate("() => { document.getElementById('app-tab-notes')?.click(); }")

            for title, data in docs:
                before = page.evaluate("() => NotesBlobUrls.count()")
                open_viewer(page, title)
                m = page.evaluate(STATE_JS)
                print(f"MEASURE {title} ({len(data) // 1024} KB) open: pages={m['pages']} canvases={m['stageCanvases']} "
                      f"alive={m['alive']} maxPx={m['maxPixels']} totalPx={m['totalPixels']} heapMB={m['heapMB']} peak={m['peak']}")
                if title != "Doc 400":
                    page.evaluate(SCROLL_JS, 1)
                    page.wait_for_timeout(1500)
                    m2 = page.evaluate(STATE_JS)
                    print(f"MEASURE {title} at end: canvases={m2['stageCanvases']} alive={m2['alive']} "
                          f"totalPx={m2['totalPixels']} heapMB={m2['heapMB']} peak={m2['peak']}")
                    close_viewer(page)
                    continue

                n = 400
                bad += not check("400 pages: every page is in the document (placeholders)", m["pages"] == n, m["pages"])
                for frac in (0.1, 0.33, 0.5, 0.8, 1):
                    page.evaluate(SCROLL_JS, frac)
                    page.wait_for_timeout(500)
                page.wait_for_timeout(1500)
                last = page.evaluate(LAST_PAGE_JS, n)
                bad += not check("400 pages: last page is drawn and in view after scrolling", last["has"] and last["visible"], last)
                m2 = page.evaluate(STATE_JS)
                print(f"MEASURE {title} at end: canvases={m2['stageCanvases']} alive={m2['alive']} "
                      f"totalPx={m2['totalPixels']} heapMB={m2['heapMB']} peak={m2['peak']}")
                bad += not check(f"400 pages: at most {MAX_LIVE_CANVASES} page canvases alive at any time",
                                 m2["peak"]["count"] <= MAX_LIVE_CANVASES and m2["peak"]["inline"] <= MAX_LIVE_CANVASES, m2["peak"])
                bad += not check("400 pages: no canvas over the base pixel budget", m2["peak"]["max"] <= BASE_PIXEL_BUDGET, m2["peak"])
                page.evaluate(SCROLL_JS, 0)
                page.wait_for_timeout(1000)
                first = page.evaluate(LAST_PAGE_JS, 1)
                bad += not check("400 pages: scrolling back draws page 1 again", first["has"] and first["visible"], first)

                # Closing the viewer frees its document; the inline preview behind it stays.
                close_viewer(page)
                c = page.evaluate(STATE_JS)
                bad += not check("close: no canvas left in the viewer", c["stageCanvases"] == 0, c)
                bad += not check("close: viewer document destroyed", "doc-stage" not in c["pdfHosts"], c["pdfHosts"])
                bad += not check("close: no object URL left behind", c["urls"] <= before, (c["urls"], before))

                # Reopen, then lock the vault with the viewer open.
                open_viewer(page, title)
                o = page.evaluate(STATE_JS)
                bad += not check("reopen: document is live again", "doc-stage" in o["pdfHosts"], o["pdfHosts"])
                page.locator("#btn-lock-head:visible, #btn-lock-nav:visible, #btn-lock-now").first.evaluate("(el) => el.click()")
                page.wait_for_selector("#unlock-form", state="visible", timeout=20000)
                page.wait_for_timeout(500)
                k = page.evaluate(STATE_JS)
                bad += not check("lock: no page canvas alive in either preview", k["alive"] == 0, k)
                bad += not check("lock: no pdf.js document left", k["pdfHosts"] == [], k["pdfHosts"])
                bad += not check("lock: no object URL left", k["urls"] == 0, k["urls"])
                bad += not check("lock: no pdf.js worker running", k["workers"] == 0, k["workers"])

                # Unlock again, open the viewer and sign out (the logout request is held back
                # so the state can be read before the page navigates away).
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
                page.wait_for_function("() => document.body.classList.contains('unlocked')", timeout=60000)
                page.evaluate(DISMISS_JS)
                open_viewer(page, title)
                snap = {}

                def on_logout(route):
                    snap.update(page.evaluate(STATE_JS))
                    route.abort()

                page.route("**/api/auth/logout", on_logout)
                page.evaluate("() => document.getElementById('btn-logout').click()")
                page.wait_for_timeout(500)
                confirm = page.locator("button", has_text="Sign out").last
                if confirm.is_visible():
                    confirm.click()
                for _ in range(40):
                    if snap:
                        break
                    page.wait_for_timeout(250)
                bad += not check("sign-out: logout request was reached", bool(snap), snap)
                if snap:
                    bad += not check("sign-out: no page canvas alive in either preview", snap["alive"] == 0, snap)
                    bad += not check("sign-out: no pdf.js document left", snap["pdfHosts"] == [], snap["pdfHosts"])
                    bad += not check("sign-out: no object URL left", snap["urls"] == 0, snap["urls"])

            browser.close()
    finally:
        stop_server(proc)
    return 1 if bad else 0


def run_zoom() -> int:
    """Zooming a tall large-image page lowers the render scale instead of blanking it."""
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
            page = ctx.new_page()
            page.add_init_script(f"({INIT_JS})()")
            register(page, base)
            page.evaluate(DISMISS_JS)
            for title, data in (("Doc big image", pdf_bytes(6, 595, 4000, image=1600)), ("Doc 20", pdf_bytes(20))):
                page.evaluate(SEED_JS, [title, base64.b64encode(data).decode("ascii")])
                open_viewer(page, title)
                levels = []
                for _ in range(10):
                    page.evaluate("() => document.getElementById('doc-zoom-in').click()")
                    page.wait_for_timeout(1800)
                    state = page.evaluate(STATE_JS)
                    painted = page.evaluate(PAINTED_JS)
                    label = page.evaluate("() => document.getElementById('doc-zoom-reset').textContent.trim()")
                    levels.append((label, state["peak"]["max"], painted))
                    if label == (levels[-2][0] if len(levels) > 1 else None):
                        break
                final = page.evaluate(STATE_JS)
                print(f"MEASURE {title} zoom levels (label, peak max px, painted): {levels}")
                bad += not check(f"{title}: zoom ladder reached more than one level", len({lv[0] for lv in levels}) > 3, levels)
                bad += not check(f"{title}: no canvas over {ZOOM_PIXEL_BUDGET} pixels at any zoom", final["peak"]["max"] <= ZOOM_PIXEL_BUDGET, final["peak"])
                bad += not check(f"{title}: zoomed page is not blank at any level", all(lv[2]["painted"] for lv in levels), levels)
                bad += not check(f"{title}: few canvases at max zoom", final["peak"]["count"] <= MAX_LIVE_CANVASES, final["peak"])
                close_viewer(page)
            browser.close()
    finally:
        stop_server(proc)
    return 1 if bad else 0


def run_too_large() -> int:
    """A document over the safe limit shows a message and a download button."""
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True,
                                      accept_downloads=True)
            page = ctx.new_page()
            register(page, base)
            page.evaluate(DISMISS_JS)
            limit = page.evaluate("() => NotesPreview.MAX_PDF_VIEW_PAGES")
            data = pdf_bytes(limit + 1, 100, 100)
            title = "Doc too many pages"
            page.evaluate(SEED_JS, [title, base64.b64encode(data).decode("ascii")])
            open_list_note(page, title)
            page.wait_for_selector(".doc-inline-stage .doc-too-large", timeout=120000)
            page.evaluate(OPEN_VIEWER_JS)
            page.wait_for_selector("#doc-stage .doc-too-large", timeout=60000)
            text = page.inner_text("#doc-stage .doc-too-large")
            bad += not check("too large: clear message", f"{limit + 1} pages" in text and "too many" in text, text)
            bad += not check("too large: no canvas, no pdf.js document",
                             page.evaluate("() => NotesPreview.livePdfHosts().length") == 0
                             and page.locator("#doc-stage canvas").count() == 0)
            with page.expect_download(timeout=30000) as dl:
                page.click("#doc-stage .doc-too-large button")
            bad += not check("too large: download button saves the file", dl.value.suggested_filename == "big.pdf",
                             dl.value.suggested_filename)
            browser.close()
    finally:
        stop_server(proc)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run() | run_zoom() | run_too_large())
