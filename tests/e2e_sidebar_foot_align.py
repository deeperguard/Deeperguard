"""E2E: the bottom block of the Notes sidebar lines up with the views above it.

At 1280px with the sidebar expanded (light and dark) the icons of the views and
of the footer items (Secure Send, Settings, Lock, toggle, Account info, Sync)
share one left edge and all labels share one left edge. Collapsed, the footer
icons are centered in the rail. The toggle's name says what it will do.

    python tests/e2e_sidebar_foot_align.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_layout_actions as base  # noqa: E402

FOOT = ["#btn-secure-send-nav", "#btn-settings-nav", "#btn-lock-nav", "#btn-nav-pin",
        "#btn-account-info-nav"]

MEASURE_JS = """(foot) => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rows = [...document.querySelectorAll('#filters .filter'), ...foot.map((s) => document.querySelector(s))];
  const items = rows.map((el) => {
    const svg = [...el.querySelectorAll('svg')].find(vis);
    const label = [...el.querySelectorAll('span')].find((s) => vis(s) && s.textContent.trim());
    const r = el.getBoundingClientRect();
    return {
      id: el.id || el.dataset.filter,
      icon: svg ? svg.getBoundingClientRect().left : null,
      iconCx: svg ? svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2 : null,
      label: label ? label.getBoundingClientRect().left : null,
      align: getComputedStyle(label || el).textAlign,
      h: r.height, left: r.left, cx: r.left + r.width / 2,
    };
  });
  // The Sync button draws its icon as ::before; the text node follows it. Measure with a Range.
  const s = document.getElementById('btn-sync-now');
  const sr = s.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(s);
  const textLeft = range.getBoundingClientRect().left;
  const pad = parseFloat(getComputedStyle(s).paddingLeft);
  const rail = document.querySelector('.sidebar-foot').getBoundingClientRect();
  const t = document.getElementById('btn-nav-pin');
  return { items, sync: { left: sr.left + pad, text: textLeft, h: sr.height,
    syncAlign: getComputedStyle(s).textAlign, justify: getComputedStyle(s).justifyContent },
    railCx: rail.left + rail.width / 2, toggleName: t.getAttribute('aria-label'),
    toggleTitle: t.title, toggleText: t.textContent.trim() };
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    report = base.Report()
    proc, url = base.run_server()
    try:
        with sync_playwright() as pw:
            browser, page, _ids = base.boot(pw, url)
            page.evaluate("() => localStorage.removeItem('deeperguard-prefs')")
            for theme in ("light", "dark"):
                page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)
                if page.evaluate("() => document.body.classList.contains('nav-pinned')"):
                    page.click("#btn-nav-pin")
                    page.evaluate("() => document.activeElement && document.activeElement.blur()")
                    page.mouse.move(900, 500)
                    page.wait_for_timeout(300)
                collapsed = page.evaluate(MEASURE_JS, FOOT)
                report.check(f"{theme}: collapsed toggle says Expand sidebar",
                             collapsed["toggleName"] == "Expand sidebar"
                             and collapsed["toggleTitle"] == "Expand sidebar", str(collapsed))
                for it in collapsed["items"][-len(FOOT):]:
                    report.check(f"{theme}: collapsed {it['id']} icon centered in the rail",
                                 it["iconCx"] is not None and abs(it["iconCx"] - collapsed["railCx"]) <= 1.5,
                                 f"{it} rail={collapsed['railCx']}")

                page.click("#btn-nav-pin")
                page.mouse.move(900, 500)
                page.wait_for_timeout(400)
                d = page.evaluate(MEASURE_JS, FOOT)
                items = d["items"]
                icons = [i["icon"] for i in items]
                labels = [i["label"] for i in items] + [d["sync"]["text"]]
                report.check(f"{theme}: every row has icon and label",
                             all(v is not None for v in icons + labels), str(items))
                report.check(f"{theme}: icons share one left edge (views + footer)",
                             max(icons) - min(icons) <= 1, str(icons))
                report.check(f"{theme}: labels share one left edge (views + footer + Sync)",
                             max(labels) - min(labels) <= 1, str(labels))
                report.check(f"{theme}: Sync icon is in the same column",
                             abs(d["sync"]["left"] - icons[0]) <= 1, str(d["sync"]) + str(icons))
                report.check(f"{theme}: no footer label is right-aligned",
                             all(i["align"] in ("left", "start") for i in items)
                             and d["sync"]["syncAlign"] in ("left", "start") and d["sync"]["justify"] == "flex-start",
                             str(d))
                report.check(f"{theme}: same row height", len({round(i["h"]) for i in items}) == 1
                             and round(d["sync"]["h"]) == round(items[0]["h"]), str(d))
                report.check(f"{theme}: expanded toggle says Collapse sidebar",
                             d["toggleName"] == "Collapse sidebar" and d["toggleTitle"] == "Collapse sidebar"
                             and d["toggleText"] == "Collapse sidebar", str(d))
            browser.close()
    finally:
        base.stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {report.checked} sidebar footer alignment checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
