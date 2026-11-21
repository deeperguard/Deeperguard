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

    # POST /api/account/password with vault_keys, and the schema-header refusal (3.5, 6.2) -----

    def _prove(self, email, password, csrf, header):
        h = {"X-CSRF-Token": csrf}
        chal = self.client.post("/api/account/password/challenge", json={}, headers=h).get_json()
        a_hex, m1 = r63.srp_client_proof(email, password, chal["srp_salt"], chal["B"], chal.get("srp_kdf_version"))
        if header:
            h["X-DG-Vault-Schema"] = "1"
        return self.client.post("/api/account/password/prove", json={"A": a_hex, "M1": m1}, headers=h)

    @staticmethod
    def _wrap_bodies(kid, cid=None):
        rb = rec._body(0, kid)
        recovery = {k: rb[k] for k in ("key_id", "wrap_version", "recovery_salt", "wrap", "proof_hash")}
        keys = {"key_id": kid, "recovery": recovery}
        if cid:
            pb = prf._prf_body(0, kid)
            keys["prf"] = [{"credential_id": cid, **{k: pb[k] for k in ("key_id", "wrap_version", "prf_salt", "wrap")}}]
        return keys

    def test_prove_refuses_without_schema_header_when_wraps_exist(self):
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        resp = self._prove(email, password, csrf, header=False)
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.get_json()["code"], "vault_keys_need_update")
        self.assertNotIn("rotation_token", resp.get_json())
        ok = self._prove(email, password, csrf, header=True)
        self.assertEqual(ok.status_code, 200, ok.get_json())
        self.assertTrue(ok.get_json()["rotation_token"])

    def test_prove_with_only_a_passkey_wrap_is_also_refused_without_header(self):
        uid, email, password, csrf = self._signed_in()
        cid = self._passkey(uid)
        self.assertEqual(
            self._put_prf(email, password, csrf, cid, prf._prf_body(0, secrets.token_hex(16))).status_code, 200,
        )
        self.assertEqual(self._prove(email, password, csrf, header=False).status_code, 409)

    def test_prove_without_wraps_needs_no_header(self):
        uid, email, password, csrf = self._signed_in()
        resp = self._prove(email, password, csrf, header=False)
        self.assertEqual(resp.status_code, 200, resp.get_json())

    def test_password_change_with_vault_keys_stores_new_wraps_atomically(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        other = self._passkey(uid)
        before = self._user(uid)
        new_kid = secrets.token_hex(16)
        keys = self._wrap_bodies(new_kid, cid=other)
        resp = self._change_password(email, password, "another-vault-password-1", csrf, vault_keys=keys)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        user = self._user(uid)
        self.assertEqual(user["vault_key_id"], new_kid)
        self.assertEqual(user["vault_key_rev"], before["vault_key_rev"] + 1)
        self.assertEqual(user["vault_keys_invalidated_at"], 0)
        self.assertEqual(self._wrap_counts(uid), (1, 1))
        status = self._status()
        self.assertTrue(status["recovery"]["active"])
        self.assertEqual([p["credential_id"] for p in status["prf"]], [other])
        self.assertTrue(status["prf"][0]["current"])
        import db as notes_db

        conn = notes_db.connection()
        self.assertEqual(
            {r[0] for r in conn.execute("SELECT key_id FROM vault_recovery_wraps WHERE user_id = ?", (uid,))}
            | {r[0] for r in conn.execute("SELECT key_id FROM vault_prf_wraps WHERE user_id = ?", (uid,))},
            {new_kid},
        )
        mail.assert_not_called()

    def test_password_change_without_new_recovery_copy_sets_marker(self):
        mail = self._with_mail()
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        new_kid = secrets.token_hex(16)
        keys = self._wrap_bodies(new_kid)
        del keys["recovery"]
        keys["prf"] = self._wrap_bodies(new_kid, cid=self._passkey(uid))["prf"]
        resp = self._change_password(email, password, "another-vault-password-1", csrf, vault_keys=keys)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        user = self._user(uid)
        self.assertEqual(self._wrap_counts(uid), (0, 1))
        self.assertEqual(user["vault_key_id"], new_kid)
        self.assertEqual(user["vault_keys_invalidated_at"], resp.get_json()["password_changed_at"])
        self.assertEqual(mail.call_count, 1)

    def test_password_change_with_empty_vault_keys_clears_key_id(self):
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        resp = self._change_password(
            email, password, "another-vault-password-1", csrf, vault_keys={"key_id": secrets.token_hex(16)},
        )
        self.assertEqual(resp.status_code, 200, resp.get_json())
        user = self._user(uid)
        self.assertEqual(self._wrap_counts(uid), (0, 0))
        self.assertEqual(user["vault_key_id"], "")
        self.assertGreater(user["vault_keys_invalidated_at"], 0)

    def test_wrong_key_id_in_a_wrap_is_rejected_and_nothing_changes(self):
        uid, email, password, csrf = self._signed_in()
        old_kid = self._enrol_both(email, password, csrf, uid)
        before = self._user(uid)
        keys = self._wrap_bodies(secrets.token_hex(16))
        keys["recovery"]["key_id"] = old_kid
        resp = self._change_password(email, password, "another-vault-password-1", csrf, vault_keys=keys)
        self.assertEqual(resp.status_code, 400, resp.get_json())
        after = self._user(uid)
        self.assertEqual(after, before)
        self.assertEqual(self._wrap_counts(uid), (1, 1))
        # The old password still works: no verifier was written.
        self.assertEqual(self._prove(email, password, csrf, header=True).status_code, 200)

    def test_foreign_credential_rolls_back_the_whole_change(self):
        uid, email, password, csrf = self._signed_in()
        self._enrol_both(email, password, csrf, uid)
        before = self._user(uid)
        keys = self._wrap_bodies(secrets.token_hex(16), cid="not-my-credential")
        resp = self._change_password(email, password, "another-vault-password-1", csrf, vault_keys=keys)
        self.assertEqual(resp.status_code, 400, resp.get_json())
        self.assertEqual(self._user(uid), before)
        self.assertEqual(self._wrap_counts(uid), (1, 1))


if __name__ == "__main__":
    unittest.main()
