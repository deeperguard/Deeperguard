"""E2E: the agenda view is an encrypted, synced setting (docs/SETTINGS_SPEC.md).

Register -> pick the 3-day view -> reload and unlock again -> still 3-day; a
fresh browser context (another "device") logging in also gets 3-day; before
unlocking (and after a wrong password) no stored settings are loaded and
nothing readable is left in browser storage. Requires Playwright Chromium:

    python tests/e2e_agenda_view_sync.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

PASSWORD = "e2e-agenda-view-sync-12"
WRONG = "e2e-agenda-view-wrong-99"

UNLOCKED_JS = (
    "() => !!(window.NotesStore && NotesStore.isUnlocked()"
    " && document.body.classList.contains('unlocked'))"
)
ACTIVE_VIEW_JS = (
    "() => document.querySelector('.agenda-seg.is-active[data-agenda-view]')"
    "?.getAttribute('data-agenda-view') || ''"
)
STORAGE_JS = (
    "() => JSON.stringify([Object.entries(localStorage),"
    " Object.entries(sessionStorage), document.cookie])"
)


def register(page, base, email):
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


def open_agenda(page):
    page.click("#app-tab-agenda")
    page.wait_for_selector(".agenda-seg[data-agenda-view]", timeout=30000)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-agenda-view-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    email = f"agenda-view-{int(time.time())}@home.local"
    try:
        with sync_playwright() as p:
            # Playwright's bundled Chromium by default; E2E_CHROMIUM=/usr/bin/chromium overrides.
            exe = os.environ.get("E2E_CHROMIUM") or None
            browser = p.chromium.launch(headless=True, executable_path=exe, args=["--no-sandbox"])
            ctx_a = browser.new_context(viewport={"width": 1280, "height": 900})
            page = ctx_a.new_page()
            register(page, base, email)
            open_agenda(page)
            page.click('.agenda-seg[data-agenda-view="3day"]')
            assert page.evaluate(ACTIVE_VIEW_JS) == "3day"
            page.wait_for_timeout(1500)
            page.evaluate("() => NotesStore.sync({ full: true })")
            stored = page.evaluate(STORAGE_JS)
            assert "3day" not in stored and "agendaView" not in stored, stored

            # Reload: before unlocking, no stored settings are loaded or shown.
            page.goto(f"{base}/app", wait_until="domcontentloaded")
            page.wait_for_function(
                "() => !!document.getElementById('unlock-screen') || NotesStore.isUnlocked()",
                timeout=60000,
            )
            if not page.evaluate("() => NotesStore.isUnlocked()"):
                page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
                assert page.evaluate("() => NotesUiSettings.get('agendaView')") is None
                assert "3day" not in page.evaluate(STORAGE_JS)
                # Wrong password: still locked, still no settings.
                page.fill("#unlock-password", WRONG)
                page.click("#unlock-submit")
                page.wait_for_function(
                    "() => document.getElementById('unlock-submit').textContent === 'Unlock'",
                    timeout=180000,
                )
                assert not page.evaluate("() => NotesStore.isUnlocked()")
                assert page.evaluate("() => NotesUiSettings.get('agendaView')") is None
                assert "3day" not in page.evaluate(STORAGE_JS)
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
            open_agenda(page)
            assert page.evaluate(ACTIVE_VIEW_JS) == "3day", "view lost after reload + unlock"

            # Another device: new empty browser context, log in.
            ctx_b = browser.new_context(viewport={"width": 1280, "height": 900})
            other = ctx_b.new_page()
            other.goto(f"{base}/login", wait_until="domcontentloaded")
            other.fill('#login-form [name="email"]', email)
            other.fill("#login-password", PASSWORD)
            other.click("#login-submit")
            other.wait_for_function(UNLOCKED_JS, timeout=180000)
            other.wait_for_timeout(2000)
            open_agenda(other)
            assert other.evaluate(ACTIVE_VIEW_JS) == "3day", "view not synced to a new device"
            browser.close()
        print("e2e_agenda_view_sync ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
