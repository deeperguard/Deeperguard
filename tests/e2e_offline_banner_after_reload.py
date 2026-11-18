"""Reproduction for idea #199: "You're offline" after reload while the server is up.

Register, create a note labelled "boodschappen/winkel" (a sub-label of
"boodschappen"), reload, unlock, click the parent label "boodschappen" in the
sidebar, then report whether the offline banner (#network-status-banner) is
shown and whether #btn-network-retry is visible and clickable. The script only
reports; it fails (exit 1) when the banner is shown while the server answers
/api/health. See docs/OFFLINE_BANNER_FINDINGS.md.

Skipped by default. Run it with --run (or E2E_OFFLINE_BANNER_RELOAD=1):

    python tests/e2e_offline_banner_after_reload.py --run
    python tests/e2e_offline_banner_after_reload.py --run --fail-health 1

--offline switches the browser context offline after the unlock, so the banner
is legitimate and only Retry clickability is checked.

--fail-health N aborts the first N /api/health requests after the reload and
--fail-after-unlock N the first N after the unlock, followed by a
visibilitychange (the tab coming back to the foreground). Both simulate a
transient failure, like a 1.5 s probe timeout on a busy server, so the banner
path can be observed; the server itself stays up the whole time.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

CHROMIUM = os.environ.get("E2E_CHROMIUM", "/usr/bin/chromium")

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

BANNER_JS = """() => {
  const el = document.getElementById('network-status-banner');
  const btn = document.getElementById('btn-network-retry');
  const shown = (e) => !!e && !e.hidden && e.getClientRects().length > 0
    && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  let top = null;
  if (btn && shown(btn)) {
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    top = hit ? (hit === btn || btn.contains(hit) ? 'button itself' : hit.id || hit.className || hit.tagName) : 'nothing';
  }
  return {
    bannerShown: shown(el),
    text: (document.getElementById('network-status-text') || {}).textContent || '',
    retryShown: shown(btn),
    retryDisabled: !!btn && btn.disabled,
    elementAtRetryCentre: top,
    navigatorOnLine: navigator.onLine,
    reachable: typeof window.notesNetworkReachable === 'function' ? window.notesNetworkReachable() : null,
  };
}"""


def main() -> int:
    if "--run" not in sys.argv and os.environ.get("E2E_OFFLINE_BANNER_RELOAD") != "1":
        print("skip: pass --run or set E2E_OFFLINE_BANNER_RELOAD=1")
        return 0
    from playwright.sync_api import sync_playwright

    fail_health = int(sys.argv[sys.argv.index("--fail-health") + 1]) if "--fail-health" in sys.argv else 0
    fail_after_unlock = int(sys.argv[sys.argv.index("--fail-after-unlock") + 1]) if "--fail-after-unlock" in sys.argv else 0
    root = Path(tempfile.mkdtemp(prefix="e2e-offline-banner-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    failures: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM, headless=True)
            page = browser.new_context().new_page()
            health: list[str] = []
            page.on("response", lambda r: health.append(f"{r.status} {r.url}") if "/api/health" in r.url else None)
            page.on("requestfailed", lambda r: health.append(f"FAILED {r.url} {r.failure}") if "/api/" in r.url else None)
            page.goto(f"{base}/register", wait_until="domcontentloaded")
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
            complete_recovery_key_step(page)

            # Note with a sub-label of "boodschappen", created with NotesStore.createTag (parent, then child).
            page.evaluate(
                """async () => {
                  const parentId = NotesStore.createTag('boodschappen');
                  const tagId = NotesStore.createTag('winkel', parentId);
                  NotesStore.upsert(NotesStore.newUuid(),
                    { ...NotesStore.defaultNote(), title: 'Lijstje', tags: [tagId] });
                  await NotesStore.pushDirty();
                }"""
            )
            print("after create:", page.evaluate(BANNER_JS))

            budget = {"left": 0}

            def maybe_abort(route):
                if budget["left"] > 0:
                    budget["left"] -= 1
                    route.abort("connectionreset")
                else:
                    route.continue_()

            page.route("**/api/health", maybe_abort)
            budget["left"] = fail_health
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
            print("after reload (locked):", page.evaluate(BANNER_JS))
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
            page.wait_for_timeout(500)
            print("after unlock:", page.evaluate(BANNER_JS))
            # Record every show/hide of the banner (ms since now) so a short flash is not missed.
            page.evaluate("""() => {
              const el = document.getElementById('network-status-banner');
              const t0 = performance.now();
              window.__bannerLog = [];
              new MutationObserver(() => window.__bannerLog.push(
                { ms: Math.round(performance.now() - t0), hidden: el.hidden })).observe(el, { attributes: true, attributeFilter: ['hidden'] });
            }""")
            if "--offline" in sys.argv:
                page.context.set_offline(True)  # real offline: the banner is then expected
                page.wait_for_selector("#network-status-banner:not([hidden])", timeout=15000)
            if fail_after_unlock:
                budget["left"] = fail_after_unlock
                page.wait_for_timeout(2100)  # onAppForeground ignores calls within 2 s of the last one
                page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")

            # The tag list only shows once the sidebar is expanded.
            page.click("#btn-nav-pin", timeout=10000)
            page.click('#tag-list [data-label] .label-name:text-is("boodschappen")', timeout=10000)
            print("note rows:", page.locator(".note-row").count())

            # Watch the banner for 15 s; try Retry (6 s, like the tester) the first time it shows.
            started = time.time()
            seen = None
            tried = False
            while time.time() - started < 15:
                state = page.evaluate(BANNER_JS)
                if state["bannerShown"] != seen:
                    seen = state["bannerShown"]
                    print(f"t={time.time() - started:5.1f}s banner shown={seen}:", state)
                if state["bannerShown"] and not tried:
                    tried = True
                    if "--offline" not in sys.argv:
                        failures.append(f"offline banner shown while the server is reachable: {state}")
                    t0 = time.time()
                    try:
                        page.click("#btn-network-retry", timeout=6000)
                        print(f"retry click: ok after {time.time() - t0:.1f}s")
                    except Exception as err:  # Playwright TimeoutError
                        failures.append(f"retry click failed: {str(err).splitlines()[0]}")
                page.wait_for_timeout(250)
            print("banner hidden-attribute changes:", page.evaluate("() => window.__bannerLog"))
            print("api health traffic:", health)
            browser.close()
        for line in failures:
            print("FAIL:", line)
        if not failures:
            print("e2e_offline_banner_after_reload: no unexpected offline banner")
        return 1 if failures else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
