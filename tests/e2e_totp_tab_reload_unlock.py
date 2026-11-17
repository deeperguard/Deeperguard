"""E2E regression for idea #116: the 2FA tab after unlock, "Not now" and reload.

Register (lands unlocked), click 2FA, dismiss the "Not now" prompt, click 2FA
again; then reload, unlock again and click 2FA once more. Every time the 2FA
pane must be visible and the notes list hidden. See docs/bugs/2fa-tab-switch.md.

Limits: the "Not now" prompt is the in-app device-phrase card
(#device-phrase-prompt), which the app shows by itself after unlock. The real
Web Push (browser notification permission) prompt is not reproduced here. The
test runs on the Pro plan only; the Free-plan variant (toast "Included with
Pro") is not covered.

    python tests/e2e_totp_tab_reload_unlock.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

STATE_JS = """() => {
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0
    && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const list = document.getElementById('notes-list') || document.getElementById('notes-shell');
  return {
    tab: document.getElementById('app')?.dataset.appTab || '',
    paneShown: shown(document.getElementById('totp-pane')),
    listShown: shown(list),
  };
}"""


def check(page, label: str) -> list[str]:
    """Real pointer click on the 2FA tab, then assert the visible panes."""
    page.click("#app-tab-2fa", timeout=10000)
    timed_out = False
    try:
        page.wait_for_function(
            "() => document.getElementById('app')?.dataset.appTab === '2fa'", timeout=5000
        )
    except Exception:  # Playwright TimeoutError; reported as a failure below
        timed_out = True
    state = page.evaluate(STATE_JS)
    print(f"{label}:", state, "(tab did not switch in time)" if timed_out else "")
    if timed_out or not state["paneShown"] or state["listShown"]:
        return [f"{label}: 2FA pane not shown or notes list still visible {state} timed_out={timed_out}"]
    return []


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-totp-reload-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
    failures: list[str] = []
    try:
        email = f"totp-reload-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
            page.goto(f"{base}/register", wait_until="domcontentloaded")
            page.wait_for_selector("#register-form")
            page.fill('input[name="email"]', email)
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

            # The "Not now" card appears by itself after unlock (no phrase set, not dismissed).
            page.wait_for_selector("#device-phrase-prompt:not([hidden])", timeout=10000)
            failures += check(page, "after unlock")
            # The prompt lives in the notes view: return there if the 2FA pane hid it.
            if not page.is_visible("#btn-device-phrase-prompt-dismiss"):
                page.click("#app-tab-notes", timeout=10000)
            page.click("#btn-device-phrase-prompt-dismiss", timeout=10000)
            page.wait_for_timeout(300)
            failures += check(page, "after Not now")

            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="attached", timeout=60000)
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
            failures += check(page, "after reload and unlock")
            browser.close()
        for line in failures:
            print("FAIL:", line)
        if not failures:
            print("e2e_totp_tab_reload_unlock ok")
        return 1 if failures else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
