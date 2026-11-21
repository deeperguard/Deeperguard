"""E2E: unlock shows elapsed seconds while deriving; a failed or overdue
derivation frees the button with a message while the vault stays locked; and a
retry in the same page, while the abandoned Argon2id run would still be busy,
opens a vault that stays open and can save.

    python tests/e2e_unlock_derive_progress.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_recovery_key_step import complete_recovery_key_step
from e2e_signup_autounlock import PASSWORD, free_port, start_server

# Counts real Worker.terminate() calls so the test can see that an overdue
# derivation is stopped instead of left running in the worker.
TERMINATE_COUNTER_JS = """
(() => {
  window.__workerTerminations = 0;
  const orig = Worker.prototype.terminate;
  Worker.prototype.terminate = function () {
    window.__workerTerminations += 1;
    return orig.call(this);
  };
})();
"""


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
        "() => location.pathname === '/app' && window.NotesStore && window.NotesStore.isUnlocked()"
        " && document.body.classList.contains('unlocked')",
        timeout=120000,
    )
    complete_recovery_key_step(page)


def _lock_and_reload(page):
    page.evaluate("() => document.getElementById('btn-lock-now').click()")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="visible", timeout=60000)


def _unlock_click(page, password=PASSWORD):
    page.fill("#unlock-password", password)
    page.click("#unlock-submit")


def _wait_unlocked(page):
    page.wait_for_function(
        "() => window.NotesStore.isUnlocked() && document.body.classList.contains('unlocked')",
        timeout=60000,
    )


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
            context = browser.new_context()
            # Keep the test off the network (Cloudflare Turnstile and the like).
            context.route(
                "**/*",
                lambda route: route.continue_() if route.request.url.startswith(base) else route.abort("failed"),
            )
            context.add_init_script(TERMINATE_COUNTER_JS)
            page = context.new_page()
            _register(page, base, f"unlock-derive-{int(time.time())}@home.local")
            page.evaluate(
                """() => NotesStore.upsert(crypto.randomUUID(),
                     { ...NotesStore.defaultNote(), title: 'Before reload', content: 'x', attachments: [] })"""
            )
            page.evaluate("() => NotesStore.flush()")

            # 1. After a reload the real derivation shows elapsed seconds climbing.
            _lock_and_reload(page)
            _unlock_click(page)
            page.wait_for_function(
                "() => /^Deriving key… [1-9][0-9]* s$/.test(document.getElementById('unlock-status').textContent)",
                timeout=30000,
            )
            assert page.inner_text("#unlock-submit") == "Checking…"
            assert page.evaluate("() => document.getElementById('unlock-submit').disabled")
            _wait_unlocked(page)

            # 2. A failing derivation frees the button; the vault stays locked.
            _lock_and_reload(page)
            page.evaluate(
                "() => { NotesStore.unlock = async () => { throw new Error('Simulated derivation failure'); }; }"
            )
            _unlock_click(page)
            _assert_released(page, "Simulated derivation failure")

            # 3. An overdue real derivation (wrong password, so its key would
            # differ) is cancelled and its worker terminated. A retry in the same
            # page starts at once; the abandoned run must not lock or re-key the
            # vault afterwards.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
            # A slow device: the wrong-password run answers 6 s after the real
            # derivation, i.e. after the retry below has opened the vault.
            page.evaluate(
                """() => {
                  window.__notesUnlockDeriveTimeoutMs = 700;
                  const late = (fn) => async (password, ...rest) => {
                    const out = await fn(password, ...rest);
                    if (password === 'not-the-vault-password') {
                      await new Promise((r) => setTimeout(r, 6000));
                    }
                    return out;
                  };
                  NotesCrypto.deriveKeyInWorker = late(NotesCrypto.deriveKeyInWorker.bind(NotesCrypto));
                  NotesCrypto.deriveKey = late(NotesCrypto.deriveKey.bind(NotesCrypto));
                }"""
            )
            terminated_before = page.evaluate("() => window.__workerTerminations")
            _unlock_click(page, "not-the-vault-password")
            _assert_released(page, "took too long")
            assert page.evaluate("() => window.__workerTerminations") > terminated_before, "worker not terminated"
            page.evaluate("() => { delete window.__notesUnlockDeriveTimeoutMs; }")
            _unlock_click(page)
            _wait_unlocked(page)
            epoch = page.evaluate("() => NotesStore.state.lockEpoch")
            # Compared inside the page only; the key never leaves it.
            page.evaluate("() => { window.__keyAfterRetry = NotesStore.vaultKeyCopy().raw.join(','); }")
            # Well past the time the abandoned derivation would have needed.
            page.wait_for_timeout(12000)
            assert page.evaluate("() => NotesStore.isUnlocked()"), "vault locked by the abandoned attempt"
            assert page.evaluate("() => NotesStore.state.lockEpoch") == epoch
            assert page.evaluate(
                "() => NotesStore.vaultKeyCopy().raw.join(',') === window.__keyAfterRetry"
            ), "vault key replaced by the abandoned attempt"
            assert page.evaluate("() => document.body.classList.contains('unlocked')")
            # The vault is usable: a new note saves and syncs, and the old note decrypted.
            result = page.evaluate(
                """async () => {
                  NotesStore.upsert(crypto.randomUUID(),
                    { ...NotesStore.defaultNote(), title: 'After retry', content: 'y', attachments: [] });
                  await NotesStore.flush();
                  await NotesStore.sync();
                  return {
                    titles: NotesStore.listNotes().map((n) => n.content.title),
                    unsynced: NotesStore.state.dirty.size,
                  };
                }"""
            )
            assert "Before reload" in result["titles"] and "After retry" in result["titles"], result
            assert result["unsynced"] == 0, result
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
