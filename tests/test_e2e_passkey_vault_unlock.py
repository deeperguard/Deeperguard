"""Vault unlock per passkey in Settings (docs/VAULT_RECOVERY.md 1.4, 3.1, tests E7 and N4).

Real server and Chromium with a virtual authenticator, once with PRF and once
without. A passkey with PRF turns vault unlock on (status visible, one stored
copy that only that passkey's PRF output opens), a passkey without PRF gets an
honest explanation and nothing is stored, and turning it off or removing the
passkey deletes the copy.
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_share_target import launch, register  # noqa: E402
from e2e_signup_autounlock import free_port, start_server  # noqa: E402

LIST = "#passkey-list"
# The installed webauthn package may lack options_to_json_dict (the app imports it); the
# server's own option building and signature checks still run, only the dict conversion is bridged.
SERVER_PRELUDE = """
import json
import webauthn.helpers as _wh
if not hasattr(_wh, "options_to_json_dict"):
    _wh.options_to_json_dict = lambda options: json.loads(_wh.options_to_json(options))

# The app serves plain HTTP only on localhost/127.0.0.1, but passkeys need a dotted host name.
# Behave like the production proxy that terminates TLS: the app sees scheme https, the browser
# talks plain HTTP to a *.localhost name (a secure context) and WebAuthn runs for real.
import app as _app_module
_inner_wsgi = _app_module.app.wsgi_app
_app_module.app.wsgi_app = lambda environ, start: _inner_wsgi({**environ, "wsgi.url_scheme": "https"}, start)
"""
OPEN_SETTINGS_JS ="""() => {
  const btn = [document.getElementById('btn-settings-head'), document.getElementById('btn-settings-nav')]
    .find((b) => b && b.getClientRects().length);
  btn.click();
}"""


def _add_authenticator(page, *, prf: bool):
    cdp = page.context.new_cdp_session(page)
    cdp.send("WebAuthn.enable", {"enableUI": False})
    cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
        "protocol": "ctap2", "ctap2Version": "ctap2_1", "transport": "internal",
        "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True,
        "automaticPresenceSimulation": True, "hasPrf": prf,
    }})
    return cdp


class PasskeyVaultUnlockE2E(unittest.TestCase):
    def _run(self, prf: bool, body):
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="e2e-passkey-unlock-"))
        port = free_port()
        # A dotted *.localhost name: Chromium resolves it to loopback and the app only accepts dotted hosts.
        base = f"http://e2e.localhost:{port}"
        proc = start_server(root, port, {
            "NOTES_WEBAUTHN_RP_ID": "e2e.localhost", "NOTES_WEBAUTHN_ORIGIN": base,
            "NOTES_PUBLIC_HOST": "e2e.localhost", "NOTES_DEFAULT_PLAN": "pro",
        }, prelude=SERVER_PRELUDE)
        db_file = root / "data" / "notes.db"

        def wraps():
            con = sqlite3.connect(db_file)
            try:
                return [r[0] for r in con.execute("SELECT credential_id FROM vault_prf_wraps")]
            finally:
                con.close()

        try:
            with sync_playwright() as p:
                browser = launch(p)
                page = browser.new_context(viewport={"width": 1280, "height": 860}).new_page()
                _add_authenticator(page, prf=prf)
                register(page, base)
                page.evaluate(OPEN_SETTINGS_JS)
                page.wait_for_selector("#btn-add-passkey", state="visible")
                body(page, wraps)
                browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            shutil.rmtree(root, ignore_errors=True)

    def _add_passkey(self, page, *, with_unlock: bool):
        if with_unlock:
            page.check("#passkey-add-unlock")
        page.click("#btn-add-passkey")
        page.wait_for_selector(f"{LIST} .passkey-row")

    def test_passkey_with_prf_turns_vault_unlock_on_and_off(self):
        def body(page, wraps):
            self._add_passkey(page, with_unlock=False)
            row = f"{LIST} .passkey-row"
            self.assertEqual(page.get_attribute(f"{row} .passkey-unlock-status", "data-unlock-state"), "off")
            self.assertEqual(wraps(), [])
            page.click(f"{row} .passkey-unlock-toggle")
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='on']")
            self.assertIn("Vault unlock: on", page.text_content(f"{row} .passkey-unlock-status"))
            self.assertIn("is on", page.text_content("#passkey-unlock-message"))
            stored = wraps()
            self.assertEqual(len(stored), 1)
            self.assertEqual(page.get_attribute(row, "data-credential-id"), stored[0])
            # The stored copy opens with this passkey's PRF output and holds this vault's key.
            same = page.evaluate(
                """async (cid) => {
                  const status = await NotesStore.api('/api/account/vault-keys');
                  const opts = await NotesStore.api(`/api/account/vault-keys/prf/${cid}/options`, { method: 'POST', body: '{}' });
                  const salt = new Uint8Array(NotesWebAuthn.bufferFromBase64url(opts.prf_salt));
                  const publicKey = {
                    ...NotesWebAuthn.prepareAuthenticationOptions(opts.options),
                    userVerification: 'required',
                    extensions: NotesWebAuthn.prfExtension(salt),
                  };
                  const assertion = await navigator.credentials.get({ publicKey });
                  const output = NotesWebAuthn.prfOutputFromCredential(assertion);
                  const copy = await NotesStore.api(`/api/account/vault-keys/prf/${cid}/unwrap`, {
                    method: 'POST',
                    body: JSON.stringify({ credential: NotesWebAuthn.authenticationCredentialJson(assertion) }),
                  });
                  const key = await NotesCrypto.unwrapVaultKey(
                    NotesCrypto.derivePrfWrapKey(output),
                    { wrap_version: copy.wrap_version, key_id: copy.key_id, blob: copy.wrap },
                    { accountId: String(status.account_id), type: 'prf', binding: cid });
                  const vk = NotesStore.vaultKeyCopy();
                  return key.raw.length === 32 && key.raw.every((b, i) => b === vk.raw[i]);
                }""",
                stored[0],
            )
            self.assertTrue(same)
            # Turn it off: the copy is gone, the passkey stays.
            page.click(f"{row} .passkey-unlock-toggle")
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='off']")
            self.assertEqual(wraps(), [])
            self.assertEqual(page.locator(f"{LIST} .passkey-row").count(), 1)
            # Turn it on again, then removing the passkey removes the copy.
            page.click(f"{row} .passkey-unlock-toggle")
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='on']")
            self.assertEqual(len(wraps()), 1)
            page.click(f"{row} >> text=Remove")
            page.wait_for_selector(f"{LIST} .passkey-row", state="detached")
            self.assertEqual(wraps(), [])

        self._run(True, body)

    def test_new_passkey_can_turn_unlock_on_at_registration(self):
        def body(page, wraps):
            self._add_passkey(page, with_unlock=True)
            row = f"{LIST} .passkey-row"
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='on']")
            self.assertEqual(len(wraps()), 1)

        self._run(True, body)

    def test_failed_status_lookup_shows_unknown_not_off(self):
        def body(page, wraps):
            self._add_passkey(page, with_unlock=True)
            row = f"{LIST} .passkey-row"
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='on']")
            page.route("**/api/account/vault-keys", lambda route: route.abort())
            page.evaluate("() => NotesPasskeys.renderPasskeyList(document.getElementById('passkey-list'))")
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='unknown']")
            self.assertIn("status unknown", page.text_content(f"{row} .passkey-unlock-status"))
            self.assertTrue(page.is_disabled(f"{row} .passkey-unlock-toggle"))
            page.unroute("**/api/account/vault-keys")
            page.evaluate("() => NotesPasskeys.renderPasskeyList(document.getElementById('passkey-list'))")
            page.wait_for_selector(f"{row} .passkey-unlock-status[data-unlock-state='on']")

        self._run(True, body)

    def test_passkey_without_prf_explains_and_stores_nothing(self):
        def body(page, wraps):
            self._add_passkey(page, with_unlock=False)
            row = f"{LIST} .passkey-row"
            page.click(f"{row} .passkey-unlock-toggle")
            page.wait_for_selector("#passkey-unlock-message:not([hidden])")
            message = page.text_content("#passkey-unlock-message")
            self.assertIn("cannot open your vault", message)
            self.assertIn("new passkey", message)
            self.assertIn("master password", message)
            self.assertEqual(page.get_attribute(f"{row} .passkey-unlock-status", "data-unlock-state"), "off")
            self.assertEqual(wraps(), [])
            # Same at registration (the authenticator already holds the first passkey, so
            # remove it first): the passkey exists for sign-in, no copy is stored.
            page.click(f"{row} >> text=Remove")
            page.wait_for_selector(f"{LIST} .passkey-row", state="detached")
            page.check("#passkey-add-unlock")
            page.click("#btn-add-passkey")
            page.wait_for_selector(f"{LIST} .passkey-row")
            self.assertIn("cannot open your vault", page.text_content("#passkey-unlock-message"))
            self.assertEqual(wraps(), [])

        self._run(False, body)


if __name__ == "__main__":
    unittest.main()
