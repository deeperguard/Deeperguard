"""Pending-rekey checkpoint of recovery (docs/VAULT_RECOVERY.md 3.2 step 4, 7.1, test P11)."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import test_vault_recovery_reset as reset  # noqa: E402
import test_vault_recovery_wraps as wraps  # noqa: E402

PENDING = "/api/account/vault-keys/recover/pending"
FETCH = PENDING + "/fetch"


def _wrap() -> dict:
    return {"v": 2, "iv": reset._b64(secrets.token_bytes(12)), "data": reset._b64(secrets.token_bytes(48))}


class PendingRekeyTests(unittest.TestCase):
    # Reuse the fixtures of the recovery tests without inheriting their test methods.
    tearDown = reset.r63.Round63SecurityTests.tearDown
    _csrf = reset.r63.Round63SecurityTests._csrf
    _srp_pair = reset.r63.Round63SecurityTests._srp_pair
    _create_srp_user = reset.r63.Round63SecurityTests._create_srp_user
    _login = reset.r63.Round63SecurityTests._login
    _signed_in = wraps.VaultRecoveryWrapTests._signed_in
    _token = wraps.VaultRecoveryWrapTests._token
    _put = wraps.VaultRecoveryWrapTests._put
    _status = wraps.VaultRecoveryWrapTests._status
    _mail = reset.VaultRecoveryResetTests._mail
    _enrolled = reset.VaultRecoveryResetTests._enrolled
    _commit_body = reset.VaultRecoveryResetTests._commit_body
    _commit = reset.VaultRecoveryResetTests._commit
    _row = reset.VaultRecoveryResetTests._row

    def setUp(self):
        reset.r63.Round63SecurityTests.setUp(self)
        self.mail = self._mail()

    def _pending_body(self, proof: bytes, key_id: str, rev: int = 1, **over):
        body = {
            "proof": proof.hex(), "expected_key_rev": rev, "from_key_id": key_id,
            "to_key_id": secrets.token_hex(16), "wrap_version": 1, "wrap": _wrap(),
        }
        body.update(over)
        return body

    def _put_pending(self, csrf, body):
        return self.client.put(PENDING, json=body, headers={"X-CSRF-Token": csrf})

    def _fetch(self, csrf, proof: bytes):
        return self.client.post(FETCH, json={"proof": proof.hex()}, headers={"X-CSRF-Token": csrf})

    def _pending_rows(self, uid):
        import db as notes_db

        return notes_db.connection().execute(
            "SELECT * FROM vault_pending_rekey WHERE user_id = ?", (uid,),
        ).fetchall()

    def test_valid_proof_stores_one_row_and_replaces_an_older_one(self):
        uid, _, _, csrf, proof, key_id = self._enrolled()
        first = self._pending_body(proof, key_id)
        resp = self._put_pending(csrf, first)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["key_rev"], 1)  # the checkpoint does not bump the revision
        second = self._pending_body(proof, key_id)
        self.assertEqual(self._put_pending(csrf, second).status_code, 200)
        rows = self._pending_rows(uid)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["from_key_id"], rows[0]["to_key_id"]), (key_id, second["to_key_id"]))
        self.assertIn(second["wrap"]["data"], rows[0]["wrap"])
        self.assertNotIn(first["wrap"]["data"], rows[0]["wrap"])

    def test_wrong_proof_is_counted_stores_nothing_and_locks_at_the_limit(self):
        import vault_keys

        uid, _, _, csrf, proof, key_id = self._enrolled()
        wrong = secrets.token_bytes(32)
        resp = self._put_pending(csrf, self._pending_body(wrong, key_id))
        self.assertEqual((resp.status_code, resp.get_json()["error"]), (403, "invalid proof"))
        self.assertEqual(self._row(uid)[0]["recovery_failed_count"], 1)
        self.assertEqual(self._pending_rows(uid), [])
        for _ in range(vault_keys.RECOVERY_MAX_FAILED - 1):
            last = self._put_pending(csrf, self._pending_body(wrong, key_id))
        self.assertEqual(last.status_code, 429)
        # Locked: even the right proof is refused and nothing is stored.
        self.assertEqual(self._put_pending(csrf, self._pending_body(proof, key_id)).status_code, 429)
        self.assertEqual(self._pending_rows(uid), [])

    def test_wrong_proof_with_stale_revision_still_counts(self):
        uid, _, _, csrf, _, key_id = self._enrolled()
        resp = self._put_pending(csrf, self._pending_body(secrets.token_bytes(32), key_id, rev=0))
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(self._row(uid)[0]["recovery_failed_count"], 1)

    def test_compare_and_set_on_revision_and_from_key_id(self):
        uid, _, _, csrf, proof, key_id = self._enrolled()
        stale = self._put_pending(csrf, self._pending_body(proof, key_id, rev=0))
        self.assertEqual((stale.status_code, stale.get_json()["error"]), (409, "key_rev_mismatch"))
        foreign = self._put_pending(csrf, self._pending_body(proof, secrets.token_hex(16)))
        self.assertEqual((foreign.status_code, foreign.get_json()["error"]), (409, "key_id_mismatch"))
        self.assertEqual(self._pending_rows(uid), [])

    def test_bad_shapes_and_clear_key_fields_are_rejected(self):
        uid, _, _, csrf, proof, key_id = self._enrolled()
        for over in (
            {"vault_key": "AAAA"}, {"proof": "zz"}, {"to_key_id": "nope"}, {"wrap_version": 9},
            {"wrap": {"v": 2}}, {"expected_key_rev": "1"},
        ):
            body = {**self._pending_body(proof, key_id), **over}
            self.assertEqual(self._put_pending(csrf, body).status_code, 400, over)
        self.assertEqual(self._pending_rows(uid), [])
        self.assertEqual(self._row(uid)[0]["recovery_failed_count"], 0)

    def test_needs_session_and_csrf(self):
        _, _, _, csrf, proof, key_id = self._enrolled()
        no_csrf = self.client.put(PENDING, json=self._pending_body(proof, key_id))
        self.assertEqual(no_csrf.status_code, 400)
        self.assertEqual(self.client.post(FETCH, json={"proof": proof.hex()}).status_code, 400)
        anon = self.app_mod.app.test_client()
        self.assertEqual(anon.put(PENDING, json={}).status_code, 401)
        self.assertEqual(anon.post(FETCH, json={}).status_code, 401)

    def test_status_reports_pending_and_never_a_wrap(self):
        uid, _, _, csrf, proof, key_id = self._enrolled()
        self.assertIs(self._status()["pending_rekey"], False)
        body = self._pending_body(proof, key_id)
        self.assertEqual(self._put_pending(csrf, body).status_code, 200)
        status = self._status()
        self.assertIs(status["pending_rekey"], True)
        self.assertNotIn(body["wrap"]["data"], str(status))
        self.assertNotIn("wrap", status)

    def test_fetch_returns_the_wrap_only_after_a_valid_proof(self):
        uid, _, _, csrf, proof, key_id = self._enrolled()
        body = self._pending_body(proof, key_id)
        self.assertEqual(self._fetch(csrf, proof).status_code, 404)  # nothing stored yet
        self.assertEqual(self._put_pending(csrf, body).status_code, 200)
        bad = self._fetch(csrf, secrets.token_bytes(32))
        self.assertEqual(bad.status_code, 403)
        self.assertNotIn(body["wrap"]["data"], bad.get_data(as_text=True))
        self.assertEqual(self._row(uid)[0]["recovery_failed_count"], 1)
        ok = self._fetch(csrf, proof)
        self.assertEqual(ok.status_code, 200)
        out = ok.get_json()
        self.assertEqual(out["wrap"], body["wrap"])
        self.assertEqual((out["from_key_id"], out["to_key_id"]), (key_id, body["to_key_id"]))

    def test_expired_row_is_ignored_and_cleaned_up(self):
        import db as notes_db
        import vault_keys

        uid, _, _, csrf, proof, key_id = self._enrolled()
        body = self._pending_body(proof, key_id)
        self.assertEqual(self._put_pending(csrf, body).status_code, 200)
        row = self._pending_rows(uid)[0]
        self.assertAlmostEqual(row["expires_at"] - row["created_at"], vault_keys.PENDING_REKEY_TTL_SECONDS)

        def expire():
            conn = notes_db.connection()
            conn.execute("UPDATE vault_pending_rekey SET expires_at = 1 WHERE user_id = ?", (uid,))
            conn.commit()

        # Status ignores and removes it.
        expire()
        self.assertIs(self._status()["pending_rekey"], False)
        self.assertEqual(self._pending_rows(uid), [])
        # Fetch ignores and removes it.
        self.assertEqual(self._put_pending(csrf, body).status_code, 200)
        expire()
        self.assertEqual(self._fetch(csrf, proof).status_code, 404)
        self.assertEqual(self._pending_rows(uid), [])

    def test_commit_with_mismatching_to_key_id_is_rejected_and_changes_nothing(self):
        uid, email, _, csrf, proof, key_id = self._enrolled()
        pending = self._pending_body(proof, key_id)
        self.assertEqual(self._put_pending(csrf, pending).status_code, 200)
        before = self._row(uid)
        body = self._commit_body(proof, email, "brand-new-password-1", key_id)  # another to_key_id
        resp = self._commit(csrf, body)
        self.assertEqual((resp.status_code, resp.get_json()["error"]), (409, "pending_mismatch"))
        self.assertEqual(self._row(uid), before)
        self.assertEqual(len(self._pending_rows(uid)), 1)

    def test_commit_with_matching_to_key_id_succeeds_and_deletes_the_row(self):
        uid, email, _, csrf, proof, key_id = self._enrolled()
        pending = self._pending_body(proof, key_id)
        self.assertEqual(self._put_pending(csrf, pending).status_code, 200)
        body = self._commit_body(proof, email, "brand-new-password-1", key_id)
        body["to_key_id"] = pending["to_key_id"]
        resp = self._commit(csrf, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(self._pending_rows(uid), [])
        self.assertIs(self._status()["pending_rekey"], False)

    def test_commit_ignores_an_expired_row_and_removes_it(self):
        import db as notes_db

        uid, email, _, csrf, proof, key_id = self._enrolled()
        self.assertEqual(self._put_pending(csrf, self._pending_body(proof, key_id)).status_code, 200)
        conn = notes_db.connection()
        conn.execute("UPDATE vault_pending_rekey SET expires_at = 1 WHERE user_id = ?", (uid,))
        conn.commit()
        resp = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(self._pending_rows(uid), [])

    def test_commit_without_any_pending_row_still_works(self):
        # Older app versions never call recover/pending.
        uid, email, _, csrf, proof, key_id = self._enrolled()
        resp = self._commit(csrf, self._commit_body(proof, email, "brand-new-password-1", key_id))
        self.assertEqual(resp.status_code, 200, resp.get_json())

    def test_deleting_the_user_removes_the_row(self):
        import db as notes_db

        uid, _, _, csrf, proof, key_id = self._enrolled()
        self.assertEqual(self._put_pending(csrf, self._pending_body(proof, key_id)).status_code, 200)
        conn = notes_db.connection()
        conn.execute("DELETE FROM users WHERE id = ?", (uid,))
        conn.commit()
        self.assertEqual(self._pending_rows(uid), [])


class MigrationTests(unittest.TestCase):
    def test_init_schema_adds_the_table_to_an_existing_database_without_touching_rows(self):
        import db as notes_db

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        notes_db.init_schema(conn)
        conn.execute(
            "INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at) VALUES ('a@example.com', '', 's', 1, 1)"
        )
        conn.execute(
            "INSERT INTO vault_recovery_wraps (user_id, key_id, wrap_version, recovery_salt, wrap, proof_hash, created_at)"
            " VALUES (1, 'k', 1, 'salt', '{}', 'h', 1)"
        )
        conn.commit()
        # The state of a database from before this change: no pending table.
        conn.execute("DROP TABLE vault_pending_rekey")
        conn.commit()

        def snapshot():
            return [
                [tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY 1")]
                for t in ("users", "vault_recovery_wraps")
            ]

        before = snapshot()
        notes_db.init_schema(conn)
        self.assertEqual(snapshot(), before)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM vault_pending_rekey").fetchone()[0], 0)
        notes_db.init_schema(conn)  # idempotent
        self.assertEqual(snapshot(), before)
        conn.close()


if __name__ == "__main__":
    unittest.main()
