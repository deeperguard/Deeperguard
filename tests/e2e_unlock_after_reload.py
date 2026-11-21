"""E2E: unlock after a page reload either finishes in bounded time or fails
cleanly.

1. Register, lock, reload, unlock with the real crypto worker: the vault opens
   within UNLOCK_BOUND_S and the button no longer shows 'Checking…'.
2. Lock, reload, crash the crypto worker on its derive request and make the
   main-thread fallback derivation fail: the button is clickable again ('Unlock') and
   #unlock-error shows a message while the vault stays locked.

    python tests/e2e_unlock_after_reload.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server
from e2e_unlock_derive_progress import _lock_and_reload, _register

# docs/UNLOCK_TIMING.md: slowest measured unlock after reload was 5.9 s
# (click to unlocked); a single run of this test took 9.7-15.4 s. 45 s leaves
# room for a loaded test machine while still catching a hang (the app's own
# deadline is 300 s).
UNLOCK_BOUND_S = 45


def _button_state(page):
    return page.evaluate(
        """() => {
          const b = document.getElementById('unlock-submit');
          return { text: b.textContent, disabled: b.disabled, busy: b.getAttribute('aria-busy') };
        }"""
    )


def main() -> int:
    from playwright.sync_api import sync_playwright

    root = Path(tempfile.mkdtemp(prefix="e2e-unlock-reload-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context()
                # Keep the test off the network (Cloudflare Turnstile and the like).
                context.route(
                    "**/*",
                    lambda route: route.continue_() if route.request.url.startswith(base) else route.abort("failed"),
                )
                page = context.new_page()
                _register(page, base, f"unlock-reload-{int(time.time())}@home.local")

                # 1. Unlock after reload finishes within the bound; 'Checking…' goes away.
                _lock_and_reload(page)
                page.fill("#unlock-password", PASSWORD)
                started = time.perf_counter()
                page.click("#unlock-submit")
                page.wait_for_function(
                    "() => document.getElementById('unlock-submit').textContent === 'Checking…'",
                    timeout=5000,
                )
                page.wait_for_function(
                    "() => window.NotesStore.isUnlocked() && document.body.classList.contains('unlocked')",
                    timeout=UNLOCK_BOUND_S * 1000,
                )
                elapsed = time.perf_counter() - started
                assert elapsed < UNLOCK_BOUND_S, elapsed
                state = _button_state(page)
                assert state["text"] != "Checking…", state
                assert state["busy"] != "true", state
                assert "Deriving key" not in page.inner_text("#unlock-status"), page.inner_text("#unlock-status")
                assert page.is_hidden("#unlock-submit"), "lock screen still visible after unlock"
                print(f"unlock after reload: {elapsed:.1f} s")

                # 2. Derivation fails: the crypto worker crashes on the derive
                # request (its script comes from the service worker cache, so a
                # network route would not reach it) and the main-thread
                # fallback throws as well.
                _lock_and_reload(page)
                page.evaluate(
                    """() => {
                      window.__workerCrashes = 0;
                      window.__origWorkerPost = Worker.prototype.postMessage;
                      Worker.prototype.postMessage = function () {
                        window.__workerCrashes += 1;
                        setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'blocked' })), 0);
                      };
                      window.__origDeriveKey = NotesCrypto.deriveKey;
                      NotesCrypto.deriveKey = async () => { throw new Error('Simulated derivation failure'); };
                    }"""
                )
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
                page.wait_for_function(
                    "() => { const b = document.getElementById('unlock-submit');"
                    " return !b.disabled && b.textContent === 'Unlock'; }",
                    timeout=UNLOCK_BOUND_S * 1000,
                )
                assert page.evaluate("() => window.__workerCrashes") > 0, "crypto worker was never asked to derive"
                state = _button_state(page)
                assert state["busy"] != "true", state
                assert page.is_visible("#unlock-error"), "no error shown"
                err = page.inner_text("#unlock-error").strip()
                assert err, "empty unlock error"
                assert page.evaluate("() => window.NotesStore.isUnlocked()") is False
                assert page.evaluate("() => document.body.classList.contains('unlocked')") is False
                print(f"failed derivation message: {err}")

                # The freed button really works: with the failure lifted the
                # same page unlocks on the next click.
                page.evaluate(
                    """() => {
                      Worker.prototype.postMessage = window.__origWorkerPost;
                      NotesCrypto.deriveKey = window.__origDeriveKey;
                    }"""
                )
                page.fill("#unlock-password", PASSWORD)
                page.click("#unlock-submit")
                page.wait_for_function(
                    "() => window.NotesStore.isUnlocked() && document.body.classList.contains('unlocked')",
                    timeout=UNLOCK_BOUND_S * 1000,
                )
            finally:
                browser.close()
        print("e2e_unlock_after_reload ok")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
