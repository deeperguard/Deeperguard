"""E2E: the 2FA tab opens after dismissing a prompt, and never while locked.

Steps (idea #93): register (lands unlocked), click 2FA, dismiss any visible
"Not now"/"Close" prompt, click 2FA again -> the 2FA pane is visible and the
notes list is hidden. Then lock the vault and check no 2FA code is visible.

The test server runs on the Pro plan through the child process environment
only (NOTES_DEFAULT_PLAN), so this never leaks into other tests.

    python tests/e2e_totp_tab_after_prompt.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

UNLOCKED_JS = """() => location.pathname === '/app'
  && window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""

DISMISS_JS = """() => {
  const visible = (el) => !!el && !el.disabled && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden';
  const hits = [];
  document.querySelectorAll('button').forEach((btn) => {
    const label = (btn.textContent || '').trim();
    if ((label === 'Not now' || label === 'Close') && visible(btn)) {
      hits.push(btn.id || label);
      btn.click();
    }
  });
  return hits;
}"""

STATE_JS = """() => {
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0
    && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const pane = document.getElementById('totp-pane');
  const shell = document.getElementById('notes-shell');
  const list = document.getElementById('notes-list') || shell;
  const codes = [...document.querySelectorAll('.totp-code')].filter(shown);
  return {
    tab: document.getElementById('app')?.dataset.appTab || '',
    paneShown: shown(pane),
    listShown: shown(list),
    codesShown: codes.length,
    unlocked: !!(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()),
  };
}"""


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-totp-tab-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
    try:
        email = f"totp-tab-{int(time.time())}@home.local"
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
            complete_recovery_key_step(page)

            for width, height in ((1280, 800), (390, 844)):
                page.set_viewport_size({"width": width, "height": height})
                page.click("#app-tab-notes", timeout=10000)
                # Make sure a real "Not now" prompt is on screen in the notes view.
                page.evaluate(
                    """() => {
                      const el = document.getElementById('device-phrase-prompt');
                      if (el) el.hidden = false;
                    }"""
                )
                # Step 2: click 2FA (real pointer click, so an overlay would intercept it).
                page.click("#app-tab-2fa", timeout=10000)
                page.wait_for_timeout(300)
                # Step 3: dismiss the prompt with a real click; if the 2FA pane hid it,
                # go back to Notes, dismiss it there and return (tester's flow).
                dismissed = page.evaluate(DISMISS_JS)
                if not dismissed:
                    page.click("#app-tab-notes", timeout=10000)
                    if width < 700 and not page.is_visible("#btn-device-phrase-prompt-dismiss"):
                        page.evaluate("() => document.getElementById('device-phrase-prompt').scrollIntoView()")
                    if page.is_visible("#btn-device-phrase-prompt-dismiss"):
                        page.click("#btn-device-phrase-prompt-dismiss", timeout=10000)
                        dismissed = ["btn-device-phrase-prompt-dismiss"]
                    dismissed += page.evaluate(DISMISS_JS)
                page.wait_for_timeout(300)
                # Step 4: click 2FA again.
                page.click("#app-tab-2fa", timeout=10000)
                page.wait_for_function(
                    "() => document.getElementById('app')?.dataset.appTab === '2fa'", timeout=10000
                )
                state = page.evaluate(STATE_JS)
                print(f"{width}x{height} after re-click:", state, "dismissed:", dismissed)
                if not state["paneShown"] or state["listShown"]:
                    print("FAIL: 2FA pane not shown or notes list still visible", state)
                    return 1

            # Add one account so there is a real code that must vanish on lock.
            page.set_viewport_size({"width": 1280, "height": 800})
            page.click("#btn-totp-add", timeout=10000)
            page.fill("#totp-add-issuer", "E2E Example")
            page.fill("#totp-add-secret", "JBSWY3DPEHPK3PXP")
            page.click("#totp-add-save", timeout=10000)
            page.wait_for_function(
                """() => [...document.querySelectorAll('.totp-code')]
                  .some((el) => el.getClientRects().length > 0)""",
                timeout=20000,
            )

            # Locked vault: the 2FA tab must not lead to visible codes.
            page.evaluate("() => document.getElementById('btn-lock-now').click()")
            page.wait_for_function(
                "() => !(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())",
                timeout=20000,
            )
            page.evaluate("() => document.getElementById('app-tab-2fa')?.click()")
            page.wait_for_timeout(500)
            locked = page.evaluate(STATE_JS)
            print("after lock:", locked)
            if locked["unlocked"] or locked["codesShown"] or locked["paneShown"]:
                print("FAIL: 2FA pane or codes visible while the vault is locked", locked)
                return 1
            browser.close()
        print("e2e_totp_tab_after_prompt ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
