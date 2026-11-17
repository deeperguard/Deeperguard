"""E2E: no horizontal page scroll on Notes (plain, PDF), Agenda and 2FA.

For every screen and every width in WIDTHS, document.documentElement and
document.body must not be wider than the window. On failure the elements that
stick out past the viewport are listed. 390 runs at 390x844 (phone).

html and body are overflow:hidden (app shell) and the compact layout clips
.app-root horizontally, so a scrollWidth check alone would miss content cut
off by such a container. Shown content that runs past the window's right edge
and is cut off by an overflow hidden/clip ancestor (not a scroll area the user
can scroll) therefore fails the check as well.

    python tests/e2e_layout_no_hscroll.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright  # noqa: E402

import e2e_layout_actions as base  # noqa: E402

WIDTHS = (1280, 1440, 1920, 820, 390)
HEIGHT = 900
PHONE_HEIGHT = 844  # 390x844, the phone viewport of the screenshot suite

MEASURE_JS = """() => {
  const vw = window.innerWidth;
  const root = document.documentElement.scrollWidth;
  const body = document.body.scrollWidth;
  const out = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    // Content (text, inline boxes) that overflows a visible-overflow box is not
    // in the box rect; its reach is left + scrollWidth. Only the overflow not
    // already explained by a child element that runs past the window is counted.
    let right = r.right;
    if (cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 0.5
        && ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 0.5)) {
      right = Math.max(right, r.left + el.scrollWidth);
    }
    if (right <= vw + 0.5) return;
    if (cs.visibility === 'hidden' || cs.position === 'fixed') return;
    if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return;
    let clippedBy = '';
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (o.overflowX === 'visible' || p.getBoundingClientRect().right > vw + 0.5) continue;
      if (o.overflowX === 'auto' || o.overflowX === 'scroll') return;
      clippedBy = p.tagName.toLowerCase() + (p.id ? '#' + p.id : '');
      break;
    }
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    out.push(el.tagName.toLowerCase() + id + cls + ' right=' + Math.round(right)
      + (clippedBy ? ' clipped by ' + clippedBy : ''));
  });
  return { vw, root, body, offenders: out.slice(0, 15), count: out.length };
}"""


def screens(page):
    def notes(title):
        def go():
            base.escape_all(page)
            page.click("#app-tab-notes", timeout=10000)
            base.phone_back_to_list(page)
            base.open_note(page, title)
        return go

    def tab(selector):
        def go():
            base.escape_all(page)
            page.click(selector, timeout=10000)
            page.wait_for_timeout(500)
        return go

    return (
        ("notes plain note", notes(base.PLAIN_TITLE)),
        ("notes PDF note", notes(base.PDF_TITLE)),
        ("agenda", tab("#app-tab-agenda")),
        ("2fa", tab("#app-tab-2fa")),
    )


SELFTEST_HTML = (
    "<html><body style='margin:0'>"
    "<div style='width:300px'>" + "W" * 400 + "</div>"
    "</body></html>"
)


def selftest(pw) -> str | None:
    """The measurement must report text that overflows a box (no element box
    runs past the window). Returns an error message, or None when it does."""
    browser = pw.chromium.launch()
    try:
        page = browser.new_page(viewport={"width": 390, "height": PHONE_HEIGHT})
        page.set_content(SELFTEST_HTML)
        m = page.evaluate(MEASURE_JS)
    finally:
        browser.close()
    if m["root"] <= m["vw"]:
        return f"selftest: overflowing text did not widen the page ({m['root']} <= {m['vw']})"
    if m["count"] == 0:
        return "selftest: overflowing text was not listed as an offender"
    return None


def main() -> int:
    proc, url = base.run_server()
    failures = []
    checked = 0
    try:
        with sync_playwright() as pw:
            problem = selftest(pw)
            if problem:
                print("FAIL", problem, file=sys.stderr)
                return 1
            browser, page, _ids = base.boot(pw, url)
            base.seed_totp(page)
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": PHONE_HEIGHT if width < 700 else HEIGHT})
                page.wait_for_timeout(300)
                for name, go in screens(page):
                    go()
                    page.wait_for_timeout(400)
                    m = page.evaluate(MEASURE_JS)
                    checked += 1
                    if m["root"] > m["vw"] or m["body"] > m["vw"] or m["count"]:
                        failures.append(
                            f"{name} @ {width}: html {m['root']} body {m['body']} window {m['vw']}; "
                            f"sticking out: {m['offenders'] or 'no offender found'}"
                        )
            browser.close()
    finally:
        base.stop_server(proc)
    for line in failures:
        print("FAIL", line, file=sys.stderr)
    if failures:
        print(f"{len(failures)} of {checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {checked} screen/width checks without horizontal scroll")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
