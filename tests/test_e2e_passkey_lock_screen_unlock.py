"""Unlock the vault with a passkey on the lock screen (docs/VAULT_RECOVERY.md 3.1).

Real server and Chromium with a virtual authenticator that supports PRF. The user locks the
vault and opens it again with the passkey alone, without typing the vault password, and the
notes read back. A cancelled passkey prompt leaves the password form working and loses
nothing. Without a passkey that holds a vault copy there is no passkey button.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import UNLOCKED_JS, launch, note_titles, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from test_e2e_passkey_vault_unlock import (  # noqa: E402
    OPEN_SETTINGS_JS, SERVER_PRELUDE, _add_authenticator,
)

NOTE_TITLE = "Passkey lock screen note"
NOTE_BODY = "secret body of the note"
LOCK_JS = """() => {
  const btn = [document.getElementById('btn-lock-head'), document.getElementById('btn-lock-nav')]
    .find((b) => b && b.getClientRects().length);
  btn.click();
}"""
CANCEL_ONCE_JS = """() => {
  const real = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.get = () => {
    navigator.credentials.get = real;
    return Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
  };
}"""
BUTTON = "#unlock-passkey"


class PasskeyLockScreenE2E(unittest.TestCase):
    def _run(self, body):
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
                _add_authenticator(page, prf=True)
                register(page, base)
                page.click("body")
                page.keyboard.press("Control+Shift+K")
                page.wait_for_selector("#quick-capture:not([hidden])", timeout=30000)
                page.fill("#quick-capture-text", f"{NOTE_TITLE}\n{NOTE_BODY}")
                page.keyboard.press("Control+Enter")
                page.wait_for_selector("#quick-capture", state="hidden")
                self.assertTrue(any(NOTE_TITLE in t for t in note_titles(page)))
                body(page)
                browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            shutil.rmtree(root, ignore_errors=True)

    def _lock(self, page):
        page.evaluate(LOCK_JS)
        page.wait_for_selector("#unlock-password", state="visible")

    def _open_settings(self, page):
        page.evaluate(OPEN_SETTINGS_JS)
        page.wait_for_selector("#btn-add-passkey", state="visible")

    def _notes_text(self, page) -> str:
        return page.evaluate("() => NotesStore.listNotes().map((n) => JSON.stringify(n.content || n)).join(' ')")

    def test_passkey_unlocks_without_password_and_cancel_falls_back(self):
        def body(page):
            self._open_settings(page)
            page.check("#passkey-add-unlock")
            page.click("#btn-add-passkey")
            page.wait_for_selector("#passkey-list .passkey-unlock-status[data-unlock-state='on']")
            page.keyboard.press("Escape")
            self._lock(page)
            page.wait_for_selector(BUTTON, state="visible")

            # Cancelling the passkey prompt: the vault stays locked, the password form is intact.
            page.evaluate(CANCEL_ONCE_JS)
            page.click(BUTTON)
            page.wait_for_selector("#unlock-error:not([hidden])")
            self.assertIn("cancelled", page.text_content("#unlock-error"))
            self.assertIn("vault password", page.text_content("#unlock-error"))
            self.assertFalse(page.evaluate("() => NotesStore.isUnlocked()"))
            self.assertTrue(page.is_visible("#unlock-password"))
            self.assertTrue(page.is_enabled(BUTTON))

            # Same screen, passkey this time: unlocked with an empty password field.
            self.assertEqual(page.input_value("#unlock-password"), "")
            page.click(BUTTON)
            page.wait_for_function(UNLOCKED_JS, timeout=60000)
            self.assertIn(NOTE_TITLE, note_titles(page))
            self.assertIn(NOTE_BODY, self._notes_text(page))

            # The password still opens the vault after that.
            self._lock(page)
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=60000)
            self.assertIn(NOTE_BODY, self._notes_text(page))

        self._run(body)

    def test_no_passkey_button_without_vault_copy(self):
        def body(page):
            self._lock(page)
            page.wait_for_timeout(1500)
            self.assertFalse(page.is_visible(BUTTON))
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=60000)
            # A passkey that only signs in (no vault copy) does not show the button either.
            self._open_settings(page)
            page.click("#btn-add-passkey")
            page.wait_for_selector("#passkey-list .passkey-row")
            page.keyboard.press("Escape")
            self._lock(page)
            page.wait_for_timeout(1500)
            self.assertFalse(page.is_visible(BUTTON))

        self._run(body)


if __name__ == "__main__":
    unittest.main()
