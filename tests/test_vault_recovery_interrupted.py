"""Interrupted enrolment, two devices at once and old clients (docs/VAULT_RECOVERY.md 5.4, 6.2, 9.6-9.8).

The server never holds a vault key, so "the vault stays readable" is asserted as: the
password still signs in, no wrap points at a key id the account does not use, and the
account state is either unchanged or the complete new state.
"""
from __future__ import annotations

import secrets
import sys
import threading
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from srp_client_proof import srp_client_proof  # noqa: E402
import test_round63_security as r63  # noqa: E402
import test_vault_recovery_reset as reset  # noqa: E402
import test_vault_recovery_wraps as wraps  # noqa: E402

START = "/api/account/vault-keys/recover/start"
PENDING = "/api/account/vault-keys/recover/pending"


class InterruptedMigrationTests(unittest.TestCase):
    setUp = reset.VaultRecoveryResetTests.setUp
    tearDown = r63.Round63SecurityTests.tearDown
    _csrf = r63.Round63SecurityTests._csrf
    _srp_pair = r63.Round63SecurityTests._srp_pair
    _create_srp_user = r63.Round63SecurityTests._create_srp_user
    _login = r63.Round63SecurityTests._login
    _signed_in = wraps.VaultRecoveryWrapTests._signed_in
    _token = wraps.VaultRecoveryWrapTests._token
    _put = wraps.VaultRecoveryWrapTests._put
    _status = wraps.VaultRecoveryWrapTests._status
    _mail = reset.VaultRecoveryResetTests._mail
    _enrolled = reset.VaultRecoveryResetTests._enrolled
    _commit_body = reset.VaultRecoveryResetTests._commit_body
    _commit = reset.VaultRecoveryResetTests._commit

    def _other_session(self, email, password):
        """Sign in as another device (own device id, so the main session stays alive)."""
        main = self.client
        self.client = self.app_mod.app.test_client()
        self.client.environ_base["HTTP_X_DEVICE_ID"] = secrets.token_hex(16)
        self.client.environ_base["HTTP_USER_AGENT"] = "Mozilla/5.0 (X11; Linux) Firefox/130.0"
        try:
            self.assertEqual(self._login(email, password).status_code, 200)
            return self.client
        finally:
            self.client = main

    def _wrap_rows(self, uid):
        import db as notes_db

        conn = notes_db.connection()
        return (
            conn.execute("SELECT * FROM vault_recovery_wraps WHERE user_id = ?", (uid,)).fetchall(),
            conn.execute("SELECT * FROM vault_prf_wraps WHERE user_id = ?", (uid,)).fetchall(),
        )

    def _assert_consistent(self, uid, email, password, sign_in=True):
        """Password still works and every stored wrap belongs to the key id in use."""
        import db as notes_db

        if sign_in:
            self._other_session(email, password)
        key_id = notes_db.connection().execute(
            "SELECT vault_key_id FROM users WHERE id = ?", (uid,),
        ).fetchone()["vault_key_id"]
        rec, prf = self._wrap_rows(uid)
        for row in [*rec, *prf]:
            self.assertEqual(row["key_id"], key_id)
        if not rec and not prf:
            self.assertEqual(key_id, "")

    def _change_password(self, email, password, new_password, csrf, vault_keys=None):
        """SRP prove, then the verifier. Without `vault_keys` this is the late fallback of 6.2
        (an old client whose prove came before a wrap existed); the prove carries the schema header."""
        h = {"X-CSRF-Token": csrf}
        chal = self.client.post("/api/account/password/challenge", json={}, headers=h).get_json()
        a_hex, m1 = srp_client_proof(email, password, chal["srp_salt"], chal["B"], chal.get("srp_kdf_version"))
        prove = self.client.post(
            "/api/account/password/prove", json={"A": a_hex, "M1": m1},
            headers={**h, "X-DG-Vault-Schema": "1"},
        )
        self.assertEqual(prove.status_code, 200, prove.get_json())
        salt, verifier = self._srp_pair(email, new_password)
        body = {"rotation_token": prove.get_json()["rotation_token"], "srp_salt": salt,
                "srp_verifier": verifier, "srp_kdf_version": 2}
        if vault_keys is not None:
            body["vault_keys"] = vault_keys
        return self.client.post("/api/account/password", json=body, headers=h)

    # (a) interrupted migration -------------------------------------------------

    def test_rejected_attempts_leave_no_half_state_and_retry_succeeds(self):
        uid, email, password, csrf = self._signed_in()
        st = self._status()
        self.assertEqual((st["recovery"]["active"], st["key_rev"], st["key_id"]), (False, 0, ""))
        self._assert_consistent(uid, email, password)
        self.assertEqual(self.client.get("/api/account").status_code, 200)
        # A real failed attempt: the client's key_rev is stale, so the server refuses the PUT.
        stale = self._put(email, password, csrf, wraps._body(3, secrets.token_hex(16)))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["error"], "key_rev_mismatch")
        self.assertEqual(self._wrap_rows(uid), ([], []))
        st = self._status()
        self.assertEqual((st["recovery"]["active"], st["key_rev"], st["key_id"]), (False, 0, ""))
        # A rejected attempt (bad shape) is not a half state either.
        bad = self._put(email, password, csrf, wraps._body(0, secrets.token_hex(16), wrap="not-a-wrap"))
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self._wrap_rows(uid), ([], []))
        # The next attempt succeeds.
        resp = self._put(email, password, csrf, wraps._body(0, secrets.token_hex(16)))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertTrue(self._status()["recovery"]["active"])
        self._assert_consistent(uid, email, password)

    def test_enrolment_whose_response_was_lost_is_repeated_without_a_second_row(self):
        uid, email, password, csrf = self._signed_in()
        body = wraps._body(0, secrets.token_hex(16))
        first = self._put(email, password, csrf, body)
        self.assertEqual(first.status_code, 200)
        # The client never saw the answer and sends the identical request again.
        again = self._put(email, password, csrf, body)
        self.assertEqual(again.status_code, 200, again.get_json())
        self.assertEqual(again.get_json()["key_rev"], first.get_json()["key_rev"])
        self.assertEqual(len(self._wrap_rows(uid)[0]), 1)
        self._assert_consistent(uid, email, password)

    def test_recovery_interrupted_after_pending_row_keeps_password_and_old_key_and_can_finish(self):
        uid, email, password, csrf, proof, key_id = self._enrolled()
        to_key = secrets.token_hex(16)
        resp = self.client.put(
            PENDING,
            json={
                "proof": proof.hex(), "expected_key_rev": 1, "from_key_id": key_id,
                "to_key_id": to_key, "wrap_version": 1,
                "wrap": {"v": 2, "iv": reset._b64(secrets.token_bytes(12)),
                         "data": reset._b64(secrets.token_bytes(48))},
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(resp.status_code, 200, resp.get_json())
        # Interrupted here: the old password and the old recovery wrap are untouched.
        self._assert_consistent(uid, email, password)
        self.assertEqual(self.client.post(START, json={}, headers={"X-CSRF-Token": csrf}).status_code, 200)
        # Next attempt: the commit with the matching key ids goes through.
        body = self._commit_body(proof, email, "new-password-after-retry", key_id)
        body["to_key_id"] = to_key
        done = self._commit(csrf, body)
        self.assertEqual(done.status_code, 200, done.get_json())
        self.assertEqual(self._login(email, "new-password-after-retry").status_code, 200)
        self.assertEqual(self._status()["key_id"], to_key)

    # (b) two devices at once ---------------------------------------------------

    def _device(self, email, password):
        """A second signed-in device: (client, csrf, vault-keys proof token)."""
        main = self.client
        client = self._other_session(email, password)
        self.client = client
        try:
            csrf = self._csrf()
            return client, csrf, self._token(email, password, csrf)
        finally:
            self.client = main

    def test_two_devices_enrolling_at_the_same_time_give_exactly_one_winner(self):
        uid, email, password, _ = self._signed_in()
        devices = [self._device(email, password), self._device(email, password)]
        bodies = [wraps._body(0, secrets.token_hex(16)) for _ in devices]
        results: list = [None, None]
        barrier = threading.Barrier(2)

        def run(i):
            client, csrf, token = devices[i]
            barrier.wait()
            r = client.put(
                "/api/account/vault-keys/recovery", json={**bodies[i], "token": token},
                headers={"X-CSRF-Token": csrf},
            )
            results[i] = (r.status_code, r.get_json())

        threads = [threading.Thread(target=run, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(sorted(r[0] for r in results), [200, 409], results)
        loser = next(r[1] for r in results if r[0] == 409)
        self.assertEqual(loser["error"], "key_rev_mismatch")
        self.assertEqual(loser["key_rev"], 1)  # tells the device what to refetch
        winner = next(i for i, r in enumerate(results) if r[0] == 200)
        st = self._status()
        self.assertTrue(st["recovery"]["active"])
        self.assertEqual((st["key_rev"], st["key_id"]), (1, bodies[winner]["key_id"]))
        self.assertEqual(len(self._wrap_rows(uid)[0]), 1)
        # Both devices are signed in already; a third sign-in is held back by the new-device checks.
        self._assert_consistent(uid, email, password, sign_in=False)
        self.assertEqual(devices[winner][0].get("/api/account").status_code, 200)

    def test_loser_refetches_sees_the_active_key_and_a_deliberate_replace_works(self):
        uid, email, password, csrf = self._signed_in()
        kid = secrets.token_hex(16)
        self.assertEqual(self._put(email, password, csrf, wraps._body(0, kid)).status_code, 200)
        loser = self._put(email, password, csrf, wraps._body(0, secrets.token_hex(16)))
        self.assertEqual(loser.status_code, 409)
        st = self._status()  # the refetch
        self.assertTrue(st["recovery"]["active"])
        replaced = self._put(email, password, csrf, wraps._body(st["key_rev"], st["key_id"]))
        self.assertEqual(replaced.status_code, 200, replaced.get_json())
        self.assertEqual(self._status()["key_rev"], 2)
        self._assert_consistent(uid, email, password)

    # (c) old client ------------------------------------------------------------

    def test_old_client_signs_in_and_reads_account_with_a_recovery_key(self):
        uid, email, password, csrf, proof, key_id = self._enrolled()
        old = self._other_session(email, password)  # plain login, no vault-keys calls, no schema header
        self.assertEqual(old.get("/api/account").status_code, 200)
        self.assertEqual(old.get("/api/sessions").status_code, 200)
        self._assert_consistent(uid, email, password)
        self.assertTrue(self._status()["recovery"]["active"])

    def test_old_client_password_change_reports_the_recovery_key_as_gone_never_silently_stale(self):
        uid, email, password, csrf, proof, key_id = self._enrolled()
        before = self._status()
        self.assertTrue(before["recovery"]["active"])
        new_password = "old-client-new-password"
        done = self._change_password(email, password, new_password, csrf)
        self.assertEqual(done.status_code, 200, done.get_json())
        # The wrap held the old key; it is removed, so settings say "no recovery key".
        st = self._status()
        self.assertFalse(st["recovery"]["active"])
        self.assertGreater(st["key_rev"], before["key_rev"])
        self.assertEqual(st["key_id"], "")
        # Recovery with the old key is a clean 404, not a wrap that opens the wrong key.
        self.assertEqual(self.client.post(START, json={}, headers={"X-CSRF-Token": csrf}).status_code, 404)
        self.assertEqual(self._wrap_rows(uid), ([], []))
        self._assert_consistent(uid, email, new_password)
        # A new recovery key can be enrolled again at the new revision.
        import db as notes_db

        changed_at = notes_db.connection().execute(
            "SELECT password_changed_at FROM users WHERE id = ?", (uid,),
        ).fetchone()[0]
        stale = self._put(email, new_password, self._csrf(), wraps._body(st["key_rev"], secrets.token_hex(16)))
        self.assertEqual(stale.status_code, 409)  # a device still holding the old key cannot enrol it
        again = self._put(
            email, new_password, self._csrf(),
            wraps._body(st["key_rev"], secrets.token_hex(16), password_changed_at=changed_at),
        )
        self.assertEqual(again.status_code, 200, again.get_json())
        self.assertTrue(self._status()["recovery"]["active"])

    def test_password_change_without_any_wrap_does_not_touch_the_revision(self):
        uid, email, password, csrf = self._signed_in()
        done = self._change_password(email, password, "plain-new-password", csrf)
        self.assertEqual(done.status_code, 200, done.get_json())
        self.assertEqual(self._status()["key_rev"], 0)
        self._assert_consistent(uid, email, "plain-new-password")


if __name__ == "__main__":
    unittest.main()
