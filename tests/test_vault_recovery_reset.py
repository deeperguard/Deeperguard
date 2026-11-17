"""Recovery with the recovery key: start, attempt limit, atomic commit (docs/VAULT_RECOVERY.md 3.2-3.3)."""
from __future__ import annotations

import base64
import hashlib
import secrets
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import test_round63_security as r63  # noqa: E402
import test_vault_recovery_wraps as wraps  # noqa: E402

START = "/api/account/vault-keys/recover/start"
COMMIT = "/api/account/vault-keys/recover/commit"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


class VaultRecoveryResetTests(unittest.TestCase):
    # Reuse the fixtures and helpers of the earlier tests without inheriting their test methods.
    tearDown = r63.Round63SecurityTests.tearDown
    _csrf = r63.Round63SecurityTests._csrf
    _srp_pair = r63.Round63SecurityTests._srp_pair
    _create_srp_user = r63.Round63SecurityTests._create_srp_user
    _login = r63.Round63SecurityTests._login
    _signed_in = wraps.VaultRecoveryWrapTests._signed_in
    _token = wraps.VaultRecoveryWrapTests._token
    _put = wraps.VaultRecoveryWrapTests._put
    _status = wraps.VaultRecoveryWrapTests._status

    def setUp(self):
        r63.Round63SecurityTests.setUp(self)
        self.mail = self._mail()

    def _mail(self):
        """Capture notice mails instead of talking to SMTP."""
        patcher = mock.patch.object(self.app_mod, "send_plain_email")
        self.addCleanup(patcher.stop)
        return patcher.start()

    def _enrolled(self):
        """Signed-in account with a recovery wrap: (uid, email, password, csrf, proof, key_id)."""
        uid, email, password, csrf = self._signed_in()
        proof = secrets.token_bytes(32)
        key_id = secrets.token_hex(16)
        resp = self._put(
            email, password, csrf,
            wraps._body(0, key_id, proof_hash=hashlib.sha256(proof).hexdigest()),
        )
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return uid, email, password, csrf, proof, key_id

    def _commit_body(self, proof: bytes, email: str, new_password: str, from_key_id: str, rev: int = 1):
        salt, verifier = self._srp_pair(email, new_password)
        return {
            "proof": proof.hex(),
            "expected_key_rev": rev,
            "from_key_id": from_key_id,
            "to_key_id": secrets.token_hex(16),
            "srp_salt": salt,
            "srp_verifier": verifier,
            "srp_kdf_version": 2,
            "new_recovery": {
                "recovery_salt": _b64(secrets.token_bytes(16)),
                "wrap": {"v": 2, "iv": _b64(secrets.token_bytes(12)), "data": _b64(secrets.token_bytes(48))},
                "wrap_version": 1,
                "proof_hash": hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
            },
        }

    def _commit(self, csrf, body):
        return self.client.post(COMMIT, json=body, headers={"X-CSRF-Token": csrf})

    def _other_session(self, email, password):
        main = self.client
        self.client = self.app_mod.app.test_client()
        self.client.environ_base["HTTP_X_DEVICE_ID"] = "d" * 32
        self.client.environ_base["HTTP_USER_AGENT"] = "Mozilla/5.0 (X11; Linux) Firefox/130.0"
        try:
            self.assertEqual(self._login(email, password).status_code, 200)
            return self.client
        finally:
            self.client = main

    def _row(self, uid):
        import db as notes_db

        conn = notes_db.connection()
        return (
            dict(conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()),
            dict(conn.execute("SELECT * FROM vault_recovery_wraps WHERE user_id = ?", (uid,)).fetchone()),
        )

    def test_start_returns_wrap_but_never_the_proof_hash(self):
        _, _, _, csrf, _, key_id = self._enrolled()
        resp = self.client.post(START, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual((data["key_id"], data["key_rev"], data["wrap_version"]), (key_id, 1, 1))
        self.assertEqual(set(data["wrap"]), {"v", "iv", "data"})
        self.assertNotIn("proof_hash", data)
        self.assertEqual(resp.headers["Cache-Control"], "no-store")

    def test_start_without_recovery_key_is_404(self):
        _, _, _, csrf = self._signed_in()
        resp = self.client.post(START, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual((resp.status_code, resp.get_json()["error"]), (404, "no_recovery_key"))

    def test_start_and_commit_need_a_session(self):
        self.assertEqual(self.client.post(START, json={}).status_code, 401)
        self.assertEqual(self.client.post(COMMIT, json={}).status_code, 401)

    def test_successful_recovery_replaces_verifier_wrap_and_recovery_in_one_commit(self):
        uid, email, old_pw, csrf, proof, key_id = self._enrolled()
        before_user, before_wrap = self._row(uid)
        body = self._commit_body(proof, email, "brand-new-password-1", key_id)
        resp = self._commit(csrf, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        out = resp.get_json()
        self.assertEqual((out["key_rev"], out["key_id"]), (2, body["to_key_id"]))
        user, wrap = self._row(uid)
        self.assertEqual((user["srp_salt"], user["srp_verifier"]), (body["srp_salt"], body["srp_verifier"]))
        self.assertNotEqual(user["srp_verifier"], before_user["srp_verifier"])
        self.assertEqual((user["vault_key_id"], user["vault_key_rev"]), (body["to_key_id"], 2))
        self.assertGreater(user["password_changed_at"] or 0, before_user["password_changed_at"] or 0)
        self.assertEqual(wrap["key_id"], body["to_key_id"])
        self.assertEqual(wrap["proof_hash"], body["new_recovery"]["proof_hash"])
        self.assertEqual(wrap["recovery_salt"], body["new_recovery"]["recovery_salt"])
        self.assertNotEqual(wrap["wrap"], before_wrap["wrap"])
        # The new password signs in, the old one no longer does.
        self.client = self.app_mod.app.test_client()
        self.assertEqual(self._login(email, "brand-new-password-1").status_code, 200)
        self.client = self.app_mod.app.test_client()
        self.assertNotEqual(self._login(email, old_pw).status_code, 200)

    def test_spent_recovery_key_fails_afterwards(self):
        _, email, _, csrf, proof, key_id = self._enrolled()
        body = self._commit_body(proof, email, "brand-new-password-1", key_id)
        self.assertEqual(self._commit(csrf, body).status_code, 200)
        again = self._commit(csrf, self._commit_body(proof, email, "another-password-22", body["to_key_id"], rev=2))
        self.assertEqual(again.status_code, 403)

    def test_other_sessions_are_revoked_and_an_event_is_recorded(self):
        import db as notes_db

        uid, email, password, csrf, proof, key_id = self._enrolled()
        other = self._other_session(email, password)
        self.assertEqual(other.get("/api/account").status_code, 200)
        conn = notes_db.connection()
        before = conn.execute("SELECT auth_security_at FROM users WHERE id = ?", (uid,)).fetchone()[0]
        resp = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(other.get("/api/account").status_code, 401)
        self.assertEqual(self.client.get("/api/account").status_code, 200)
        events = conn.execute("SELECT kind FROM vault_recovery_events WHERE user_id = ?", (uid,)).fetchall()
        self.assertEqual([e["kind"] for e in events], ["recovery_key_used"])
        after = conn.execute("SELECT auth_security_at FROM users WHERE id = ?", (uid,)).fetchone()[0]
        self.assertGreater(after, before)
        reasons = [r[0] for r in conn.execute(
            "SELECT revoke_reason FROM user_sessions WHERE user_id = ? AND revoked_at > 0", (uid,),
        )]
        self.assertEqual(reasons, ["vault-recovery"])
        self.mail.assert_called_once()
        self.assertEqual(self.mail.call_args.args[0], email)
        self.assertNotIn(proof.hex(), self.mail.call_args.args[2])

    def test_attempts_are_refused_after_the_limit_even_with_the_right_proof(self):
        import vault_keys

        uid, email, _, csrf, proof, key_id = self._enrolled()
        wrong = secrets.token_bytes(32)
        for i in range(vault_keys.RECOVERY_MAX_FAILED - 1):
            resp = self._commit(csrf, self._commit_body(wrong, email, "brand-new-password-1", key_id))
            self.assertEqual(resp.status_code, 403, i)
        last = self._commit(csrf, self._commit_body(wrong, email, "brand-new-password-1", key_id))
        self.assertEqual(last.status_code, 429)
        self.assertGreaterEqual(last.get_json()["retry_after"], vault_keys.RECOVERY_LOCK_BASE_SECONDS - 1)
        good = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(good.status_code, 429)
        self.assertEqual(self.client.post(START, json={}, headers={"X-CSRF-Token": csrf}).status_code, 429)
        user, _ = self._row(uid)
        self.assertEqual((user["vault_key_id"], user["vault_key_rev"]), (key_id, 1))
        self.assertGreater(self._status()["recovery_locked_until"], 0)

    def test_lock_expires_doubles_next_round_and_success_resets(self):
        import db as notes_db
        import vault_keys

        uid, email, _, csrf, proof, key_id = self._enrolled()
        wrong = secrets.token_bytes(32)
        conn = notes_db.connection()

        def exhaust():
            for _ in range(vault_keys.RECOVERY_MAX_FAILED):
                last = self._commit(csrf, self._commit_body(wrong, email, "brand-new-password-1", key_id))
            return last

        def unlock():
            conn.execute("UPDATE users SET recovery_locked_until = 1 WHERE id = ?", (uid,))
            conn.commit()

        self.assertEqual(exhaust().status_code, 429)
        unlock()
        second = exhaust()
        self.assertEqual(second.status_code, 429)
        self.assertGreater(second.get_json()["retry_after"], 2 * vault_keys.RECOVERY_LOCK_BASE_SECONDS - 5)
        unlock()
        ok = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(ok.status_code, 200)
        user, _ = self._row(uid)
        self.assertEqual(
            (user["recovery_failed_count"], user["recovery_lock_level"], user["recovery_locked_until"]), (0, 0, 0),
        )

    def test_stale_revision_and_foreign_key_id_change_nothing(self):
        uid, email, _, csrf, proof, key_id = self._enrolled()
        before = self._row(uid)
        stale = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id, rev=0))
        self.assertEqual((stale.status_code, stale.get_json()["error"]), (409, "key_rev_mismatch"))
        foreign = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", secrets.token_hex(16)))
        self.assertEqual((foreign.status_code, foreign.get_json()["error"]), (409, "key_id_mismatch"))
        self.assertEqual(self._row(uid), before)

    def test_failure_midway_leaves_the_old_state_intact(self):
        import db as notes_db

        uid, email, password, csrf, proof, key_id = self._enrolled()
        other = self._other_session(email, password)
        before = self._row(uid)
        conn = notes_db.connection()
        conn.execute(
            "CREATE TRIGGER boom BEFORE INSERT ON vault_recovery_events "
            "BEGIN SELECT RAISE(ABORT, 'boom'); END"
        )
        conn.commit()
        body = self._commit_body(proof, email, "brand-new-password-1", key_id)
        args = dict(
            proof=body["proof"], expected_key_rev=1, from_key_id=key_id, to_key_id=body["to_key_id"],
            srp_salt=body["srp_salt"], srp_verifier=body["srp_verifier"],
            recovery_salt=body["new_recovery"]["recovery_salt"], wrap_json="{}", wrap_version=1,
            proof_hash=body["new_recovery"]["proof_hash"],
        )
        with self.assertRaises(Exception):
            notes_db.commit_vault_recovery(uid, **args)
        self.assertEqual(self._row(uid), before)
        self.assertEqual(other.get("/api/account").status_code, 200)
        conn.execute("DROP TRIGGER boom")
        conn.commit()
        self.assertEqual(notes_db.commit_vault_recovery(uid, **args)[0], "ok")

    def test_rejects_clear_key_fields_and_bad_shapes(self):
        uid, email, _, csrf, proof, key_id = self._enrolled()
        good = self._commit_body(proof, email, "brand-new-password-1", key_id)
        for over in (
            {"recovery_key": "ABCD"}, {"proof": "zz"}, {"srp_kdf_version": 1},
            {"to_key_id": "nope"}, {"new_recovery": {**good["new_recovery"], "wrap": {"v": 2}}},
        ):
            self.assertEqual(self._commit(csrf, {**good, **over}).status_code, 400, over)
        self.assertEqual(self._row(uid)[0]["vault_key_id"], key_id)

    def test_commit_needs_csrf(self):
        _, email, _, _, proof, key_id = self._enrolled()
        resp = self.client.post(COMMIT, json=self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
