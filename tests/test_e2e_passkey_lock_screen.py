"""Unlock the vault with a passkey from the lock screen (docs/VAULT_RECOVERY.md 1.4, 3.1).

Real server and Chromium with a virtual PRF authenticator. The button only shows when
a passkey has a vault copy; the passkey opens the vault and the notes are readable;
cancelling falls back to the master password without losing anything; a password
change after a passkey unlock uses the account's KDF, so the new password opens the
vault on a fresh device; a saved device password is not touched by a passkey session.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from test_e2e_passkey_vault_unlock import (  # noqa: E402
    LIST, OPEN_SETTINGS_JS, SERVER_PRELUDE, _add_authenticator,
)

NEW_PASSWORD = "e2e-new-vault-password-34"
TITLE = "Passkey lock screen note"
BUTTON = "#unlock-passkey"

ADD_NOTE_JS = """async (title) => {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, title_manual: true, content: title + ' body' });
  await NotesStore.flush();
  return id;
}"""
NOTE_TEXT_JS = """(id) => { const n = NotesStore.get(id); return n && n.content ? n.content.content : null; }"""


def _lock_screen(page):
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#unlock-password", state="visible", timeout=60000)


class PasskeyLockScreenE2E(unittest.TestCase):
    def setUp(self):
        from playwright.sync_api import sync_playwright

        self.root = Path(tempfile.mkdtemp(prefix="e2e-passkey-lock-"))
        port = free_port()
        self.base = f"http://e2e.localhost:{port}"
        self.proc = start_server(self.root, port, {
            "NOTES_WEBAUTHN_RP_ID": "e2e.localhost", "NOTES_WEBAUTHN_ORIGIN": self.base,
            "NOTES_PUBLIC_HOST": "e2e.localhost", "NOTES_DEFAULT_PLAN": "pro",
            "NOTES_AUTH_RATE_LIMIT": "200", "NOTES_AUTH_RATE_LIMIT_WAN": "200",
        }, prelude=SERVER_PRELUDE)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.addCleanup(self._stop_server)
        self.pw = sync_playwright().start()
        self.addCleanup(self.pw.stop)
        self.browser = launch(self.pw)
        self.addCleanup(self.browser.close)

    def _stop_server(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except Exception:
            self.proc.kill()

    def _device(self):
        page = self.browser.new_context(viewport={"width": 1280, "height": 860}).new_page()
        _add_authenticator(page, prf=True)
        return page

    def _signed_in_device(self, *, unlock_on: bool):
        page = self._device()
        email = register(page, self.base)
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector("#btn-add-passkey", state="visible")
        if unlock_on:
            page.check("#passkey-add-unlock")
        page.click("#btn-add-passkey")
        page.wait_for_selector(f"{LIST} .passkey-row")
        if unlock_on:
            page.wait_for_selector(f"{LIST} .passkey-unlock-status[data-unlock-state='on']")
        return page, email

    def _unlock_with_password(self, page, password=PASSWORD):
        page.fill("#unlock-password", password)
        page.click("#unlock-submit")
        page.wait_for_function(UNLOCKED_JS, timeout=120000)

    def test_button_only_shows_with_a_vault_copy(self):
        page = self._device()
        register(page, self.base)
        _lock_screen(page)
        self.assertFalse(page.is_visible(BUTTON), "no passkey at all")
        self._unlock_with_password(page)
        # A passkey for sign-in only has no vault copy.
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector("#btn-add-passkey", state="visible")
        page.click("#btn-add-passkey")
        page.wait_for_selector(f"{LIST} .passkey-row")
        _lock_screen(page)
        self.assertFalse(page.is_visible(BUTTON), "passkey without vault copy")
        self._unlock_with_password(page)
        # Turning vault unlock on shows the button; turning it off hides it again.
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector(f"{LIST} .passkey-row")
        page.click(f"{LIST} .passkey-unlock-toggle")
        page.wait_for_selector(f"{LIST} .passkey-unlock-status[data-unlock-state='on']")
        _lock_screen(page)
        page.wait_for_selector(BUTTON, state="visible")
        self._unlock_with_password(page)
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector(f"{LIST} .passkey-row")
        page.click(f"{LIST} .passkey-unlock-toggle")
        page.wait_for_selector(f"{LIST} .passkey-unlock-status[data-unlock-state='off']")
        _lock_screen(page)
        self.assertFalse(page.is_visible(BUTTON))

    def test_passkey_unlocks_and_cancel_falls_back_to_password(self):
        page, _email = self._signed_in_device(unlock_on=True)
        note_id = page.evaluate(ADD_NOTE_JS, TITLE)
        _lock_screen(page)
        page.wait_for_selector(BUTTON, state="visible")
        # Cancelled prompt: still locked, a message, password field ready, nothing lost.
        page.evaluate("""() => {
          window.__realGet = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
        }""")
        page.click(BUTTON)
        page.wait_for_selector("#unlock-error:not([hidden])")
        self.assertIn("master password", page.text_content("#unlock-error"))
        self.assertFalse(page.evaluate("() => NotesStore.isUnlocked()"))
        self.assertTrue(page.is_enabled(BUTTON))
        self.assertTrue(page.is_visible("#unlock-password"))
        page.evaluate("() => { navigator.credentials.get = window.__realGet; }")
        # The passkey now answers: the vault opens without a password and the note reads back.
        page.click(BUTTON)
        page.wait_for_function(UNLOCKED_JS, timeout=120000)
        self.assertEqual(page.evaluate(NOTE_TEXT_JS, note_id), TITLE + " body")
        state = page.evaluate("""async () => {
          const acct = await NotesStore.api('/api/account');
          return { kdf: NotesStore.state.kdfVersion, server: acct.vault_kdf_version,
                   passkey: NotesStore.isPasskeySession(), verified: NotesStore.isKeyVerified(),
                   password: NotesVaultSecrets.getVaultPassword() };
        }""")
        self.assertEqual(state["kdf"], state["server"])
        self.assertEqual(state["kdf"], 2)
        self.assertTrue(state["passkey"] and state["verified"])
        self.assertEqual(state["password"], "")
        # Writes work in the passkey session and survive a password unlock afterwards.
        page.evaluate("""async (id) => {
          const n = NotesStore.get(id);
          NotesStore.upsert(id, { ...n.content, content: 'edited after passkey unlock' });
          await NotesStore.flush();
        }""", note_id)
        _lock_screen(page)
        self._unlock_with_password(page)
        self.assertEqual(page.evaluate(NOTE_TEXT_JS, note_id), "edited after passkey unlock")

    def test_password_change_after_passkey_unlock_opens_on_a_fresh_device(self):
        page, email = self._signed_in_device(unlock_on=True)
        note_id = page.evaluate(ADD_NOTE_JS, TITLE)
        _lock_screen(page)
        page.wait_for_selector(BUTTON, state="visible")
        page.click(BUTTON)
        page.wait_for_function(UNLOCKED_JS, timeout=120000)
        self.assertTrue(page.evaluate("() => NotesStore.isPasskeySession()"))
        result = page.evaluate(
            """async ([a, b]) => {
              try { await NotesStore.changePassword(a, b); return { ok: true, kdf: NotesStore.state.kdfVersion }; }
              catch (err) { return { ok: false, message: err.message }; }
            }""",
            [PASSWORD, NEW_PASSWORD],
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["kdf"], 2, "new vault key derived with the account's Argon2id")
        fresh = self._device()
        fresh.goto(f"{self.base}/login", wait_until="domcontentloaded")
        fresh.fill('form#login-form input[name="email"]', email)
        fresh.fill("#login-password", NEW_PASSWORD)
        fresh.click("#login-submit")
        fresh.wait_for_url("**/app*", timeout=60000)
        fresh.wait_for_function(
            """() => (window.NotesStore && NotesStore.isUnlocked())
              || (document.getElementById('unlock-password')?.getClientRects().length || 0) > 0""",
            timeout=120000,
        )
        if not fresh.evaluate("() => NotesStore.isUnlocked()"):
            self._unlock_with_password(fresh, NEW_PASSWORD)
        fresh.wait_for_function(UNLOCKED_JS, timeout=120000)
        fresh.wait_for_function("(id) => !!NotesStore.get(id)", arg=note_id, timeout=60000)
        self.assertEqual(fresh.evaluate(NOTE_TEXT_JS, note_id), TITLE + " body")

    def test_passkey_session_does_not_erase_a_saved_device_password(self):
        page, _email = self._signed_in_device(unlock_on=True)
        _lock_screen(page)
        page.wait_for_selector(BUTTON, state="visible")
        page.click(BUTTON)
        page.wait_for_function(UNLOCKED_JS, timeout=120000)
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector("#pref-remember-device", state="attached")
        saved_before = page.evaluate("() => Object.keys(localStorage).filter((k) => /device/i.test(k) && /enc|password/i.test(k)).length")
        page.evaluate("() => { const box = document.getElementById('pref-remember-device'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }")
        page.wait_for_function("() => /opened the vault with a passkey/.test(document.getElementById('toast')?.textContent || '')")
        saved_after = page.evaluate("() => Object.keys(localStorage).filter((k) => /device/i.test(k) && /enc|password/i.test(k)).length")
        self.assertEqual(saved_before, saved_after)
        self.assertEqual(page.evaluate("() => NotesVaultSecrets.getVaultPassword()"), "")


if __name__ == "__main__":
    unittest.main()
