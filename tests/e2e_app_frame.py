"""E2E: Notes, Agenda and 2FA share one app frame with one navigation level.

Desktop (1440, sidebar pinned so labels show): on every tab the left column has
the same x, width, background and border as the Notes sidebar, its actions are
icon + label rows inside that column, the tab bar is the only area switch and
exactly one tab carries aria-current="page" (it follows the active area).
Collapsed (not pinned): the rows show icons only and keep their accessible
names. Phone (390): the actions stay reachable outside any column.

    python tests/e2e_app_frame.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_layout_actions as base  # noqa: E402

COLUMN = {
    "notes": ".sidebar-nav",
    "agenda": ".agenda-side",
    "2fa": ".totp-side-foot",
}
ACTIONS = {
    "agenda": ["#agenda-calendar-settings-btn"],
    "2fa": ["#btn-totp-lock", "#btn-totp-settings"],
}

FRAME_JS = """([colSel, actionSels]) => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const col = document.querySelector(colSel);
  const r = col ? col.getBoundingClientRect() : null;
  const cs = col ? getComputedStyle(col) : null;
  const tabs = [...document.querySelectorAll('.app-tab')];
  const tabsRect = document.querySelector('.app-tabs').getBoundingClientRect();
  return {
    col: r && { x: Math.round(r.left), w: Math.round(r.width), top: Math.round(r.top), h: Math.round(r.height),
                bg: cs.backgroundColor, border: cs.borderRightWidth },
    tabsH: Math.round(tabsRect.height),
    current: tabs.filter((t) => t.getAttribute('aria-current') === 'page').map((t) => t.dataset.appTab),
    selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.appTab),
    // Area navigation outside the tab bar: a visible element whose name is an area name.
    extraNav: [...document.querySelectorAll('#filters [aria-current], #filters .filter')]
      .filter((e) => vis(e) && ['Agenda', '2FA'].includes((e.getAttribute('aria-label') || e.textContent).trim())).length,
    actions: actionSels.map((s) => {
      const el = document.querySelector(s);
      const b = el ? el.getBoundingClientRect() : null;
      const lab = el && el.querySelector('.side-label');
      return {
        sel: s, shown: vis(el), name: el ? (el.getAttribute('aria-label') || el.textContent).trim() : '',
        inside: !!(b && r && b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1),
        icon: !!el && [...el.querySelectorAll('svg, .side-glyph')].some(vis),
        label: !!lab && vis(lab) && lab.textContent.trim().length > 0,
      };
    }),
  };
}"""


def frame(page, tab: str) -> dict:
    page.click(f"#app-tab-{tab}", timeout=10000)
    page.wait_for_timeout(500)
    return page.evaluate(FRAME_JS, [COLUMN[tab], ACTIONS.get(tab, [])])


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
            page.evaluate("() => document.body.classList.add('nav-pinned')")
            page.wait_for_timeout(300)

            seen = {t: frame(page, t) for t in ("notes", "agenda", "2fa")}
            for tab, st in seen.items():
                report.check(f"{tab}: left column exists", bool(st["col"]), str(st))
                report.check(f"{tab}: exactly one tab has aria-current, the active one",
                             st["current"] == [tab] and st["selected"] == [tab], str(st))
                report.check(f"{tab}: no area switch inside the sidebar", st["extraNav"] == 0, str(st))
                for a in st["actions"]:
                    report.check(f"{tab} {a['sel']}: icon + label inside the column, named",
                                 a["shown"] and a["inside"] and a["icon"] and a["label"] and a["name"], str(a))
            shapes = {(s["col"]["x"], s["col"]["w"], s["col"]["bg"], s["col"]["border"], s["col"]["top"])
                      for s in seen.values() if s["col"]}
            report.check("same column x, width, background, border and top in all three areas",
                         len(shapes) == 1, str(shapes))
            report.check("same top bar height in all three areas",
                         len({s["tabsH"] for s in seen.values()}) == 1, str({t: s["tabsH"] for t, s in seen.items()}))

            # The action still works from the new place.
            frame(page, "agenda")
            page.click("#agenda-calendar-settings-btn")
            page.wait_for_timeout(300)
            opened = page.evaluate("() => !document.getElementById('agenda-calendar-settings').hidden")
            report.check("Calendar menu opens from the sidebar column", opened)
            page.click("#agenda-calendar-settings-close")
            page.wait_for_timeout(300)
            frame(page, "2fa")
            page.click("#btn-totp-add")
            page.wait_for_timeout(300)
            report.check("Add account opens from the sidebar column",
                         page.evaluate("() => !!document.getElementById('totp-add-issuer')?.getClientRects().length"))
            page.click("#totp-add-cancel")
            page.wait_for_timeout(300)

            # Collapsed: icons only, names stay.
            page.evaluate("() => document.body.classList.remove('nav-pinned')")
            page.wait_for_timeout(300)
            for tab in ("agenda", "2fa"):
                st = frame(page, tab)
                for a in st["actions"]:
                    report.check(f"collapsed {tab} {a['sel']}: icon only, still named",
                                 a["shown"] and a["inside"] and a["icon"] and not a["label"] and a["name"], str(a))
            browser.close()

            time.sleep(1.1)
            browser = pw.chromium.launch(headless=True)
            pg = browser.new_context(viewport={"width": 390, "height": 844}).new_page()
            base.register(pg, url)
            pg.evaluate(base.DISMISS_JS)
            for tab in ("agenda", "2fa"):
                pg.click(f"#app-tab-{tab}", timeout=10000)
                pg.wait_for_timeout(500)
                cur = pg.evaluate("() => [...document.querySelectorAll('.app-tab[aria-current]')].map((t) => t.dataset.appTab)")
                report.check(f"phone {tab}: aria-current follows the tab", cur == [tab], str(cur))
            pg.click("#app-tab-2fa")
            for sel in ACTIONS["2fa"]:
                shown = pg.evaluate("(s) => document.querySelector(s).getClientRects().length > 0", sel)
                report.check(f"phone 2fa {sel}: visible", shown)
            browser.close()
    finally:
        base.stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {report.checked} app frame checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
