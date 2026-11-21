"""Recovery key status and replace action in Settings (docs/VAULT_RECOVERY.md 3.1, 3.4, 4).

Real server and Chromium. One account is registered once; every test starts from a
known state (one active recovery key, vault unlocked and verified, Settings open).
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from e2e_recovery_key_step import DIALOG_OPEN, read_shown_key  # noqa: E402
from e2e_share_target import UNLOCKED_JS, launch, register  # noqa: E402
from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402

PUT_PATH = "/api/account/vault-keys/recovery"
STATUS = "#recovery-key-settings-status"
NOTE = "#recovery-key-settings-note"

UNWRAP_JS = """async ([text, salt, blob, keyId, accountId]) => {
  const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
  const wrap = { wrap_version: 1, key_id: keyId, blob: JSON.parse(blob) };
  try {
    const wk = NotesCrypto.deriveRecoveryWrapKey(NotesCrypto.decodeRecoveryKey(text), saltBytes);
    const vk = await NotesCrypto.unwrapVaultKey(wk, wrap, { accountId, type: 'recovery' });
    return NotesCrypto.vaultKeyId(vk);
  } catch (err) { return 'refused'; }
}"""

# Another device replaces the recovery key between our proof and our save.
COMPETING_WRITE_JS = """async (password) => {
  const C = NotesCrypto;
  const email = localStorage.getItem('notes_email');
  const st = await (await fetch('/api/account/vault-keys', { credentials: 'same-origin' })).json();
  const rk = C.generateRecoveryKey();
  const salt = C.generateRecoverySalt();
  const vk = NotesStore.vaultKeyCopy();
  const wrap = await C.wrapVaultKey(vk, C.deriveRecoveryWrapKey(rk, salt), { accountId: st.account_id, type: 'recovery' });
  const proofHash = await C.hashBytes(C.hkdfSha256(rk, salt, 'deeperguard/recovery-proof/v1', 32));
  const token = (await window.__origProve(email, password)).token;
  let s = ''; salt.forEach((b) => { s += String.fromCharCode(b); });
  const res = await fetch('/api/account/vault-keys/recovery', {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionStorage.getItem('notes_csrf') || '' },
    body: JSON.stringify({
      token, expected_key_rev: st.key_rev, key_id: wrap.key_id, wrap_version: 1,
      recovery_salt: btoa(s), wrap: wrap.blob, proof_hash: proofHash,
      password_changed_at: NotesStore.passwordChangedAck(),
    }),
  });
  return res.status;
}"""

# Background calls (Settings polls /api/account and /api/sessions, sync asks /api/sync/watermark)
# race with the password proof. The session is a cookie that is refreshed on every response, so
# a call answered around the proof drops the proof token: the save then gets 401, proves again
# and sends one PUT too many. Only the vault-keys calls of the dialog itself go through.
HOLD_POLLS_JS = """async () => {
  const orig = window.fetch;
  const gate = { release: null, orig };
  const open = new Promise((resolve) => { gate.release = resolve; });
  const isPoll = (args) => {
    const path = new URL(String((args[0] && args[0].url) || args[0]), location.href).pathname;
    return path.startsWith('/api/') && !path.startsWith('/api/account/vault-keys');
  };
  window.fetch = async (...args) => {
    if (!isPoll(args)) return orig(...args);
    await open;
    return orig(...args);
  };
  window.__pollGate = gate;
}"""
RELEASE_POLLS_JS = """() => {
  const gate = window.__pollGate;
  if (!gate) return;
  window.fetch = gate.orig;
  gate.release();
  window.__pollGate = null;
}"""


class RecoveryKeySettingsE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright

        cls.root = Path(tempfile.mkdtemp(prefix="e2e-recovery-key-settings-"))
        port = free_port()
        cls.base = f"http://127.0.0.1:{port}"
        # Every save proves the password; many tests share this server.
        cls.proc = start_server(cls.root, port, {"NOTES_AUTH_RATE_LIMIT": "400", "NOTES_AUTH_RATE_LIMIT_WAN": "400"})
        cls.db_file = cls.root / "data" / "notes.db"
        cls.pw = sync_playwright().start()
        cls.browser = launch(cls.pw)
        cls.ctx = cls.browser.new_context(viewport={"width": 1280, "height": 900})
        cls.page = cls.ctx.new_page()
        cls.email = register(cls.page, cls.base)
        cls.page.wait_for_timeout(500)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls.pw.stop()
        finally:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=10)
            except Exception:
                cls.proc.kill()
            shutil.rmtree(cls.root, ignore_errors=True)

    # -- helpers ---------------------------------------------------------

    @contextmanager
    def background_polls_held(self):
        """Hold background /api calls until the block ends, so the proof token survives until the save."""
        self.page.evaluate(HOLD_POLLS_JS)
        try:
            # A call sent just before the hold is answered within this time.
            self.page.wait_for_timeout(500)
            yield
        finally:
            self.page.evaluate(RELEASE_POLLS_JS)

    def sql(self, query, args=()):
        con = sqlite3.connect(self.db_file)
        try:
            rows = con.execute(query, args).fetchall()
            con.commit()
            return rows
        finally:
            con.close()

    def wrap_row(self):
        rows = self.sql("SELECT user_id, key_id, recovery_salt, wrap, proof_hash, created_at FROM vault_recovery_wraps")
        return rows[0] if rows else None

    def setUp(self):
        page = self.page
        page.unroute_all()
        page.evaluate("() => { if (window.__origProve) NotesSrpAuth.vaultKeysProve = window.__origProve; }")
        if not page.evaluate("() => !!(window.NotesStore && NotesStore.isUnlocked() && NotesStore.isKeyVerified())"):
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#unlock-password", state="visible", timeout=60000)
            page.fill("#unlock-password", PASSWORD)
            page.click("#unlock-submit")
            page.wait_for_function(UNLOCKED_JS, timeout=120000)
        page.evaluate("() => NotesRecoveryKeySetup.close()")
        page.evaluate("() => { window.__origProve = window.__origProve || NotesSrpAuth.vaultKeysProve; }")
        # Known start: exactly one active recovery key.
        if self.wrap_row() is None:
            self.sql("UPDATE users SET vault_key_id = ''")
            self.put_wrap_from_page()
        self.open_settings()

    def put_wrap_from_page(self):
        """Store an active recovery key the way another device would (not through the dialog)."""
        self.assertEqual(self.page.evaluate(COMPETING_WRITE_JS, PASSWORD), 200)

    def open_settings(self):
        page = self.page
        if not page.is_visible("#recovery-key-settings"):
            page.locator("#btn-settings-head, #btn-settings-nav").locator("visible=true").first.click()
        page.locator("#recovery-key-settings").scroll_into_view_if_needed()
        self.refresh()
        page.wait_for_function(
            "() => /active since/.test(document.getElementById('recovery-key-settings-status').textContent)"
        )

    def refresh(self):
        self.page.evaluate("() => NotesRecoveryKeySetup.refreshSettings()")

    def start_replace(self):
        self.page.click("#btn-recovery-key-regenerate")
        return read_shown_key(self.page)

    def confirm_and_save(self, key, group):
        self.page.check("#recovery-key-stored")
        self.page.fill("#recovery-key-confirm-group", key.split("-")[group - 1])
        self.page.click("#recovery-key-save")

    # -- status and replace ----------------------------------------------

    def test_status_shows_active_and_date_never_the_key(self):
        text = self.page.text_content(STATUS)
        self.assertRegex(text, r"^Recovery key: active since \w+")
        self.assertTrue(self.page.is_visible("#btn-recovery-key-regenerate"))
        self.assertFalse(self.page.is_visible("#btn-recovery-key-create"))
        self.assertTrue(self.page.is_visible("#recovery-key-settings-replace-hint"))
        self.assertIn("not one of the account recovery codes", self.page.text_content("#recovery-key-settings"))
        # The key is not in the page and not in what the status endpoint returns.
        status = self.page.evaluate("async () => JSON.stringify(await (await fetch('/api/account/vault-keys')).json())")
        row = self.wrap_row()
        for secret in (row[3], row[4]):
            self.assertNotIn(secret, status)
        self.assertEqual(self.page.text_content("#recovery-key-value"), "")

    def test_create_button_when_none_and_unavailable_reason_when_unverified(self):
        page = self.page
        self.sql("DELETE FROM vault_recovery_wraps")
        self.refresh()
        page.wait_for_function("() => /not set up/.test(document.getElementById('recovery-key-settings-status').textContent)")
        self.assertTrue(page.is_visible("#btn-recovery-key-create"))
        self.assertFalse(page.is_visible("#btn-recovery-key-regenerate"))
        self.assertTrue(page.is_enabled("#btn-recovery-key-create"))
        # The key in memory is present but has not been verified against data.
        page.evaluate("() => { window.__origVerified = NotesStore.isKeyVerified; NotesStore.isKeyVerified = () => false; }")
        try:
            self.refresh()
            page.wait_for_function("() => !document.getElementById('recovery-key-settings-why').hidden")
            self.assertTrue(page.is_disabled("#btn-recovery-key-create"))
            self.assertIn("not been verified", page.text_content("#recovery-key-settings-why"))
            self.assertEqual(
                page.get_attribute("#btn-recovery-key-create", "aria-describedby"), "recovery-key-settings-why"
            )
            # Even called directly, nothing opens and nothing is stored.
            opened = page.evaluate("() => NotesRecoveryKeySetup.begin(null, false)")
            self.assertFalse(opened)
            self.assertFalse(page.is_visible(DIALOG_OPEN))
            self.assertIn("not been verified", page.text_content(NOTE))
            self.assertIsNone(self.wrap_row())
        finally:
            page.evaluate("() => { NotesStore.isKeyVerified = window.__origVerified; }")
        self.refresh()
        page.wait_for_function("() => document.getElementById('recovery-key-settings-why').hidden")
        # Create from scratch with the same confirmation step.
        page.click("#btn-recovery-key-create")
        self.assertFalse(page.is_visible("#recovery-key-replace-warning"))
        key, group = read_shown_key(page)
        self.confirm_and_save(key, group)
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        page.wait_for_function("() => /active since/.test(document.getElementById('recovery-key-settings-status').textContent)")
        self.assertIsNotNone(self.wrap_row())

    def test_removal_notice_shows_until_a_new_recovery_key_is_created(self):
        page = self.page
        removed = "#recovery-key-settings-removed"
        self.assertFalse(page.is_visible(removed))
        # What a KDF upgrade does to an account with a recovery key and one passkey copy.
        self.sql("DELETE FROM vault_recovery_wraps")
        self.sql(
            "UPDATE users SET vault_key_id = '', vault_keys_invalidated_at = 1760000000, vault_keys_invalidated_prf = 1"
        )
        self.refresh()
        page.wait_for_function("() => !document.getElementById('recovery-key-settings-removed').hidden")
        text = page.text_content(removed)
        self.assertIn("Your recovery key was removed because your vault key changed. Create a new one.", text)
        self.assertIn("Passkey vault unlock was removed", text)
        self.assertTrue(page.is_visible("#btn-recovery-key-create"))
        page.click("#btn-recovery-key-create")
        key, group = read_shown_key(page)
        self.confirm_and_save(key, group)
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        page.wait_for_function("() => /active since/.test(document.getElementById('recovery-key-settings-status').textContent)")
        page.wait_for_function("() => document.getElementById('recovery-key-settings-removed').hidden")
        self.assertEqual(
            self.sql("SELECT vault_keys_invalidated_at, vault_keys_invalidated_prf FROM users"), [(0.0, 0)]
        )

    def test_unverified_key_is_refused_during_save_and_nothing_is_sent(self):
        page = self.page
        puts = []
        page.on("request", lambda r: puts.append(r) if r.method == "PUT" and PUT_PATH in r.url else None)
        before = self.wrap_row()
        key, group = self.start_replace()
        page.evaluate("() => { window.__origVerified = NotesStore.isKeyVerified; NotesStore.isKeyVerified = () => false; }")
        try:
            self.confirm_and_save(key, group)
            page.wait_for_function("() => /not verified/.test(document.getElementById('recovery-key-settings-note').textContent)")
        finally:
            page.evaluate("() => { NotesStore.isKeyVerified = window.__origVerified; }")
        self.assertEqual(puts, [])
        self.assertEqual(self.wrap_row(), before)
        self.assertFalse(page.is_visible(DIALOG_OPEN))

    def test_replace_warns_cancel_keeps_old_key_and_new_key_replaces_it(self):
        page = self.page
        row0 = self.wrap_row()
        # Make a key whose text we know, then replace it.
        key1, group1 = self.start_replace()
        self.assertTrue(page.is_visible("#recovery-key-replace-warning"))
        self.assertIn("stops working", page.text_content("#recovery-key-replace-warning"))
        self.assertTrue(page.is_visible("#recovery-key-cancel"))
        self.confirm_and_save(key1, group1)
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        row1 = self.wrap_row()
        self.assertNotEqual(row1[3], row0[3])
        # Cancel: nothing changes and the key leaves the page.
        key2, _ = self.start_replace()
        page.click("#recovery-key-cancel")
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertEqual(page.text_content("#recovery-key-value"), "")
        self.assertEqual(self.wrap_row(), row1)
        # Escape also cancels a Settings key.
        self.start_replace()
        page.keyboard.press("Escape")
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertEqual(self.wrap_row(), row1)
        # Replace: the previous key stops opening the wrap, the new one opens it.
        key3, group3 = self.start_replace()
        self.assertNotEqual(key3, key1)
        self.confirm_and_save(key3, group3)
        page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        row3 = self.wrap_row()
        self.assertNotEqual(row3[3], row1[3])
        self.assertNotEqual(row3[4], row1[4])
        args = lambda k: [k, row3[2], row3[3], row3[1], str(row3[0])]  # noqa: E731
        client_id = page.evaluate("() => NotesCrypto.vaultKeyId(NotesStore.vaultKeyCopy())")
        self.assertEqual(page.evaluate(UNWRAP_JS, args(key3)), client_id)
        self.assertEqual(page.evaluate(UNWRAP_JS, args(key1)), "refused")
        self.assertEqual(page.evaluate(UNWRAP_JS, args(key2)), "refused")

    # -- conflicts and errors --------------------------------------------

    def test_conflict_with_another_device_overwrites_nothing(self):
        page = self.page
        key, group = self.start_replace()
        page.evaluate(
            """() => {
              const orig = window.__origProve;
              let done = false;
              NotesSrpAuth.vaultKeysProve = async (e, p) => {
                const r = await orig(e, p);
                if (!done) { done = true; window.__competing = await (%s)(p); }
                return r;
              };
            }""" % COMPETING_WRITE_JS
        )
        self.confirm_and_save(key, group)
        page.wait_for_function("() => /another device/.test(document.getElementById('recovery-key-settings-note').textContent)")
        self.assertEqual(page.evaluate("() => window.__competing"), 200)
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertEqual(page.text_content("#recovery-key-value"), "")
        # The other device's key is the one stored: ours did not replace it.
        row = self.wrap_row()
        opens_ours = page.evaluate(UNWRAP_JS, [key, row[2], row[3], row[1], str(row[0])])
        self.assertEqual(opens_ours, "refused")
        self.assertIn("Nothing was overwritten", page.text_content(NOTE))
        self.assertRegex(page.text_content(STATUS), r"active since")

    def test_one_key_rev_conflict_is_retried_once_automatically(self):
        page = self.page
        seen = []

        def handler(route, request):
            if request.method == "PUT":
                seen.append(request.method)
                if len(seen) == 1:
                    route.fulfill(status=409, content_type="application/json",
                                  body=json.dumps({"error": "key_rev_mismatch", "key_rev": 99, "key_id": ""}))
                    return
            route.continue_()

        page.route(f"**{PUT_PATH}", handler)
        before = self.wrap_row()
        with self.background_polls_held():
            key, group = self.start_replace()
            self.confirm_and_save(key, group)
            page.wait_for_selector("#recovery-key-dialog", state="hidden", timeout=60000)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(self.wrap_row()[3], before[3])

    def test_expired_session_on_save_is_not_reported_as_wrong_password(self):
        page = self.page
        page.route(
            f"**{PUT_PATH}",
            lambda route: route.fulfill(status=401, content_type="application/json",
                                        body=json.dumps({"error": "login required"})),
        )
        before = self.wrap_row()
        key, group = self.start_replace()
        self.confirm_and_save(key, group)
        page.wait_for_function("() => !!document.getElementById('recovery-key-error').textContent")
        message = page.text_content("#recovery-key-error")
        self.assertIn("expired", message)
        self.assertNotIn("not right", message)
        self.assertEqual(self.wrap_row(), before)
        self.assertTrue(page.is_visible(DIALOG_OPEN))

    def test_password_field_uses_the_same_autocomplete_as_other_vault_fields(self):
        value = self.page.get_attribute("#recovery-key-password", "autocomplete")
        self.assertEqual(value, self.page.get_attribute("#passkey-vault-password", "autocomplete"))
        self.assertEqual(value, "current-password")

    def test_stale_vault_key_is_refused_by_the_server_without_an_existing_wrap(self):
        page = self.page
        self.sql("DELETE FROM vault_recovery_wraps")
        self.sql("UPDATE users SET vault_key_id = ''")
        self.refresh()
        page.wait_for_function("() => /not set up/.test(document.getElementById('recovery-key-settings-status').textContent)")
        page.click("#btn-recovery-key-create")
        key, group = read_shown_key(page)
        # Another device changed the password after this device derived its key.
        self.sql("UPDATE users SET password_changed_at = password_changed_at + 3600")
        self.confirm_and_save(key, group)
        page.wait_for_function("() => /changed on another device/.test(document.getElementById('recovery-key-settings-note').textContent)")
        self.assertIn("outdated vault key", page.text_content(NOTE))
        self.assertIsNone(self.wrap_row())
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertEqual(page.text_content("#recovery-key-value"), "")
        self.sql("UPDATE users SET password_changed_at = password_changed_at - 3600")

    # -- lock and sign-out -----------------------------------------------

    def test_lock_while_begin_loads_status_opens_nothing(self):
        page = self.page
        before = self.wrap_row()
        page.evaluate(
            """() => {
              const orig = window.fetch;
              window.fetch = async (...args) => {
                const res = await orig(...args);
                if (String(args[0]).includes('/api/account/vault-keys') && ((args[1] && args[1].method) || 'GET') === 'GET') {
                  window.fetch = orig;
                  NotesStore.lock();
                }
                return res;
              };
            }"""
        )
        page.click("#btn-recovery-key-regenerate")
        page.wait_for_function("() => /locked/.test(document.getElementById('recovery-key-settings-note').textContent)")
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertEqual(page.text_content("#recovery-key-value"), "")
        self.assertFalse(page.evaluate("() => NotesRecoveryKeySetup.isOpen()"))
        self.assertEqual(self.wrap_row(), before)

    def test_lock_during_save_aborts_before_anything_is_sent(self):
        page = self.page
        puts = []
        page.on("request", lambda r: puts.append(r) if r.method == "PUT" and PUT_PATH in r.url else None)
        before = self.wrap_row()
        key, group = self.start_replace()
        page.evaluate(
            """() => {
              const orig = window.__origProve;
              NotesSrpAuth.vaultKeysProve = async (e, p) => { const r = await orig(e, p); NotesStore.lock(); return r; };
            }"""
        )
        self.confirm_and_save(key, group)
        page.wait_for_function("() => /locked/.test(document.getElementById('recovery-key-settings-note').textContent)")
        self.assertEqual(puts, [])
        self.assertEqual(self.wrap_row(), before)
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertNotIn(key, page.evaluate("() => document.body.innerText + document.documentElement.innerHTML"))

    def test_pending_key_is_cleared_from_memory_and_screen_on_lock(self):
        page = self.page
        key, _ = self.start_replace()
        held = page.evaluate("() => document.getElementById('recovery-key-value').textContent")
        self.assertEqual(held, key)
        page.evaluate("() => NotesStore.lock()")
        self.assertFalse(page.is_visible(DIALOG_OPEN))
        self.assertFalse(page.evaluate("() => NotesRecoveryKeySetup.isOpen()"))
        html = page.evaluate("() => document.documentElement.innerHTML")
        self.assertNotIn(key, html)
        self.assertNotIn(key.replace("-", ""), html)
        self.assertEqual(page.input_value("#recovery-key-confirm-group"), "")


if __name__ == "__main__":
    unittest.main()
