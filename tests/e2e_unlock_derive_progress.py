"""E2E: unlock shows elapsed seconds while deriving, and a failed or stuck
derivation frees the button with a message while the vault stays locked."""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_recovery_key_step import complete_recovery_key_step
from e2e_signup_autounlock import PASSWORD, free_port, start_server


def _register(page, base, email):
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
    page.wait_for_function(
        "() => location.pathname === '/app' && window.NotesStore && window.NotesStore.isUnlocked() && document.body.classList.contains('unlocked')",
        timeout=120000,
    )
    complete_recovery_key_step(page)


def _lock_and_reload(page):
    page.evaluate("() => document.getElementById('btn-lock-now').click()")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="visible", timeout=60000)


def _unlock_click(page):
    page.fill("#unlock-password", PASSWORD)
    page.click("#unlock-submit")


def _assert_released(page, expect_text):
    page.wait_for_function(
        "() => { const b = document.getElementById('unlock-submit');"
        " return !b.disabled && b.textContent === 'Unlock'; }",
        timeout=15000,
    )
    err = page.inner_text("#unlock-error")
    assert expect_text in err, err
    assert page.evaluate("() => window.NotesStore.isUnlocked()") is False
    assert page.evaluate("() => document.body.classList.contains('unlocked')") is False


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-unlock-derive-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
            _register(page, base, f"unlock-derive-{int(time.time())}@home.local")

            # 1. Elapsed seconds climb while the derivation is pending.
            _lock_and_reload(page)
            page.evaluate(
                """() => {
                  const real = window.NotesStore.unlock.bind(window.NotesStore);
                  window.NotesStore.unlock = async (...a) => {
                    await new Promise((r) => setTimeout(r, 3500));
                    return real(...a);
                  };
                }"""
            )
            _unlock_click(page)
            page.wait_for_function(
                "() => /^Deriving key… [2-9] s$/.test(document.getElementById('unlock-status').textContent)",
                timeout=10000,
            )
            assert page.inner_text("#unlock-submit") == "Checking…"
            assert page.evaluate("() => document.getElementById('unlock-submit').disabled")
            page.wait_for_function("() => window.NotesStore.isUnlocked()", timeout=60000)

            # 2. A failing derivation frees the button; vault stays locked.
            _lock_and_reload(page)
            page.evaluate(
                """() => {
                  window.NotesStore.unlock = async () => { throw new Error('Simulated derivation failure'); };
                }"""
            )
            _unlock_click(page)
            _assert_released(page, "Simulated derivation failure")

            # 3. A derivation that never answers is cut off at the deadline,
            # and a late result must not open the vault.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
            page.evaluate(
                """() => {
                  window.__notesUnlockDeriveTimeoutMs = 1500;
                  const real = window.NotesStore.unlock.bind(window.NotesStore);
                  window.NotesStore.unlock = async (...a) => {
                    await new Promise((r) => setTimeout(r, 4000));
                    return real(...a);
                  };
                }"""
            )
            _unlock_click(page)
            _assert_released(page, "took too long")
            page.wait_for_timeout(8000)
            assert page.evaluate("() => window.NotesStore.isUnlocked()") is False

            # 4. Retry works once the derivation is healthy again.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
            _unlock_click(page)
            page.wait_for_function("() => window.NotesStore.isUnlocked()", timeout=60000)
            browser.close()
        print("e2e_unlock_derive_progress ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
