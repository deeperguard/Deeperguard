"""A vault KDF upgrade or an old-client password change makes the vault key new: the wraps of
the old key are dropped with the version update, the marker is set and the owner is told
(docs/VAULT_RECOVERY.md 3.6, 6.2, 6.4)."""
from __future__ import annotations

import secrets
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import test_round63_security as r63  # noqa: E402
import test_vault_prf_wraps as prf  # noqa: E402
import test_vault_recovery_interrupted as interrupted  # noqa: E402
import test_vault_recovery_wraps as rec  # noqa: E402

KDF = "/api/account/vault-kdf"


class VaultKdfWrapTests(unittest.TestCase):
    setUp = r63.Round63SecurityTests.setUp
    tearDown = r63.Round63SecurityTests.tearDown
    _csrf = r63.Round63SecurityTests._csrf
    _srp_pair = r63.Round63SecurityTests._srp_pair
    _create_srp_user = r63.Round63SecurityTests._create_srp_user
    _login = r63.Round63SecurityTests._login
    _signed_in = rec.VaultRecoveryWrapTests._signed_in
    _token = rec.VaultRecoveryWrapTests._token
    _put = rec.VaultRecoveryWrapTests._put
    _status = rec.VaultRecoveryWrapTests._status
    _passkey = prf.VaultPrfWrapTests._passkey
    _put_prf = prf.VaultPrfWrapTests._put_prf
    _change_password = interrupted.InterruptedMigrationTests._change_password

    def _with_mail(self):
        patcher = mock.patch.object(self.app_mod, "send_plain_email")
        self.addCleanup(patcher.stop)
        return patcher.start()

    def _signed_in_v1(self):
        """Signed-in account whose vault key still uses the first key derivation."""
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        with notes_db.tx() as conn:
            conn.execute("UPDATE users SET vault_kdf_version = 1 WHERE id = ?", (uid,))
        return uid, email, password, csrf

    def _user(self, uid):
        import db as notes_db

        return dict(notes_db.connection().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())

    def _wrap_counts(self, uid):
        import db as notes_db

        conn = notes_db.connection()
        return tuple(
            conn.execute(f"SELECT COUNT(*) FROM {t} WHERE user_id = ?", (uid,)).fetchone()[0]
            for t in ("vault_recovery_wraps", "vault_prf_wraps")
        )

    def _enrol_both(self, email, password, csrf, uid):
        kid = secrets.token_hex(16)
        self.assertEqual(self._put(email, password, csrf, rec._body(0, kid)).status_code, 200)
        cid = self._passkey(uid)
        resp = self._put_prf(email, password, csrf, cid, prf._prf_body(1, kid))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(self._wrap_counts(uid), (1, 1))
        return kid

    def _upgrade(self, csrf):
        return self.client.post(KDF, json={"vault_kdf_version": 2}, headers={"X-CSRF-Token": csrf})

    def test_upgrade_with_wraps_drops_them_atomically_and_notifies(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in_v1()
        self._enrol_both(email, password, csrf, uid)
        before = self._user(uid)
        self.assertEqual(before["vault_kdf_version"], 1)
        self.assertEqual(before["vault_keys_invalidated_at"], 0)

        resp = self._upgrade(csrf)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["vault_kdf_version"], 2)

        after = self._user(uid)
        self.assertEqual(after["vault_kdf_version"], 2)
        self.assertEqual(self._wrap_counts(uid), (0, 0))
        self.assertEqual(after["vault_key_id"], "")
        self.assertEqual(after["vault_key_rev"], before["vault_key_rev"] + 1)
        self.assertGreater(after["vault_keys_invalidated_at"], 0)
        self.assertEqual(after["auth_security_at"], after["vault_keys_invalidated_at"])
        self.assertEqual(resp.get_json()["auth_security_at"], after["vault_keys_invalidated_at"])
        status = self._status()
        self.assertEqual(status["invalidated_at"], after["vault_keys_invalidated_at"])
        self.assertEqual((status["invalidated_prf"], status["prf"], status["recovery"]["active"]), (1, [], False))
        self.assertEqual(mail.call_count, 1)
        self.assertEqual(mail.call_args.args[0], email)
        self.assertIn("recovery key was removed", mail.call_args.args[1])
        # The key id is free again: a new recovery key for the new vault key can be stored,
        # and that clears the marker.
        new_kid = secrets.token_hex(16)
        put = self._put(email, password, csrf, rec._body(status["key_rev"], new_kid))
        self.assertEqual(put.status_code, 200, put.get_json())
        status = self._status()
        self.assertEqual((status["invalidated_at"], status["invalidated_prf"], status["key_id"]), (0, 0, new_kid))

        # The same request again changes nothing and sends nothing.
        again = self._upgrade(csrf)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(mail.call_count, 1)
        self.assertEqual(self._wrap_counts(uid), (1, 0))

    def test_upgrade_with_only_a_recovery_wrap_reports_no_passkey_removal(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in_v1()
        self.assertEqual(self._put(email, password, csrf, rec._body(0, secrets.token_hex(16))).status_code, 200)
        self.assertEqual(self._upgrade(csrf).status_code, 200)
        status = self._status()
        self.assertGreater(status["invalidated_at"], 0)
        self.assertEqual(status["invalidated_prf"], 0)
        self.assertEqual(mail.call_count, 1)

    def test_upgrade_without_wraps_changes_nothing_else_and_sends_no_notice(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in_v1()
        before = self._user(uid)
        resp = self._upgrade(csrf)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json(), {"ok": True, "vault_kdf_version": 2})
        after = self._user(uid)
        changed = {k for k in before if before[k] != after[k]}
        self.assertEqual(changed, {"vault_kdf_version", "updated_at"})
        self.assertEqual(after["vault_keys_invalidated_at"], 0)
        self.assertEqual(self._status()["invalidated_at"], 0)
        mail.assert_not_called()

    def test_old_client_password_change_sets_marker_and_notifies(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        resp = self._change_password(email, password, "another-vault-password-1", csrf)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        user = self._user(uid)
        self.assertEqual(self._wrap_counts(uid), (0, 0))
        self.assertEqual(user["vault_key_id"], "")
        self.assertEqual(user["vault_keys_invalidated_at"], resp.get_json()["password_changed_at"])
        self.assertEqual(user["vault_keys_invalidated_prf"], 1)
        self.assertEqual(mail.call_count, 1)

    def test_password_change_without_wraps_sets_no_marker_and_sends_no_mail(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in()
        resp = self._change_password(email, password, "another-vault-password-1", csrf)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(self._user(uid)["vault_keys_invalidated_at"], 0)
        mail.assert_not_called()


if __name__ == "__main__":
    unittest.main()
