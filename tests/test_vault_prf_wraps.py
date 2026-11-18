"""Server storage for per-passkey PRF-wrapped vault key copies (docs/VAULT_RECOVERY.md 1.4, 2.1-2.3)."""
from __future__ import annotations

import secrets
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import base64  # noqa: E402
from contextlib import ExitStack  # noqa: E402

import test_round63_security as r63  # noqa: E402
import test_vault_recovery_wraps as rec  # noqa: E402


def _b64u_to_bytes(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _webauthn_env(wh, verify):
    """Patch the WebAuthn library edges (option generation, signature check) so the server's
    own logic runs on any installed webauthn version. Challenge storage in the session is real."""
    stack = ExitStack()
    stack.enter_context(patch.object(wh, "WEBAUTHN_AVAILABLE", True))
    stack.enter_context(patch.object(wh, "passkey_host_error", return_value=None))
    for name, value in (
        ("PublicKeyCredentialDescriptor", lambda id: {"id": id}),
        ("UserVerificationRequirement", SimpleNamespace(PREFERRED="preferred")),
        ("generate_authentication_options", lambda **kw: SimpleNamespace(challenge=secrets.token_bytes(32))),
        ("options_to_json_dict", lambda options: {"challenge": "x"}),
        ("bytes_to_base64url", lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")),
        ("base64url_to_bytes", _b64u_to_bytes),
        ("_rp_id", lambda: "localhost"),
        ("_rp_origin", lambda: "http://localhost"),
        ("verify_authentication_response", verify),
    ):
        stack.enter_context(patch.object(wh, name, value, create=True))
    return stack


def _prf_body(rev: int, key_id: str, **over):
    body = {
        "expected_key_rev": rev,
        "key_id": key_id,
        "wrap_version": 1,
        "prf_salt": rec._b64(secrets.token_bytes(32)),
        "wrap": {"v": 2, "iv": rec._b64(secrets.token_bytes(12)), "data": rec._b64(secrets.token_bytes(48))},
    }
    body.update(over)
    return body


class VaultPrfWrapTests(unittest.TestCase):
    # Reuse the app fixture and helpers of the recovery-wrap tests without inheriting their tests.
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

    def _passkey(self, uid):
        import db as notes_db

        cid = secrets.token_urlsafe(16)
        notes_db.add_webauthn_credential(uid, cid, "cHVibGljS2V5")
        return cid

    def _put_prf(self, email, password, csrf, cid, body):
        token = self._token(email, password, csrf)
        return self.client.put(
            f"/api/account/vault-keys/prf/{cid}", json={**body, "token": token},
            headers={"X-CSRF-Token": csrf},
        )

    def _assert_with(self, csrf, cid, *, accept=True):
        """Run options + unwrap with a faked signature check."""
        import webauthn_helper as wh

        h = {"X-CSRF-Token": csrf}

        def verify(**kw):
            if not accept:
                raise ValueError("bad signature")
            return SimpleNamespace(new_sign_count=1)

        with _webauthn_env(wh, verify):
            opts = self.client.post(f"/api/account/vault-keys/prf/{cid}/options", json={}, headers=h)
            if opts.status_code != 200:
                return opts, None
            res = self.client.post(
                f"/api/account/vault-keys/prf/{cid}/unwrap", json={"credential": {"id": cid}}, headers=h,
            )
        return opts, res

    def test_store_and_status_lists_passkey_without_wrap(self):
        uid, email, password, csrf = self._signed_in()
        cid = self._passkey(uid)
        kid = secrets.token_hex(16)
        body = _prf_body(0, kid)
        resp = self._put_prf(email, password, csrf, cid, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["key_rev"], 1)
        st = self._status()
        self.assertEqual((st["key_rev"], st["key_id"]), (1, kid))
        self.assertEqual([(p["credential_id"], p["current"]) for p in st["prf"]], [(cid, True)])
        self.assertNotIn(body["wrap"]["data"], str(st))

    def test_wrap_is_only_released_after_webauthn_assertion_with_that_passkey(self):
        import webauthn_helper as wh

        uid, email, password, csrf = self._signed_in()
        cid, other = self._passkey(uid), self._passkey(uid)
        kid = secrets.token_hex(16)
        body = _prf_body(0, kid)
        self.assertEqual(self._put_prf(email, password, csrf, cid, body).status_code, 200)
        h = {"X-CSRF-Token": csrf}
        secret = body["wrap"]["data"]
        # A session alone gets nothing: not in status, and unwrap without a challenge fails.
        self.assertNotIn(secret, str(self._status()))
        with _webauthn_env(wh, lambda **kw: SimpleNamespace(new_sign_count=1)):
            bare = self.client.post(
                f"/api/account/vault-keys/prf/{cid}/unwrap", json={"credential": {"id": cid}}, headers=h,
            )
        self.assertEqual(bare.status_code, 401)
        self.assertNotIn(secret, bare.get_data(as_text=True))
        # A failed assertion gets nothing either.
        _, bad = self._assert_with(csrf, cid, accept=False)
        self.assertEqual(bad.status_code, 401)
        self.assertNotIn(secret, bad.get_data(as_text=True))
        # An assertion with a different passkey cannot fetch this passkey's copy.
        with _webauthn_env(wh, lambda **kw: SimpleNamespace(new_sign_count=1)):
            self.client.post(f"/api/account/vault-keys/prf/{other}/options", json={}, headers=h)
            cross = self.client.post(
                f"/api/account/vault-keys/prf/{cid}/unwrap", json={"credential": {"id": other}}, headers=h,
            )
        self.assertEqual(cross.status_code, 400)
        self.assertNotIn(secret, cross.get_data(as_text=True))
        # A successful assertion with this passkey releases exactly its copy and salt.
        opts, ok = self._assert_with(csrf, cid)
        self.assertEqual(opts.get_json()["prf_salt"], body["prf_salt"])
        self.assertEqual(ok.status_code, 200, ok.get_json())
        got = ok.get_json()
        self.assertEqual(got["wrap"], body["wrap"])
        self.assertEqual((got["key_id"], got["prf_salt"]), (kid, body["prf_salt"]))
        # The challenge is single use.
        with _webauthn_env(wh, lambda **kw: SimpleNamespace(new_sign_count=1)):
            again = self.client.post(
                f"/api/account/vault-keys/prf/{cid}/unwrap", json={"credential": {"id": cid}}, headers=h,
            )
        self.assertEqual(again.status_code, 401)

    def test_passkey_without_wrap_has_no_salt_and_nothing_to_unwrap(self):
        uid, _email, _password, csrf = self._signed_in()
        cid = self._passkey(uid)
        opts, res = self._assert_with(csrf, cid)
        self.assertEqual(opts.get_json()["prf_salt"], "")
        self.assertEqual(res.status_code, 404)

    def test_other_users_passkey_is_refused(self):
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        other_uid, *_ = self._create_srp_user(f"o-{secrets.token_hex(4)}@example.com", "other-password-1")
        foreign = self._passkey(other_uid)
        resp = self._put_prf(email, password, csrf, foreign, _prf_body(0, secrets.token_hex(16)))
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(notes_db.get_vault_keys_status(uid)["key_rev"], 0)
        opts, _ = self._assert_with(csrf, foreign)
        self.assertEqual(opts.status_code, 404)

    def test_deleting_passkey_removes_its_copy_and_bumps_revision(self):
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        a, b = self._passkey(uid), self._passkey(uid)
        kid = secrets.token_hex(16)
        self.assertEqual(self._put_prf(email, password, csrf, a, _prf_body(0, kid)).status_code, 200)
        self.assertEqual(self._put_prf(email, password, csrf, b, _prf_body(1, kid)).status_code, 200)
        rem = self.client.post(
            "/api/auth/webauthn/remove", json={"credential_id": a}, headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(rem.status_code, 200, rem.get_json())
        left = [r["credential_id"] for r in notes_db.connection().execute("SELECT credential_id FROM vault_prf_wraps")]
        self.assertEqual(left, [b])
        st = self._status()
        self.assertEqual((st["key_rev"], st["key_id"]), (3, kid))  # b still wraps this key
        rem = self.client.post(
            "/api/auth/webauthn/remove", json={"credential_id": b}, headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(rem.status_code, 200)
        self.assertEqual(notes_db.connection().execute("SELECT COUNT(*) FROM vault_prf_wraps").fetchone()[0], 0)
        st = self._status()
        self.assertEqual((st["key_rev"], st["key_id"], st["prf"]), (4, "", []))  # no wrap left: id is free

    def test_deleting_passkey_keeps_recovery_wrap_and_key_id(self):
        uid, email, password, csrf = self._signed_in()
        cid = self._passkey(uid)
        kid = secrets.token_hex(16)
        self.assertEqual(self._put(email, password, csrf, rec._body(0, kid)).status_code, 200)
        self.assertEqual(self._put_prf(email, password, csrf, cid, _prf_body(1, kid)).status_code, 200)
        self.client.post("/api/auth/webauthn/remove", json={"credential_id": cid}, headers={"X-CSRF-Token": csrf})
        st = self._status()
        self.assertTrue(st["recovery"]["active"])
        self.assertEqual((st["key_id"], st["prf"]), (kid, []))

    def test_removing_passkey_without_copy_leaves_revision_alone(self):
        uid, _email, _password, csrf = self._signed_in()
        cid = self._passkey(uid)
        rem = self.client.post(
            "/api/auth/webauthn/remove", json={"credential_id": cid}, headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(rem.status_code, 200)
        self.assertEqual(self._status()["key_rev"], 0)

    def test_stale_revision_conflicts_and_changes_nothing(self):
        import db as notes_db

        uid, email, password, csrf = self._signed_in()
        a, b = self._passkey(uid), self._passkey(uid)
        kid = secrets.token_hex(16)
        first = _prf_body(0, kid)
        self.assertEqual(self._put_prf(email, password, csrf, a, first).status_code, 200)
        stale = self._put_prf(email, password, csrf, b, _prf_body(0, kid))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual((stale.get_json()["error"], stale.get_json()["key_rev"]), ("key_rev_mismatch", 1))
        self.assertEqual(self._put_prf(email, password, csrf, a, _prf_body(0, kid)).status_code, 409)
        rows = notes_db.connection().execute("SELECT credential_id, prf_salt FROM vault_prf_wraps").fetchall()
        self.assertEqual([(r["credential_id"], r["prf_salt"]) for r in rows], [(a, first["prf_salt"])])
        self.assertEqual(self._status()["key_rev"], 1)

    def test_other_key_id_conflicts_while_a_wrap_exists(self):
        uid, email, password, csrf = self._signed_in()
        a, b = self._passkey(uid), self._passkey(uid)
        self.assertEqual(
            self._put_prf(email, password, csrf, a, _prf_body(0, secrets.token_hex(16))).status_code, 200,
        )
        resp = self._put_prf(email, password, csrf, b, _prf_body(1, secrets.token_hex(16)))
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.get_json()["error"], "key_id_mismatch")

    def test_identical_retry_is_idempotent(self):
        uid, email, password, csrf = self._signed_in()
        cid = self._passkey(uid)
        body = _prf_body(0, secrets.token_hex(16))
        self.assertEqual(self._put_prf(email, password, csrf, cid, body).status_code, 200)
        again = self._put_prf(email, password, csrf, cid, body)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["key_rev"], 1)

    def test_malformed_bodies_and_missing_token_are_rejected(self):
        uid, email, password, csrf = self._signed_in()
        cid = self._passkey(uid)
        kid = secrets.token_hex(16)
        for bad in (
            _prf_body(0, kid, prf_salt=rec._b64(secrets.token_bytes(16))),
            _prf_body(0, kid, wrap={"v": 2, "iv": "AAAA", "data": "AAAA"}),
            _prf_body(0, kid, vault_key="AAAA"),
            _prf_body(0, "not-a-key-id"),
        ):
            self.assertEqual(self._put_prf(email, password, csrf, cid, bad).status_code, 400, bad)
        no_token = self.client.put(
            f"/api/account/vault-keys/prf/{cid}", json=_prf_body(0, kid), headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(no_token.status_code, 401)
        self.assertEqual(self._status()["key_rev"], 0)

    def test_schema_upgrade_keeps_existing_passkeys(self):
        import db as notes_db

        uid, *_ = self._signed_in()
        cid = self._passkey(uid)
        conn = notes_db.connection()
        conn.execute("DROP TABLE vault_prf_wraps")
        notes_db.init_schema(conn)
        self.assertIsNotNone(notes_db.get_webauthn_credential(cid))
        self.assertEqual(notes_db.get_vault_keys_status(uid)["prf"], [])


if __name__ == "__main__":
    unittest.main()
