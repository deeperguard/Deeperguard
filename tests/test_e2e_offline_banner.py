"""Offline banner regression tests (idea #199), real browser against a local server.

1. Register, create a labelled note, reload, unlock, filter on the parent label:
   no "You're offline" banner on a reachable server, even when one /api/health
   request fails in between (the app re-checks before it flips to offline).
2. When /api/** is unreachable, the banner does appear and #btn-network-retry
   is visible, enabled, not covered and clickable.

See docs/OFFLINE_BANNER_FINDINGS.md.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

CHROMIUM = os.environ.get("E2E_CHROMIUM", "/usr/bin/chromium")
UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""
BANNER_JS = """() => {
  const el = document.getElementById('network-status-banner');
  const btn = document.getElementById('btn-network-retry');
  const shown = (e) => !!e && !e.hidden && e.getClientRects().length > 0
    && getComputedStyle(e).visibility !== 'hidden';
  let top = null;
  if (btn && shown(btn)) {
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    top = !!hit && (hit === btn || btn.contains(hit));
  }
  return { banner: shown(el), retry: shown(btn), disabled: !!btn && btn.disabled, uncovered: top };
}"""


class OfflineBannerE2E(unittest.TestCase):
    def setUp(self):
        from playwright.sync_api import sync_playwright

        self.pw = sync_playwright().start()
        self.addCleanup(self.pw.stop)
        port = free_port()
        self.base = f"http://127.0.0.1:{port}"
        self.proc = start_server(Path(tempfile.mkdtemp(prefix="e2e-offline-banner-")), port)
        self.addCleanup(self._stop_server)
        browser = self.pw.chromium.launch(executable_path=CHROMIUM, headless=True)
        self.addCleanup(browser.close)
        self.page = browser.new_context().new_page()

    def _stop_server(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except Exception:
            self.proc.kill()

    def _register_and_create_note(self):
        page = self.page
        page.goto(f"{self.base}/register", wait_until="domcontentloaded")
        page.wait_for_selector("#register-form")
        page.fill('input[name="email"]', f"offline-banner-{int(time.time())}@home.local")
        page.fill("#register-password", PASSWORD)
        page.fill("#register-password2", PASSWORD)
        page.check("#register-terms")
        page.check("#register-recover-ack")
        page.evaluate(
            """() => {
              document.querySelectorAll('.cf-turnstile').forEach((el) => el.remove());
              let input = document.querySelector('input[name="cf-turnstile-response"]');
              if (!input) {
                input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'cf-turnstile-response';
                document.getElementById('register-form').appendChild(input);
              }
              input.value = 'e2e-dummy-turnstile-token';
            }"""
        )
        page.click("#register-submit")
        page.wait_for_function(UNLOCKED_JS, timeout=120000)
        page.evaluate(
            """async () => {
              const parentId = NotesStore.createTag('boodschappen');
              const tagId = NotesStore.createTag('winkel', parentId);
              NotesStore.upsert(NotesStore.newUuid(),
                { ...NotesStore.defaultNote(), title: 'Lijstje', tags: [tagId] });
              await NotesStore.pushDirty();
            }"""
        )

    def _reload_and_unlock(self):
        page = self.page
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
        page.fill("#unlock-password", PASSWORD)
        page.click("#unlock-submit")
        page.wait_for_function(UNLOCKED_JS, timeout=120000)
        page.wait_for_timeout(500)

    def _filter_on_parent_label(self):
        self.page.click("#btn-nav-pin", timeout=10000)
        self.page.click('#tag-list [data-label] .label-name:text-is("boodschappen")', timeout=10000)
        self.assertEqual(self.page.locator(".note-row").count(), 1)

    def _foreground(self):
        # onAppForeground ignores calls within 2 s of the previous one.
        self.page.wait_for_timeout(2100)
        self.page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")

    def test_no_offline_banner_after_reload_unlock_and_label_filter(self):
        page = self.page
        self._register_and_create_note()
        self._reload_and_unlock()
        page.evaluate(
            """() => {
              const el = document.getElementById('network-status-banner');
              window.__bannerShown = false;
              new MutationObserver(() => { if (!el.hidden) window.__bannerShown = true; })
                .observe(el, { attributes: true, attributeFilter: ['hidden'] });
            }"""
        )
        failed = {"left": 1}

        def one_failure(route):
            if failed["left"] > 0:
                failed["left"] -= 1
                route.abort("connectionreset")
            else:
                route.continue_()

        page.route("**/api/health", one_failure)
        self._foreground()
        self._filter_on_parent_label()
        page.wait_for_timeout(4000)
        self.assertEqual(failed["left"], 0, "the simulated health failure was never hit")
        self.assertFalse(page.evaluate("() => window.__bannerShown"), "banner flashed on a single failed probe")
        self.assertFalse(page.evaluate(BANNER_JS)["banner"])

    def test_banner_and_clickable_retry_on_real_network_failure(self):
        page = self.page
        self._register_and_create_note()
        self._reload_and_unlock()
        self._filter_on_parent_label()
        # The whole API is unreachable: a successful sync would (rightly) clear the banner.
        page.route("**/api/**", lambda route: route.abort("connectionreset"))
        page.evaluate(
            """() => { window.__retryClicks = 0;
              document.getElementById('btn-network-retry')
                .addEventListener('click', () => { window.__retryClicks++; }); }"""
        )
        self._foreground()
        page.wait_for_selector("#network-status-banner:not([hidden])", timeout=15000)
        state = page.evaluate(BANNER_JS)
        self.assertTrue(state["retry"])
        self.assertFalse(state["disabled"])
        self.assertTrue(state["uncovered"])
        page.click("#btn-network-retry", timeout=6000)
        self.assertEqual(page.evaluate("() => window.__retryClicks"), 1)


if __name__ == "__main__":
    unittest.main()
