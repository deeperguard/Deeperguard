"""Unlock the vault with a passkey from the lock screen (docs/VAULT_RECOVERY.md 3.7).

Real server and Chromium with a virtual authenticator that supports PRF. Covers: lock, unlock with
the passkey, notes readable before any write; a note written after a passkey unlock reaches a second
device that unlocks with the password; a cancelled passkey falls back to the password without losing
anything; no button without a passkey copy; a password change leaves no usable passkey copy (and a
copy of the earlier key is refused against notes under the new key); a password change made from a
passkey-unlocked session works on a fresh device; offline the passkey route is refused and the
password still works; "remember password" after a passkey unlock keeps the saved password.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from test_e2e_passkey_vault_unlock import (  # noqa: E402
    LIST, OPEN_SETTINGS_JS, SERVER_PRELUDE, UI_TIMEOUT_MS, _add_authenticator, _track_requests,
)

UNLOCKED = """() => !!(window.NotesStore && NotesStore.isUnlocked()
  && document.body.classList.contains('unlocked'))"""
BUTTON = "#unlock-passkey"
NEW_PASSWORD = "A-brand-new-password-77"
CREATE_NOTE_JS = """async ([title, text]) => {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, content: text });
  await NotesStore.flush();
  return id;
}"""
READ_NOTES_JS = "() => NotesStore.listNotes().map((n) => [(n.content || n).title, (n.content || n).content])"


class PasskeyLockScreenUnlockE2E(unittest.TestCase):
    def _run(self, body, *, with_passkey=True):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-passkey-lock-"))
        port = free_port()
        base = f"http://e2e.localhost:{port}"
        proc = start_server(root, port, {
            "NOTES_WEBAUTHN_RP_ID": "e2e.localhost", "NOTES_WEBAUTHN_ORIGIN": base,
            "NOTES_PUBLIC_HOST": "e2e.localhost", "NOTES_DEFAULT_PLAN": "pro",
        }, prelude=SERVER_PRELUDE)
        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context(viewport={"width": 1280, "height": 860}).new_page()
                page.set_default_timeout(UI_TIMEOUT_MS)
                self.pending = _track_requests(page)
                _add_authenticator(page, prf=True)
                email = register(page, base)
                if with_passkey:
                    self._enable_passkey_unlock(page)
                body(browser, page, base, email)
                browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            shutil.rmtree(root, ignore_errors=True)

    def _settle(self, page):
        quiet = 0
        for _ in range(400):
            quiet = quiet + 1 if not self.pending else 0
            if quiet >= 4:
                return
            page.wait_for_timeout(50)

    def _enable_passkey_unlock(self, page):
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector("#btn-add-passkey", state="visible")
        self._settle(page)
        page.check("#passkey-add-unlock")
        page.click("#btn-add-passkey")
        page.wait_for_selector(f"{LIST} .passkey-row .passkey-unlock-status[data-unlock-state='on']")
        self._settle(page)

    def _lock_screen(self, page):
        """Lock by reloading: the vault key and password live only in memory."""
        self._settle(page)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#unlock-password", state="visible")

    def _sign_in_fresh(self, browser, base, email, password):
        page = browser.new_context().new_page()
        page.set_default_timeout(UI_TIMEOUT_MS)
        page.goto(f"{base}/login", wait_until="domcontentloaded")
        page.fill('form#login-form input[name="email"]', email)
        page.fill("#login-password", password)
        page.click("#login-submit")
        page.wait_for_url("**/app*")
        page.wait_for_function(UNLOCKED)
        return page

    def test_passkey_unlock_reads_notes_then_writes_reach_second_device(self):
        def body(browser, page, base, email):
            page.evaluate(CREATE_NOTE_JS, ["Before lock", "old secret"])
            self._lock_screen(page)
            page.wait_for_selector(BUTTON, state="visible")
            self.assertEqual(page.evaluate("() => NotesStore.isUnlocked()"), False)
            page.click(BUTTON)
            page.wait_for_function(UNLOCKED)
            state = page.evaluate("""() => ({
              verified: NotesStore.isKeyVerified(), source: NotesStore.state.keySource,
              kdf: NotesStore.state.kdfVersion, accountKdf: Number(NotesStore.cachedAccount().vault_kdf_version),
              notes: NotesStore.listNotes().map((n) => (n.content || n).title),
            })""")
            # Existing notes decrypted (the key is proven) and the KDF version is the account's, not 1.
            self.assertTrue(state["verified"])
            self.assertEqual(state["source"], "passkey")
            self.assertEqual(state["kdf"], state["accountKdf"])
            self.assertEqual(state["kdf"], 2)
            self.assertIn("Before lock", state["notes"])
            # A note written now reaches a device that only knows the password.
            page.evaluate(CREATE_NOTE_JS, ["After passkey", "new secret"])
            self._settle(page)
            other = self._sign_in_fresh(browser, base, email, PASSWORD)
            other.wait_for_function(
                "() => NotesStore.listNotes().some((n) => (n.content || n).title === 'After passkey')")
            notes = dict(other.evaluate(READ_NOTES_JS))
            self.assertEqual(notes["After passkey"], "new secret")
            self.assertEqual(notes["Before lock"], "old secret")

        self._run(body)

    def test_cancelled_passkey_falls_back_to_password_without_data_loss(self):
        def body(browser, page, base, email):
            page.evaluate(CREATE_NOTE_JS, ["Keep me", "kept text"])
            self._lock_screen(page)
            page.wait_for_selector(BUTTON, state="visible")
            page.evaluate("""() => { navigator.credentials.get = () => Promise.reject(
              new DOMException('cancelled', 'NotAllowedError')); }""")
            page.click(BUTTON)
            page.wait_for_selector("#unlock-error:not([hidden])")
            self.assertIn("master password", page.text_content("#unlock-error"))
            self.assertFalse(page.evaluate("() => NotesStore.isUnlocked()"))
            self.assertTrue(page.is_visible("#unlock-password"))
            self.assertTrue(page.is_visible(BUTTON))  # a cancel is not a stale copy: try again later
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED)
            self.assertEqual(dict(page.evaluate(READ_NOTES_JS))["Keep me"], "kept text")

        self._run(body)

    def test_offline_passkey_unlock_is_refused_and_password_still_works(self):
        def body(browser, page, base, email):
            page.evaluate(CREATE_NOTE_JS, ["Offline note", "offline text"])
            self._lock_screen(page)
            page.wait_for_selector(BUTTON, state="visible")
            page.context.set_offline(True)
            page.click(BUTTON)
            page.wait_for_selector("#unlock-error:not([hidden])")
            self.assertIn("master password", page.text_content("#unlock-error"))
            self.assertFalse(page.evaluate("() => NotesStore.isUnlocked() || NotesStore.isKeyVerified()"))
            # A passkey attempt never marks offline unlock as working on this device.
            self.assertIsNone(page.evaluate("() => localStorage.getItem('notes_offline_unlock_verified')"))
            self.assertTrue(page.is_visible("#unlock-password"))
            page.context.set_offline(False)
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED)
            self.assertEqual(dict(page.evaluate(READ_NOTES_JS))["Offline note"], "offline text")

        self._run(body)

    def test_remember_device_after_passkey_unlock_keeps_the_saved_password(self):
        saved = "() => NotesVaultSecrets.loadDevicePassword()"
        toggle = """(on) => { const el = document.getElementById('pref-remember-device');
          el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }"""

        def lock_now():
            # A reload would unlock again with the remembered password; lock from Settings instead.
            self._settle(page)
            page.evaluate("() => document.getElementById('btn-lock-now').click()")
            page.wait_for_selector("#unlock-password", state="visible")

        def body(browser, page_, base, email):
            nonlocal page
            page = page_
            page.evaluate(OPEN_SETTINGS_JS)
            page.wait_for_selector("#pref-remember-device", state="attached")
            page.evaluate(toggle, True)
            page.wait_for_function(f"async () => (await ({saved})()) === {PASSWORD!r}")
            lock_now()
            page.wait_for_selector(BUTTON, state="visible")
            page.click(BUTTON)
            page.wait_for_function(UNLOCKED)
            self.assertEqual(page.evaluate("() => NotesStore.state.keySource"), "passkey")
            # Turning it on again in a session without a password leaves the saved one in place.
            page.evaluate(toggle, True)
            page.wait_for_timeout(300)
            self.assertEqual(page.evaluate(saved), PASSWORD)
            # Off clears it; on again cannot save a password the session does not have, and says so.
            page.evaluate(toggle, False)
            page.wait_for_function(f"async () => (await ({saved})()) === ''")
            page.evaluate(toggle, True)
            page.wait_for_function(
                "() => /saved the next time you unlock/.test(document.getElementById('toast').textContent)")
            self.assertEqual(page.evaluate(saved), "")
            # The next password unlock saves it.
            lock_now()
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED)
            page.wait_for_function(f"async () => (await ({saved})()) === {PASSWORD!r}")

        page = None
        self._run(body)

    def test_no_button_without_a_passkey_copy(self):
        def body(browser, page, base, email):
            self._lock_screen(page)
            self._settle(page)
            page.wait_for_timeout(500)
            self.assertTrue(page.is_hidden(BUTTON))
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED)

        self._run(body, with_passkey=False)

    def test_password_change_removes_passkey_copy_and_old_key_is_refused(self):
        def body(browser, page, base, email):
            page.evaluate(CREATE_NOTE_JS, ["Before change", "text"])
            self._lock_screen(page)
            page.wait_for_selector(BUTTON, state="visible")
            page.click(BUTTON)
            page.wait_for_function(UNLOCKED)
            old = page.evaluate("""async () => {
              const status = await NotesStore.api('/api/account/vault-keys');
              return { id: status.key_id, raw: Array.from(NotesStore.vaultKeyCopy().raw) };
            }""")
            self.assertTrue(old["id"])
            # Password change from the passkey-unlocked session: the new key uses the account's KDF.
            page.evaluate("([a, b]) => NotesStore.changePassword(a, b)", [PASSWORD, NEW_PASSWORD])
            self._settle(page)
            status = page.evaluate("() => NotesStore.api('/api/account/vault-keys')")
            self.assertEqual((status["key_id"], status["prf"]), ("", []))
            self._lock_screen(page)
            page.wait_for_timeout(500)
            self.assertTrue(page.is_hidden(BUTTON))
            # Even if the old copy were still around: the old key cannot open notes under the new key.
            result = page.evaluate("""async ([raw, id]) => {
              try {
                await NotesStore.unlockWithVaultKey({ raw: new Uint8Array(raw) },
                  { wrapKeyId: id, accountKeyId: id, kdfVersion: 2, salt: NotesStore.cachedAccount().kdf_salt });
                return 'opened';
              } catch (err) { return err.code; }
            }""", [old["raw"], old["id"]])
            self.assertEqual(result, "VAULT_KEY_STALE")
            self.assertFalse(page.evaluate("() => NotesStore.isUnlocked() || NotesStore.isKeyVerified()"))
            # The new password opens everything, on a fresh device and on this one.
            other = self._sign_in_fresh(browser, base, email, NEW_PASSWORD)
            other.wait_for_function(
                "() => NotesStore.listNotes().some((n) => (n.content || n).title === 'Before change')")
            page.fill("#unlock-password", NEW_PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED)
            self.assertIn("Before change", [t for t, _ in page.evaluate(READ_NOTES_JS)])

        self._run(body)


if __name__ == "__main__":
    unittest.main()
