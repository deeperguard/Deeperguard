"""Server storage for the wrapped recovery key (docs/VAULT_RECOVERY.md 2.1-2.3)."""
from __future__ import annotations

import base64
import secrets
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from srp_client_proof import srp_client_proof  # noqa: E402
import test_round63_security as r63  # noqa: E402


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _body(rev: int, key_id: str, **over):
    body = {
        "expected_key_rev": rev,
        "key_id": key_id,
        "wrap_version": 1,
        "recovery_salt": _b64(secrets.token_bytes(16)),
        "wrap": {"v": 2, "iv": _b64(secrets.token_bytes(12)), "data": _b64(secrets.token_bytes(48))},
        "proof_hash": secrets.token_hex(32),
    }
    body.update(over)
    return body


class VaultRecoveryWrapTests(unittest.TestCase):
    # Reuse the app fixture and SRP helpers of the round-63 tests without inheriting its tests.
    setUp = r63.Round63SecurityTests.setUp
    tearDown = r63.Round63SecurityTests.tearDown
    _csrf = r63.Round63SecurityTests._csrf
    _srp_pair = r63.Round63SecurityTests._srp_pair
    _create_srp_user = r63.Round63SecurityTests._create_srp_user
    _login = r63.Round63SecurityTests._login

    def _signed_in(self):
        email = f"vk-{secrets.token_hex(4)}@example.com"
        password = "vault-keys-test-password"
        uid, *_ = self._create_srp_user(email, password)
        self.assertEqual(self._login(email, password).status_code, 200)
        return uid, email, password, self._csrf()

    def _token(self, email: str, password: str, csrf: str) -> str:
        h = {"X-CSRF-Token": csrf}
        chal = self.client.post("/api/account/vault-keys/challenge", json={}, headers=h)
        self.assertEqual(chal.status_code, 200, chal.get_json())
        b = chal.get_json()
        a_hex, m1 = srp_client_proof(email, password, b["srp_salt"], b["B"], b.get("srp_kdf_version"))
        prove = self.client.post("/api/account/vault-keys/prove", json={"A": a_hex, "M1": m1}, headers=h)
        self.assertEqual(prove.status_code, 200, prove.get_json())
        return prove.get_json()["token"]

    def _put(self, email, password, csrf, body, token=None):
        token = token or self._token(email, password, csrf)
        return self.client.put(
            "/api/account/vault-keys/recovery", json={**body, "token": token},
            headers={"X-CSRF-Token": csrf},
        )

    def _status(self):
        resp = self.client.get("/api/account/vault-keys")
        self.assertEqual(resp.status_code, 200)
        return resp.get_json()

    def test_account_without_wrap_is_unchanged(self):
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        st = self._status()
        self.assertEqual(st["recovery"]["active"], False)
        self.assertEqual((st["key_rev"], st["key_id"]), (0, ""))
        self.assertEqual(self.client.get("/api/account").status_code, 200)
        self.assertEqual(self._login(email, password).status_code, 200)
        self.assertIsNone(
            notes_db.connection().execute(
                "SELECT 1 FROM vault_recovery_wraps WHERE user_id = ?", (uid,)
            ).fetchone()
        )

    def test_status_names_account_and_put_returns_security_time(self):
        uid, email, password, csrf = self._signed_in()
        self.assertEqual(self._status()["account_id"], str(uid))
        resp = self._put(email, password, csrf, _body(0, secrets.token_hex(16)))
        self.assertEqual(resp.status_code, 200, resp.get_json())
        at = resp.get_json()["auth_security_at"]
        self.assertGreater(at, 0)
        self.assertEqual(self.client.get("/api/account").get_json()["auth_security_at"], at)

    def test_store_replace_and_status_never_returns_wrap(self):
        uid, email, password, csrf = self._signed_in()
        kid = secrets.token_hex(16)
        first = _body(0, kid)
        resp = self._put(email, password, csrf, first)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["key_rev"], 1)
        st = self._status()
        self.assertTrue(st["recovery"]["active"])
        self.assertEqual((st["key_rev"], st["key_id"]), (1, kid))
        self.assertGreater(st["recovery"]["created_at"], 0)
        dumped = str(st)
        self.assertNotIn(first["wrap"]["data"], dumped)
        self.assertNotIn(first["proof_hash"], dumped)

        second = _body(1, kid)
        resp = self._put(email, password, csrf, second)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["key_rev"], 2)
        import db as notes_db

        rows = notes_db.connection().execute(
            "SELECT recovery_salt, proof_hash FROM vault_recovery_wraps WHERE user_id = ?", (uid,)
        ).fetchall()
        self.assertEqual(len(rows), 1)  # the new copy replaced the old one
        self.assertEqual(rows[0]["recovery_salt"], second["recovery_salt"])
        self.assertEqual(rows[0]["proof_hash"], second["proof_hash"])

    def test_stale_revision_conflicts_and_overwrites_nothing(self):
        uid, email, password, csrf = self._signed_in()
        kid = secrets.token_hex(16)
        self.assertEqual(self._put(email, password, csrf, _body(0, kid)).status_code, 200)
        import db as notes_db

        before = tuple(notes_db.connection().execute(
            "SELECT wrap, proof_hash FROM vault_recovery_wraps WHERE user_id = ?", (uid,)
        ).fetchone())
        stale = self._put(email, password, csrf, _body(0, kid))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["error"], "key_rev_mismatch")
        self.assertEqual(stale.get_json()["key_rev"], 1)
        after = tuple(notes_db.connection().execute(
            "SELECT wrap, proof_hash FROM vault_recovery_wraps WHERE user_id = ?", (uid,)
        ).fetchone())
        self.assertEqual(before, after)
        self.assertEqual(self._status()["key_rev"], 1)

    def test_other_key_id_conflicts_while_a_wrap_exists(self):
        uid, email, password, csrf = self._signed_in()
        kid = secrets.token_hex(16)
        self.assertEqual(self._put(email, password, csrf, _body(0, kid)).status_code, 200)
        resp = self._put(email, password, csrf, _body(1, secrets.token_hex(16)))
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.get_json()["error"], "key_id_mismatch")
        self.assertEqual(self._status()["key_id"], kid)

    def test_revoke_then_enroll_with_new_key_id(self):
        uid, email, password, csrf = self._signed_in()
        self.assertEqual(self._put(email, password, csrf, _body(0, secrets.token_hex(16))).status_code, 200)
        h = {"X-CSRF-Token": csrf}
        stale = self.client.delete(
            "/api/account/vault-keys/recovery",
            json={"expected_key_rev": 0, "token": self._token(email, password, csrf)}, headers=h,
        )
        self.assertEqual(stale.status_code, 409)
        self.assertTrue(self._status()["recovery"]["active"])
        gone = self.client.delete(
            "/api/account/vault-keys/recovery",
            json={"expected_key_rev": 1, "token": self._token(email, password, csrf)}, headers=h,
        )
        self.assertEqual(gone.status_code, 200, gone.get_json())
        st = self._status()
        self.assertEqual((st["recovery"]["active"], st["key_rev"], st["key_id"]), (False, 2, ""))
        again = self.client.delete(
            "/api/account/vault-keys/recovery",
            json={"expected_key_rev": 2, "token": self._token(email, password, csrf)}, headers=h,
        )
        self.assertEqual(again.status_code, 404)
        self.assertEqual(self._status()["key_rev"], 2)
        fresh = self._put(email, password, csrf, _body(2, secrets.token_hex(16)))
        self.assertEqual(fresh.status_code, 200, fresh.get_json())

    def test_repeating_identical_write_is_idempotent(self):
        uid, email, password, csrf = self._signed_in()
        body = _body(0, secrets.token_hex(16))
        self.assertEqual(self._put(email, password, csrf, body).status_code, 200)
        again = self._put(email, password, csrf, body)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["key_rev"], 1)

    def test_rejects_clear_key_fields_and_bad_shapes(self):
        uid, email, password, csrf = self._signed_in()
        kid = secrets.token_hex(16)
        token = self._token(email, password, csrf)  # a rejected write must not burn the token
        bad_wrap = {"v": 2, "iv": _b64(b"x" * 12), "data": _b64(b"x" * 48), "key": "raw"}
        short = {"v": 2, "iv": _b64(b"x" * 12), "data": _b64(b"x" * 10)}
        cases = [
            {**_body(0, kid), "recovery_key": "ABCD"},
            {**_body(0, kid), "vault_key": "aa"},
            {**_body(0, kid), "password": "x"},
            _body(0, kid, wrap=bad_wrap),
            _body(0, kid, wrap=short),
            _body(0, "ZZ"),
            _body(True, kid),
        ]
        for body in cases:
            resp = self._put(email, password, csrf, body, token=token)
            self.assertEqual(resp.status_code, 400, body)
        self.assertFalse(self._status()["recovery"]["active"])
        self.assertEqual(self._put(email, password, csrf, _body(0, kid), token=token).status_code, 200)

    def test_write_needs_a_fresh_password_proof_token(self):
        uid, email, password, csrf = self._signed_in()
        body = _body(0, secrets.token_hex(16))
        no_token = self.client.put(
            "/api/account/vault-keys/recovery", json=body, headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(no_token.status_code, 401)
        token = self._token(email, password, csrf)
        self.assertEqual(self._put(email, password, csrf, body, token=token).status_code, 200)
        reuse = self._put(email, password, csrf, _body(1, body["key_id"]), token=token)
        self.assertEqual(reuse.status_code, 401)  # token is single use

    def test_wrong_password_proof_gives_no_token(self):
        uid, email, password, csrf = self._signed_in()
        h = {"X-CSRF-Token": csrf}
        b = self.client.post("/api/account/vault-keys/challenge", json={}, headers=h).get_json()
        a_hex, m1 = srp_client_proof(email, "wrong-password-x", b["srp_salt"], b["B"], b.get("srp_kdf_version"))
        prove = self.client.post("/api/account/vault-keys/prove", json={"A": a_hex, "M1": m1}, headers=h)
        self.assertEqual(prove.status_code, 401)

    def test_missing_status_row_gives_404_not_a_crash(self):
        import db as notes_db
        from unittest import mock

        self._signed_in()
        with mock.patch.object(notes_db, "get_vault_keys_status", return_value=None):
            resp = self.client.get("/api/account/vault-keys")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json(), {"error": "not found"})
        self.assertEqual(resp.headers.get("Cache-Control"), "no-store")

    def test_requires_login(self):
        self.assertIn(self.client.get("/api/account/vault-keys").status_code, (401, 403))

    def test_migration_keeps_existing_rows(self):
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        conn = notes_db.connection()
        conn.execute("DROP TABLE vault_recovery_wraps")
        for col in ("vault_key_id", "vault_key_rev", "recovery_failed_count",
                    "recovery_locked_until", "recovery_lock_level"):
            conn.execute(f"ALTER TABLE users DROP COLUMN {col}")
        conn.commit()
        before = conn.execute(
            "SELECT email, srp_salt, srp_verifier FROM users WHERE id = ?", (uid,)
        ).fetchone()
        notes_db.init_schema(conn)
        after = conn.execute(
            "SELECT email, srp_salt, srp_verifier, vault_key_id, vault_key_rev FROM users WHERE id = ?",
            (uid,),
        ).fetchone()
        self.assertEqual(tuple(before), tuple(after)[:3])
        self.assertEqual((after["vault_key_id"], after["vault_key_rev"]), ("", 0))
        self.assertEqual(self._login(email, password).status_code, 200)
        self.assertFalse(self._status()["recovery"]["active"])


if __name__ == "__main__":
    unittest.main()
