"""E2E: the Notes sidebar is one visual style with one heading.

Desktop (1440): every sidebar entry (views, footer group) is icon + label with
the same row geometry, the active view carries aria-current, there is one
visible "Notes" heading and #btn-drawer-close is hidden. Tablet/phone: the
sidebar is an overlay drawer and #btn-drawer-close appears in its header.

    python tests/e2e_sidebar_unified.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_layout_actions as base  # noqa: E402

FOOT = ["#btn-secure-send-nav", "#btn-settings-nav", "#btn-lock-nav", "#btn-nav-pin", "#btn-account-info-nav"]

DESKTOP_JS = """(foot) => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rows = [...document.querySelectorAll('#filters .filter'), ...foot.map((s) => document.querySelector(s))];
  const info = rows.map((el) => {
    const cs = getComputedStyle(el);
    const label = el.querySelector('span');
    return {
      id: el.id || el.dataset.filter,
      icon: [...el.querySelectorAll('svg')].some(vis),
      label: !!label && vis(label) && label.textContent.trim().length > 0,
      border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, minH: cs.minHeight,
      x: Math.round(el.getBoundingClientRect().left), w: Math.round(el.getBoundingClientRect().width),
    };
  });
  // Every visible element carrying the text "Notes" outside the filter rows (headings,
  // brand <strong>, titles) counts; exactly one may exist and it must be a real heading.
  const titles = [...document.querySelectorAll('body *')].filter((e) => vis(e)
    && !e.closest('#filters') && !e.closest('[hidden]') && e.getAttribute('role') !== 'tab'
    && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'Notes'));
  const headings = titles.length;
  const nonHeading = titles.filter((e) => !/^H[1-6]$/.test(e.tagName) && e.getAttribute('role') !== 'heading').length;
  const current = [...document.querySelectorAll('#filters [aria-current]')].map((e) => e.dataset.filter);
  const close = document.getElementById('btn-drawer-close');
  return { info, headings, nonHeading, current, closeShown: vis(close) };
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    report = base.Report()
    proc, url = base.run_server()
    try:
        with sync_playwright() as pw:
            browser, page, _ids = base.boot(pw, url)
            # Pinned = labels visible (the unpinned rail shows icons only).
            page.evaluate("() => { document.body.classList.add('nav-pinned'); }")
            page.wait_for_timeout(400)
            data = page.evaluate(DESKTOP_JS, FOOT)
            for row in data["info"]:
                report.check(f"{row['id']}: icon and label", row["icon"] and row["label"], str(row))
            report.check("one row style (border/radius/min-height)",
                         len({(r["border"], r["radius"], r["minH"]) for r in data["info"]}) == 1,
                         str(data["info"]))
            report.check("rows share one left edge and width",
                         len({(r["x"], r["w"]) for r in data["info"]}) == 1, str(data["info"]))
            report.check("active view has aria-current", data["current"] == ["all"], str(data["current"]))
            report.check("one visible Notes title, and it is a real heading",
                         data["headings"] == 1 and data["nonHeading"] == 0, str(data))
            report.check("Close hidden on desktop", not data["closeShown"])
            page.click('.filter[data-filter="pinned"]')
            page.wait_for_timeout(200)
            cur = page.evaluate("() => [...document.querySelectorAll('#filters [aria-current]')].map((e) => e.dataset.filter)")
            report.check("aria-current follows the active view", cur == ["pinned"], str(cur))
            browser.close()

            time.sleep(1.1)
            for name, w, h in (("tablet", 820, 1100), ("phone", 390, 844)):
                browser = pw.chromium.launch(headless=True)
                pg = browser.new_context(viewport={"width": w, "height": h}).new_page()
                base.register(pg, url)
                pg.evaluate(base.DISMISS_JS)
                pg.wait_for_timeout(400)
                hidden_closed = pg.evaluate("() => { const b = document.getElementById('btn-drawer-close'); return !!b && b.getClientRects().length === 0; }")
                pg.evaluate("() => { const b = document.getElementById('btn-list-menu'); if (b) b.click(); }")
                pg.wait_for_timeout(500)
                opened = pg.evaluate("() => document.body.classList.contains('nav-drawer-open')")
                report.check(f"{name}: drawer opens", opened)
                report.check(f"{name}: Close hidden while the drawer is closed", hidden_closed)
                # Close shows exactly when the drawer covers the opener (app.js drawer-over-menu).
                shown = pg.evaluate("() => { const b = document.getElementById('btn-drawer-close'); return !!b && b.getClientRects().length > 0; }")
                over = pg.evaluate("() => document.body.classList.contains('drawer-over-menu')")
                report.check(f"{name}: Close visible iff drawer covers the menu button", shown == over, f"shown={shown} over={over}")
                inside = pg.evaluate("() => !!document.getElementById('btn-drawer-close')?.closest('.sidebar-scroll-head')")
                report.check(f"{name}: Close sits in the sidebar header", inside)
                if shown:
                    pg.click("#btn-drawer-close")
                    pg.wait_for_timeout(300)
                    closed = pg.evaluate("() => !document.body.classList.contains('nav-drawer-open')")
                    report.check(f"{name}: Close closes the drawer", closed)
                browser.close()
                time.sleep(1.1)
    finally:
        base.stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {report.checked} sidebar checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
