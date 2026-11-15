"""E2E: inline PDF viewer fits width, is centred on a neutral background, zoom
and full screen work, on desktop and mobile. Synthetic PDF, throwaway account.

    python tests/e2e_doc_inline_viewer.py [screenshot_dir]
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_layout_actions import (  # noqa: E402
    DISMISS_JS, SEED_JS, make_pdf, open_note, register, run_server, stop_server,
)

MEASURE_JS = """() => {
  const q = (s) => document.querySelector(s);
  const host = q('#doc-inline'), card = q('.doc-inline-card'), stage = q('.doc-inline-stage');
  const wrap = stage && stage.querySelector('.doc-page-wrap');
  if (!wrap) return null;
  const r = (e) => e.getBoundingClientRect().toJSON();
  const bg = (e) => getComputedStyle(e).backgroundColor;
  return { host: r(host), card: r(card), stage: r(stage), wrap: r(wrap),
    borderLeft: getComputedStyle(wrap).borderLeftWidth,
    hostBg: bg(host), cardBg: bg(card), mainBg: bg(q('.doc-inline-main')), stageBg: bg(stage),
    docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
    zoom: card.dataset.zoom, page: (q('.doc-inline-page') || {}).textContent };
}"""

REACH_JS = """() => {
  const els = [document.getElementById('doc-inline'), document.querySelector('.doc-inline-main'),
    document.querySelector('.doc-inline-card')];
  const sc = els.find((e) => e.scrollWidth > e.clientWidth + 2);
  const wrap = () => document.querySelector('.doc-page-wrap').getBoundingClientRect();
  if (!sc) return { scroller: false, vw: innerWidth, left: wrap().left, right: wrap().right };
  sc.scrollLeft = 0; const a = wrap().left;
  sc.scrollLeft = sc.scrollWidth; const b = wrap().right;
  sc.scrollLeft = 0;
  return { scroller: true, a, b, vw: innerWidth };
}"""

SWITCH_JS = """() => {
  const n = [...document.querySelectorAll('.note-item')].find((e) => !/Layout PDF/.test(e.textContent));
  if (n) n.click();
}"""


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name, "" if cond else detail)
    return bool(cond)


def run(shots: Path) -> int:
    from playwright.sync_api import sync_playwright

    proc, base = run_server()
    bad = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for label, vp, mobile in (("desktop", (1440, 900), False), ("mobile", (390, 800), True)):
                ctx = browser.new_context(viewport={"width": vp[0], "height": vp[1]}, has_touch=mobile, is_mobile=mobile)
                page = ctx.new_page()
                register(page, base)
                page.evaluate(DISMISS_JS)
                page.evaluate(SEED_JS, base64.b64encode(make_pdf()).decode("ascii"))
                open_note(page, "Layout PDF note")
                page.wait_for_selector(".doc-inline-stage .doc-page-wrap", timeout=30000)
                page.wait_for_timeout(800)
                m = page.evaluate(MEASURE_JS)
                page.screenshot(path=str(shots / f"{label}.png"))
                bad += not check(f"{label}: page not wider than container", m["wrap"]["width"] <= m["host"]["width"] + 1.5, m)
                bad += not check(f"{label}: page fills the width (fit width)", m["wrap"]["width"] >= min(m["host"]["width"], 700) - 2, m)
                lc = m["wrap"]["left"] - m["host"]["left"]
                rc = m["host"]["right"] - m["wrap"]["right"]
                bad += not check(f"{label}: page centred", abs(lc - rc) <= 14, (lc, rc))
                bad += not check(f"{label}: no hard left border", m["borderLeft"] == "0px", m["borderLeft"])
                bad += not check(f"{label}: no horizontal overflow", m["docScrollW"] <= m["docClientW"] + 1, m)
                clear = "rgba(0, 0, 0, 0)"
                bad += not check(f"{label}: neutral token background behind page", m["mainBg"] != clear, m)
                bad += not check(f"{label}: page indicator", (m["page"] or "").strip() == "1 / 1", m["page"])
                page.click(".doc-ctl-zoom-in")
                page.wait_for_timeout(200)
                z = page.evaluate(MEASURE_JS)
                bad += not check(f"{label}: zoom in widens page", z["zoom"] == "1.25" and z["wrap"]["width"] > m["wrap"]["width"] * 1.1, z)
                page.click(".doc-ctl-zoom-in")
                page.click(".doc-ctl-zoom-in")
                page.wait_for_timeout(200)
                page.screenshot(path=str(shots / f"{label}-zoomed.png"))
                opened = page.evaluate("() => { const v = document.getElementById('doc-viewer'); return !!v && !v.hidden; }")
                bad += not check(f"{label}: toolbar click does not open the full viewer", not opened)
                reach = page.evaluate(REACH_JS)
                bad += not check(f"{label}: zoomed page reachable by scrolling, nothing cut off", reach.get("scroller") and reach["a"] >= -1 and reach["b"] <= reach["vw"] + 1, reach)
                page.click(".doc-ctl-fit")
                page.wait_for_timeout(200)
                open_live = page.evaluate("() => NotesBlobUrls.count()")
                # pdf.js gets bytes; the only URL is the note-list thumbnail of page 1.
                bad += not check(f"{label}: at most the list thumbnail URL is live while open", open_live <= 1, open_live)
                f =page.evaluate(MEASURE_JS)
                bad += not check(f"{label}: fit width resets", f["zoom"] == "1" and abs(f["wrap"]["width"] - m["wrap"]["width"]) < 2, f)
                if not mobile:
                    page.click(".doc-ctl-fullscreen")
                    page.wait_for_timeout(500)
                    is_fs = page.evaluate("() => !!(document.fullscreenElement && document.fullscreenElement.classList.contains('doc-inline-card'))")
                    page.screenshot(path=str(shots / f"{label}-fullscreen.png"))
                    bad += not check(f"{label}: fullscreen opens", is_fs)
                    page.click(".doc-ctl-fullscreen")
                    page.wait_for_timeout(400)
                    bad += not check(f"{label}: fullscreen closes", page.evaluate("() => !document.fullscreenElement"))
                page.click("#app-tab-notes")
                page.evaluate(SWITCH_JS)
                page.wait_for_timeout(800)
                live = page.evaluate("() => typeof NotesBlobUrls === 'undefined' ? -1 : NotesBlobUrls.count()")
                bad += not check(f"{label}: no live blob URLs after the viewer closes/switches", live == 0, live)
                ctx.close()
            browser.close()
    finally:
        stop_server(proc)
    return 1 if bad else 0


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots")
    out.mkdir(parents=True, exist_ok=True)
    sys.exit(run(out))
