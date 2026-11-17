"""E2E: the shared sidebar collapses to icons, every entry keeps a name and
a tooltip, and the state survives a reload (local UI preferences only).

    python tests/e2e_sidebar_collapse.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_layout_actions as base  # noqa: E402

TOGGLE = {"notes": "#btn-nav-pin", "agenda": "#btn-agenda-nav-toggle", "2fa": "#btn-totp-nav-toggle"}
ENTRIES = {
    "notes": ["#filters .filter", "#btn-secure-send-nav", "#btn-settings-nav", "#btn-lock-nav",
              "#btn-account-info-nav"],
    "agenda": ["#agenda-calendar-settings-btn"],
    "2fa": ["#btn-totp-lock", "#btn-totp-settings"],
}

STATE_JS = """([toggle, entries]) => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const t = document.querySelector(toggle);
  const rows = entries.flatMap((s) => [...document.querySelectorAll(s)]);
  return {
    pinned: document.body.classList.contains('nav-pinned'),
    expanded: t && t.getAttribute('aria-expanded'),
    toggleName: t && t.getAttribute('aria-label'),
    toggleTitle: t && t.title,
    stored: JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}').navPinned,
    rows: rows.map((el) => ({
      id: el.id || el.dataset.filter,
      name: (el.getAttribute('aria-label') || '').trim(),
      title: (el.title || '').trim(),
      textShown: [...el.querySelectorAll('span')].some((s) => vis(s) && s.textContent.trim()),
    })),
  };
}"""


def state(page, tab):
    return page.evaluate(STATE_JS, [TOGGLE[tab], ENTRIES[tab]])


def reload_unlocked(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
    page.fill("#unlock-password", base.PASSWORD)
    page.click("#unlock-submit")
    page.wait_for_function(base.UNLOCKED_JS, timeout=120000)
    page.wait_for_timeout(500)
    page.evaluate(base.DISMISS_JS)


def go(page, tab):
    page.click(f"#app-tab-{tab}", timeout=10000)
    page.wait_for_timeout(500)


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
            page.evaluate("() => localStorage.removeItem('deeperguard-prefs')")

            for tab in ("notes", "agenda", "2fa"):
                go(page, tab)
                st = state(page, tab)
                report.check(f"{tab}: collapsed by default, toggle says Expand",
                             not st["pinned"] and st["expanded"] == "false"
                             and st["toggleName"] == "Expand sidebar" and st["toggleTitle"] == st["toggleName"], str(st))
                report.check(f"{tab}: icon-only entries have aria-label and tooltip",
                             bool(st["rows"]) and all(r["name"] and r["title"] and not r["textShown"] for r in st["rows"]),
                             str(st["rows"]))

            # Expand from Agenda; every area follows.
            go(page, "agenda")
            page.click(TOGGLE["agenda"])
            page.wait_for_timeout(300)
            for tab in ("agenda", "2fa", "notes"):
                go(page, tab)
                st = state(page, tab)
                report.check(f"{tab}: expanded after toggle, toggle says Collapse",
                             st["pinned"] and st["expanded"] == "true" and st["toggleName"] == "Collapse sidebar"
                             and st["stored"] is True, str(st))

            # Expanded survives a reload; then collapse from 2FA and check that too.
            for want in (True, False):
                if not want:
                    go(page, "2fa")
                    page.click(TOGGLE["2fa"])
                    page.wait_for_timeout(300)
                reload_unlocked(page)
                for tab in ("notes", "agenda", "2fa"):
                    go(page, tab)
                    st = state(page, tab)
                    report.check(f"{tab}: {'expanded' if want else 'collapsed'} after reload",
                                 st["pinned"] is want and st["stored"] is want
                                 and st["expanded"] == ("true" if want else "false")
                                 and all(r["name"] and r["title"] for r in st["rows"]), str(st))
                    if not want:
                        report.check(f"{tab}: icon-only after reload",
                                     all(not r["textShown"] for r in st["rows"]), str(st["rows"]))

            # Keyboard: Enter on the focused toggle flips it.
            go(page, "notes")
            page.focus(TOGGLE["notes"])
            page.keyboard.press("Enter")
            page.wait_for_timeout(300)
            report.check("keyboard Enter on the toggle expands", state(page, "notes")["expanded"] == "true")
            browser.close()
    finally:
        base.stop_server(proc)

    if report.failures:
        print(f"\n{len(report.failures)} of {report.checked} checks failed", file=sys.stderr)
        return 1
    print(f"OK - {report.checked} sidebar collapse checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
