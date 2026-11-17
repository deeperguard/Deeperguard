"""E2E (Playwright, Chromium): forgot the vault password, recover with the recovery key.

Registers an account, stores a note, creates a recovery key (the way the client crypto
does), then on the login screen uses "Forgot your vault password?", recovers on the
unlock screen, signs in with the new password and checks that the note is readable,
that the old recovery key no longer works and that a wrong key changes nothing.

    python tests/e2e_vault_recovery_key.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

NEW_PASSWORD = "brand-new-vault-pass-77"
NOTE_TITLE = "Recovery e2e secret note"

ENROLL_JS = """async ([email, password]) => {
  const csrf = NotesStore.state.csrf || sessionStorage.getItem('notes_csrf');
  const rk = NotesCrypto.generateRecoveryKey();
  const salt = NotesCrypto.generateRecoverySalt();
  const proof = NotesCrypto.hkdfSha256(rk, salt, 'deeperguard/recovery-proof/v1', 32);
  // The first SRP proof right after registering can answer 401 once (docs/VAULT_RECOVERY.md 0.1),
  // and the prove token lives in the session cookie, which a concurrent sync response can
  // overwrite; so prove + PUT is retried as a unit.
  let last = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const status = await (await fetch('/api/account/vault-keys')).json();
      const proved = await NotesSrpAuth.vaultKeysProve(email, password);
      const wrap = await NotesCrypto.wrapVaultKey(
        NotesStore.state.cryptoKey, NotesCrypto.deriveRecoveryWrapKey(rk, salt),
        { accountId: status.account_id, type: 'recovery' });
      const res = await fetch('/api/account/vault-keys/recovery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          token: proved.token, expected_key_rev: status.key_rev, key_id: wrap.key_id,
          wrap_version: wrap.wrap_version, recovery_salt: NotesCrypto.b64(salt), wrap: wrap.blob,
          proof_hash: await NotesCrypto.hashBytes(proof),
        }),
      });
      if (res.ok) return NotesCrypto.encodeRecoveryKey(rk);
      last = res.status + ' ' + await res.text();
    } catch (err) { last = String(err.message || err); }
  }
  throw new Error('enroll failed: ' + last);
}"""

WAIT_UNLOCKED = """() => window.NotesStore && NotesStore.isUnlocked && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked')"""


def dismiss_security_notice(page):
    """Enrolling the recovery key bumps auth_security_at; this device shows the notice once."""
    notice = page.locator("#auth-security-notice-ack")
    try:
        notice.wait_for(state="visible", timeout=5000)
        notice.click()
    except Exception:
        pass


def login(page, base, email, password):
    page.goto(f"{base}/login", wait_until="domcontentloaded")
    page.fill('form#login-form input[name="email"]', email)
    page.fill("#login-password", password)
    page.click("#login-submit")


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0

    root = Path(tempfile.mkdtemp(prefix="e2e-recovery-key-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    try:
        email = f"recovery-key-{int(time.time())}@home.local"
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context().new_page()
            page.goto(f"{base}/register", wait_until="domcontentloaded")
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
            page.wait_for_function(WAIT_UNLOCKED, timeout=120000)

            page.evaluate(
                """async (title) => {
                  NotesStore.upsert(crypto.randomUUID(),
                    { ...NotesStore.defaultNote(), title, title_manual: true, content: title });
                  await NotesStore.flush();
                }""",
                NOTE_TITLE,
            )
            old_key = page.evaluate(ENROLL_JS, [email, PASSWORD])

            # Forgot password: the login screen offers the recovery key.
            page.goto(f"{base}/login", wait_until="domcontentloaded")
            page.click("#login-toggle-recoverkey")
            page.fill('form#login-form input[name="email"]', email)
            page.fill("#login-recovery-key", old_key)
            page.click("#login-recoverkey-submit")
            page.wait_for_url("**/app", timeout=30000)
            page.wait_for_selector("#recover-form:not([hidden])", timeout=30000)
            assert page.input_value("#recover-key") == old_key

            # A wrong (but well-formed) key is refused with a clear message and changes nothing.
            wrong = page.evaluate(
                "() => NotesCrypto.encodeRecoveryKey(NotesCrypto.generateRecoveryKey())")
            dismiss_security_notice(page)
            page.fill("#recover-key", wrong)
            page.fill("#recover-new", NEW_PASSWORD)
            page.fill("#recover-new2", NEW_PASSWORD)
            page.click("#recover-submit")
            page.wait_for_selector("#recover-error:not([hidden])", timeout=30000)
            assert "does not open this vault" in page.inner_text("#recover-error")
            assert "Nothing was changed" in page.inner_text("#recover-error")
            # A mistyped key is caught by its check characters.
            page.fill("#recover-key", old_key[:-1] + ("0" if old_key[-1] != "0" else "1"))
            page.click("#recover-submit")
            page.wait_for_function(
                "() => /not a valid recovery key/.test(document.getElementById('recover-error').textContent)")

            # The right key: new key shown, confirmation required before anything is changed.
            page.fill("#recover-key", old_key)
            page.click("#recover-submit")
            page.wait_for_selector("#recover-step-show:not([hidden])", timeout=60000)
            new_key = page.inner_text("#recover-newkey").strip()
            assert new_key and new_key != old_key
            assert page.is_disabled("#recover-finish")
            page.check("#recover-stored")
            page.click("#recover-finish")
            page.wait_for_selector("#recover-step-done:not([hidden])", timeout=120000)

            # Sign in with the new password; the note is readable.
            page.click("#recover-done")
            page.wait_for_selector("#unlock-password", state="visible", timeout=30000)
            page.fill("#unlock-password", NEW_PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(WAIT_UNLOCKED, timeout=120000)
            page.wait_for_function(
                "(t) => NotesStore.listNotes().some((n) => n.content && n.content.title === t)",
                arg=NOTE_TITLE, timeout=30000)

            # The old password no longer signs in; the new one does from a fresh context.
            fresh = browser.new_context().new_page()
            login(fresh, base, email, PASSWORD)
            fresh.wait_for_selector("#login-error:not([hidden])", timeout=60000)
            login(fresh, base, email, NEW_PASSWORD)
            fresh.wait_for_url("**/app", timeout=60000)

            # The old recovery key is invalid now: the server holds only the new wrap.
            fresh.wait_for_function(WAIT_UNLOCKED, timeout=120000)
            result = fresh.evaluate(
                """async (text) => {
                  try {
                    await NotesStore.recoverWithRecoveryKey(text, 'another-pass-1234',
                      { confirmNewKey: async () => { throw new Error('must not be asked'); } });
                    return 'recovered';
                  } catch (err) { return err.code + ': ' + err.message; }
                }""",
                old_key,
            )
            assert result.startswith("RECOVERY_KEY_WRONG"), result
            browser.close()
        print("e2e_vault_recovery_key ok", email)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
