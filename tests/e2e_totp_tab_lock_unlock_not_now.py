"""E2E regression for idea #186: 2FA tab after lock, unlock and "Not now".

Register (lands unlocked), click "Not now" on the device-phrase card (it only
appears once, not after a later unlock), lock the vault, unlock with the
password, click the 2FA tab. The 2FA pane must be visible, the Notes pane
(#notes-shell, the list and the editor) must be hidden, and the 2FA tab must
be aria-selected. This is checked again after a second click on 2FA. Waits use
Playwright auto-waiting assertions only. See docs/bugs/2fa-tab-after-unlock.md.

    python tests/e2e_totp_tab_lock_unlock_not_now.py
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

LOCKED_JS = """() => !(window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked())"""

DOM_JS = """() => {
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0
    && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const tab = document.getElementById('app-tab-2fa');
  return {
    appTab: document.getElementById('app')?.dataset.appTab || '',
    totpPaneShown: shown(document.getElementById('totp-pane')),
    notesShellShown: shown(document.getElementById('notes-shell')),
    notesListShown: shown(document.getElementById('notes-list')),
    editorPaneShown: shown(document.getElementById('editor-pane')),
    tab2faSelected: tab?.getAttribute('aria-selected'),
    tab2faClass: tab?.className,
    notesTabSelected: document.getElementById('app-tab-notes')?.getAttribute('aria-selected'),
    activeElement: document.activeElement?.id || document.activeElement?.tagName,
  };
}"""


def main() -> int:
    try:
        from playwright.sync_api import expect, sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-totp-lock-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port, extra_env={"NOTES_DEFAULT_PLAN": "pro"})
    try:
        email = f"totp-lock-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: console_errors.append(str(e)))
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

            # The card is shown once after registering; it is not shown again after a
            # later unlock (see docs/bugs/2fa-tab-after-unlock.md), so "Not now" comes first.
            dismiss = page.locator("#btn-device-phrase-prompt-dismiss")
            expect(dismiss).to_be_visible(timeout=10000)
            dismiss.click()
            expect(page.locator("#device-phrase-prompt")).to_be_hidden(timeout=10000)

            page.locator("#btn-lock-head:visible, #btn-lock-nav:visible").first.click(timeout=10000)
            page.wait_for_function(LOCKED_JS, timeout=20000)
            page.wait_for_selector("#unlock-password", state="visible", timeout=20000)
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)

            for label in ("first click", "second click"):
                page.click("#app-tab-2fa", timeout=10000)
                try:
                    expect(page.locator("#totp-pane")).to_be_visible(timeout=10000)
                    expect(page.locator("#notes-shell")).to_be_hidden(timeout=10000)
                    expect(page.locator("#notes-list")).to_be_hidden(timeout=10000)
                    expect(page.locator("#editor-pane")).to_be_hidden(timeout=10000)
                    expect(page.locator("#app-tab-2fa")).to_have_attribute("aria-selected", "true", timeout=10000)
                except AssertionError as exc:
                    print(f"FAIL ({label}):", exc)
                    print("DOM:", page.evaluate(DOM_JS))
                    print("console errors:", console_errors)
                    return 1
                print(f"{label} DOM:", page.evaluate(DOM_JS))
            print("console errors:", console_errors)
            browser.close()
        print("e2e_totp_tab_lock_unlock_not_now ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
