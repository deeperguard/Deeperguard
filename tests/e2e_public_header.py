"""E2E (Playwright, Chromium): public site header never clips a nav link.

At 900/1000/1100/1280/1440px every nav link must be fully visible in the
viewport (not clipped by an ancestor) or reachable through the opened menu;
Sign in / Create free vault stay visible; aria-expanded toggles and Escape
closes the menu and returns focus to the button.

    python tests/e2e_public_header.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import free_port, start_server  # noqa: E402

WIDTHS = (900, 1000, 1100, 1280, 1440)
PAGES = ("/", "/security", "/download", "/blog", "/contact")

VISIBLE_JS = """
(el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.left < -0.5 || r.right > document.documentElement.clientWidth + 0.5) return false;
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const pr = p.getBoundingClientRect();
      if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 ||
          r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) return false;
    }
  }
  return true;
}
"""


def check_page(browser, base, path, width, failures):
    page = browser.new_page(viewport={"width": width, "height": 800})
    page.goto(base + path)
    page.wait_for_load_state("networkidle")
    page.evaluate("document.fonts.ready")
    tag = f"{path}@{width}"
    for sel in (".mk-topbar-signin", ".mk-topbar-cta"):
        if not page.eval_on_selector(sel, VISIBLE_JS):
            failures.append(f"{tag}: {sel} not visible")
    links = page.locator(".mk-nav a")
    count = links.count()
    if count == 0:
        failures.append(f"{tag}: no nav links")
    collapsed = page.evaluate("document.querySelector('.mk-topbar').classList.contains('nav-collapsed')")
    toggle = page.locator(".mk-nav-toggle")
    if not collapsed:
        for i in range(count):
            if not links.nth(i).evaluate(VISIBLE_JS):
                failures.append(f"{tag}: link {i} clipped")
        if toggle.is_visible():
            failures.append(f"{tag}: toggle visible while links fit")
    else:
        if not toggle.is_visible():
            failures.append(f"{tag}: collapsed but toggle hidden")
        if toggle.get_attribute("aria-expanded") != "false":
            failures.append(f"{tag}: aria-expanded not false")
        toggle.click()
        if toggle.get_attribute("aria-expanded") != "true":
            failures.append(f"{tag}: aria-expanded not true after click")
        for i in range(count):
            if not links.nth(i).evaluate(VISIBLE_JS):
                failures.append(f"{tag}: link {i} unreachable in open menu")
        page.keyboard.press("Escape")
        if toggle.get_attribute("aria-expanded") != "false":
            failures.append(f"{tag}: Escape did not close menu")
        if not page.evaluate("document.activeElement.classList.contains('mk-nav-toggle')"):
            failures.append(f"{tag}: focus not returned to toggle")
        if links.nth(0).is_visible():
            failures.append(f"{tag}: hidden links still visible when closed")
    page.close()


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0
    root = Path(tempfile.mkdtemp(prefix="e2e-public-header-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    failures: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for path in PAGES:
                for w in WIDTHS:
                    check_page(browser, base, path, w, failures)
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)
    for f in failures:
        print("FAIL:", f)
    if failures:
        return 1
    print("e2e_public_header ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
