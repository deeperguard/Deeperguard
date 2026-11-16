"""E2E (Playwright, Chromium): public site header never clips a nav link.

At 900/1000/1100/1280/1440px, with and without JavaScript, every nav link must
be fully inside the viewport and not clipped by an ancestor; "Sign in" and
"Create free vault" stay visible. With JS on, the menu button is a <button>
whose aria-expanded flips, Escape closes the menu and focuses the button.

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
PAGES = ("/", "/#features", "/security", "/pricing", "/#faq", "/download", "/blog", "BLOG_POST", "/contact")

CLIPPED_JS = """(jsOn) => {
  const bad = [];
  const vw = document.documentElement.clientWidth;
  const els = [...document.querySelectorAll('.mk-topbar .mk-nav a, .mk-topbar-actions a')];
  for (const a of els) {
    const cs = getComputedStyle(a);
    const r = a.getBoundingClientRect();
    const label = a.textContent.trim().slice(0, 30);
    if (cs.display === 'none' || r.width === 0) {
      // allowed only for the hidden mobile CTA label variant, or links moved into the collapsed menu
      if (a.closest('.mk-nav') && !a.closest('.mk-topbar.nav-collapsed')) bad.push('hidden nav link ' + label);
      continue;
    }
    if (r.left < -0.5 || r.right > vw + 0.5) bad.push('outside viewport ' + label);
    for (let p = a.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 || r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
          bad.push('clipped by ' + p.className + ': ' + label);
        }
      }
    }
  }
  const nav = document.querySelector('.mk-topbar .mk-nav');
  const topbar = document.querySelector('.mk-topbar');
  if (nav && topbar && !topbar.classList.contains('nav-collapsed')) {
    const tops = new Set([...nav.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().top)));
    if (tops.size > 1 && jsOn) bad.push('nav wraps onto ' + tops.size + ' lines');
  }
  for (const sel of ['.mk-topbar-signin', '.mk-topbar-cta']) {
    const b = document.querySelector(sel);
    if (!b) { bad.push('missing ' + sel); continue; }
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !b.contains(hit)) bad.push('not clickable ' + sel);
  }
  return bad;
}"""

MENU_JS = """() => {
  const bad = [];
  const vw = document.documentElement.clientWidth;
  for (const a of document.querySelectorAll('.mk-topbar .mk-nav a')) {
    const r = a.getBoundingClientRect();
    const label = a.textContent.trim().slice(0, 30);
    if (getComputedStyle(a).visibility === 'hidden' || r.width === 0 || r.height === 0) { bad.push('menu link hidden ' + label); continue; }
    if (r.left < -0.5 || r.right > vw + 0.5) { bad.push('menu link outside viewport ' + label); continue; }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !a.contains(hit)) bad.push('menu link covered ' + label);
  }
  return bad;
}"""


def blog_post_path(browser, base):
    ctx = browser.new_context()
    page = ctx.new_page()
    page.goto(base + "/blog", wait_until="load")
    href = page.evaluate("() => { const a = document.querySelector('main a[href^=\"/blog/\"]:not([href$=\".xml\"])'); return a ? a.getAttribute('href') : null; }")
    ctx.close()
    return href


def check_widths(browser, base, failures, js_enabled, pages):
    collapsed_seen = False
    for path in pages:
        for w in WIDTHS:
            ctx = browser.new_context(viewport={"width": w, "height": 800}, java_script_enabled=js_enabled)
            page = ctx.new_page()
            page.goto(base + path, wait_until="load")
            if js_enabled:
                page.evaluate("() => document.fonts.ready")
                page.wait_for_timeout(50)
            for msg in page.evaluate(CLIPPED_JS, js_enabled):
                failures.append(f"{path} {w}px js={js_enabled}: {msg}")
            if js_enabled and page.evaluate("() => document.querySelector('.mk-topbar').classList.contains('nav-collapsed')"):
                collapsed_seen = True
                btn = page.locator("button.mk-nav-toggle")
                if not btn.is_visible():
                    failures.append(f"{path} {w}px: collapsed nav without visible menu button")
                else:
                    btn.click()
                    if btn.get_attribute("aria-expanded") != "true":
                        failures.append(f"{path} {w}px: aria-expanded not true after opening")
                    for msg in page.evaluate(MENU_JS):
                        failures.append(f"{path} {w}px opened menu: {msg}")
                    page.keyboard.press("Escape")
                    if btn.get_attribute("aria-expanded") != "false":
                        failures.append(f"{path} {w}px: Escape did not close the collapsed menu")
                    if not page.evaluate("document.activeElement && document.activeElement.classList.contains('mk-nav-toggle')"):
                        failures.append(f"{path} {w}px: Escape did not focus the menu button")
            ctx.close()
    return collapsed_seen


def check_menu(browser, base, failures):
    ctx = browser.new_context(viewport={"width": 390, "height": 800})
    page = ctx.new_page()
    page.goto(base + "/", wait_until="load")
    btn = page.locator("button.mk-nav-toggle")
    if btn.count() != 1:
        failures.append("menu toggle is not a single <button>")
        ctx.close()
        return
    if btn.get_attribute("aria-expanded") != "false":
        failures.append("aria-expanded should start false")
    btn.click()
    if btn.get_attribute("aria-expanded") != "true":
        failures.append("aria-expanded should be true after click")
    if not page.locator("#mk-nav a").first.is_visible():
        failures.append("nav links not visible in open menu")
    page.keyboard.press("Escape")
    if btn.get_attribute("aria-expanded") != "false":
        failures.append("Escape did not close the menu")
    if not page.evaluate("document.activeElement && document.activeElement.classList.contains('mk-nav-toggle')"):
        failures.append("Escape did not focus the menu button")
    if page.locator("#mk-nav a").first.is_visible():
        failures.append("nav links still visible after close")
    btn.click()
    page.mouse.click(5, 780)
    if btn.get_attribute("aria-expanded") != "false":
        failures.append("backdrop click did not close the menu")
    ctx.close()


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
            post = blog_post_path(browser, base)
            if not post:
                failures.append("no published blog post found; blog post page not checked")
            pages = [post if p == "BLOG_POST" else p for p in PAGES if p != "BLOG_POST" or post]
            if not check_widths(browser, base, failures, True, pages):
                print("note: nav fitted on one line at every width; collapsed menu not exercised")
            check_widths(browser, base, failures, False, pages)
            check_menu(browser, base, failures)
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
    raise SystemExit(main())
