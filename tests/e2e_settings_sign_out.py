"""E2E: 'Sign out' in Settings leaves the unlocked app at once (idea #228).

Registers, opens Settings, clicks #btn-logout, confirms the dialog and checks,
without a reload, that the unlock/login screen shows and Settings and the notes
are gone. The logout request is either held back forever or fails.

    python tests/e2e_settings_sign_out.py
"""
from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from e2e_register_after_signout import SERVER_ENV, Browser, register_first_account
from e2e_signup_autounlock import free_port, start_server

SCREEN_TIMEOUT_MS = 4000  # shorter than the 8 s request timeout of the old code

SCREEN_JS = """() => {
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  return {
    unlocked: document.body.classList.contains('unlocked'),
    unlockScreen: shown(document.getElementById('unlock-screen')),
    settings: shown(document.getElementById('settings-panel')),
    notes: shown(document.getElementById('note-list')),
    path: location.pathname,
  };
}"""

LEFT_APP_JS = "() => { const s = (" + SCREEN_JS + ")(); return !s.settings && !s.notes && !s.unlocked && (s.unlockScreen || s.path === '/login'); }"


def sign_out_from_settings(logout_mode: str) -> dict:
    """logout_mode 'hang' never answers /api/auth/logout, 'fail' aborts it.
    Returns the screen state once SCREEN_TIMEOUT_MS passed after confirming (or earlier if it left the app)."""
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-settings-sign-out-"))
    port = free_port()
    proc = start_server(root, port, SERVER_ENV)
    try:
        with sync_playwright() as p:
            b = Browser(p, f"http://127.0.0.1:{port}")
            try:
                register_first_account(b, f"signout-{int(time.time() * 1000)}@home.local")
                page = b.page
                page.wait_for_function("() => document.body.classList.contains('unlocked')")
                page.click("#btn-settings-nav")
                page.wait_for_selector("#settings-panel:not([hidden])")
                held = []
                if logout_mode == "hang":
                    page.route("**/api/auth/logout", lambda route, *_: held.append(route))
                else:
                    page.route("**/api/auth/logout", lambda route, *_: route.abort())
                page.click("#btn-logout")
                page.locator("[role=dialog] button, dialog button", has_text="Sign out").last.click()
                try:
                    page.wait_for_function(LEFT_APP_JS, timeout=SCREEN_TIMEOUT_MS)
                except Exception:
                    pass
                try:
                    return page.evaluate(SCREEN_JS)
                except Exception:
                    # The logout finished and the page is navigating to /login.
                    page.wait_for_load_state("domcontentloaded")
                    return page.evaluate(SCREEN_JS)
            finally:
                for route in held:
                    try:
                        route.abort()
                    except Exception:
                        pass
                b.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    for mode in ("hang", "fail"):
        print(mode, sign_out_from_settings(mode))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
