"""SRP server-side challenge store: session cookie must not contain private SRP state."""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import time
import unittest
import zlib
from base64 import urlsafe_b64decode
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def decode_flask_session_payload(set_cookie_header: str) -> dict:
    """Decode Flask session cookie payload without verifying the signature (signed, not encrypted)."""
    if not set_cookie_header:
        return {}
    cookie = set_cookie_header.split(";", 1)[0]
    if "=" not in cookie:
        return {}
    _, value = cookie.split("=", 1)
    data = value.partition(".")[0]
    padded = data + "=" * (-len(data) % 4)
    raw = urlsafe_b64decode(padded.encode("ascii"))
    try:
        payload = zlib.decompress(raw)
    except zlib.error:
        payload = raw
    return json.loads(payload.decode("utf-8"))


def session_cookie_from_response(response) -> str:
    return str(response.headers.get("Set-Cookie") or "")


def assert_no_srp_secrets_in_session(payload: dict) -> None:
    forbidden_keys = {"srp_state", "srp_cred_state"}
    for key in forbidden_keys:
        assert key not in payload, f"legacy session key {key} must not be present"
    for key, value in payload.items():
        if isinstance(value, dict):
            for secret in ("b", "v", "s", "I"):
                assert secret not in value, f"session[{key}] must not contain SRP secret {secret}"
    assert "srp_cred_verifier" not in payload
    assert "srp_cred_salt" not in payload


class SrpServerChallengeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "passwords",
                "totp",
                "srp_auth",
                "auth_rate_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_SKIP_LOGIN",
            "NOTES_BUILD",
            "NOTES_SERVER_INFO_REFRESH",
            "NOTES_STRICT_ZK",
        ):
            os.environ.pop(key, None)

    def _srp_verifier(self, email: str, password: str, salt_hex: str | None = None) -> tuple[str, str]:
        import hashlib

        from srp_auth import G, N

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(hashlib.sha256(text.encode("utf-8")).hexdigest())

        if not salt_hex:
            salt_hex = sha_hex(f"test-salt::{email}")
        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{salt_hex}{hash1}".upper())
        x = int(x_hash, 16) % N
        return salt_hex, format(pow(G, x, N), "x")

    def _register(self, email: str, password: str):
        salt_hex, verifier = self._srp_verifier(email, password)
        return self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )

    def _srp_verify_with_b(self, email: str, password: str, salt_hex: str, b_hex: str):
        import secrets

        from srp_auth import G, K, N, _from_hex, _h, _to_hex

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(_h(text))

        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{salt_hex}{hash1}".upper())
        x = int(x_hash, 16) % N
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        A = pow(G, a, N)
        a_hex = _to_hex(A)
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        s_hex = _to_hex(S)
        m1 = _h(a_hex + b_hex + s_hex)
        return self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )

    def _full_srp_login(self, email: str, password: str):
        salt_hex, _ = self._srp_verifier(email, password)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        b_hex = str(challenge.get_json()["B"]).lower()
        return self._srp_verify_with_b(email, password, salt_hex, b_hex)

    def _csrf_session(self, user_id: int) -> str:
        import secrets

        from config import SESSION_SECONDS

        token = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(user_id)
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["totp_ok"] = True
            sess["csrf"] = token
        return token

    def test_login_challenge_cookie_has_no_srp_private_state(self):
        email = "cookie-login@home.local"
        password = "cookie-login-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        with self.client.session_transaction() as sess:
            payload = dict(sess)
        assert_no_srp_secrets_in_session(payload)
        self.assertIn("srp_login_challenge_id", payload)
        salt_hex, _ = self._srp_verifier(email, password)
        b_hex = str(challenge.get_json()["B"]).lower()
        verify = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(verify.status_code, 200)
        self.assertIn("M2", verify.get_json())

    def test_repair_login_challenge_cookie_has_no_srp_private_state(self):
        email = "cookie-repair@home.local"
        password = "cookie-repair-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/repair-login/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        with self.client.session_transaction() as sess:
            payload = dict(sess)
        assert_no_srp_secrets_in_session(payload)
        self.assertIn("srp_cred_challenge_id", payload)

    def test_vault_recovery_challenge_cookie_has_no_srp_private_state(self):
        import db as notes_db
        from passwords import new_kdf_salt

        email = "cookie-vault@home.local"
        password = "cookie-vault-pass"
        salt_hex, verifier = self._srp_verifier(email, password)
        user_id = notes_db.create_user_srp(email, new_kdf_salt(), salt_hex, verifier)
        csrf = self._csrf_session(user_id)
        challenge = self.client.post(
            "/api/auth/vault-recovery/challenge",
            json={"email": email},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(challenge.status_code, 200)
        with self.client.session_transaction() as sess:
            payload = dict(sess)
        assert_no_srp_secrets_in_session(payload)

    def test_password_change_challenge_cookie_has_no_srp_private_state(self):
        email = "cookie-pw@home.local"
        password = "cookie-pw-pass"
        reg = self._register(email, password)
        self.assertEqual(reg.status_code, 200)
        user_id = int(reg.get_json()["user_id"])
        csrf = self._csrf_session(user_id)
        challenge = self.client.post(
            "/api/account/password/challenge",
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(challenge.status_code, 200)
        with self.client.session_transaction() as sess:
            payload = dict(sess)
        assert_no_srp_secrets_in_session(payload)

    def test_challenge_reuse_fails(self):
        email = "reuse@home.local"
        password = "reuse-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        salt_hex, _ = self._srp_verifier(email, password)
        b_hex = str(challenge.get_json()["B"]).lower()
        first = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(first.status_code, 200)
        second = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(second.status_code, 401)

    def test_expired_challenge_fails(self):
        import db as notes_db

        email = "expired@home.local"
        password = "expired-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        b_hex = str(challenge.get_json()["B"]).lower()
        with self.client.session_transaction() as sess:
            cid = sess.get("srp_login_challenge_id")
        notes_db.connection().execute(
            "UPDATE srp_challenges SET expires_at = ? WHERE id = ?",
            (time.time() - 10, cid),
        )
        notes_db.connection().commit()
        salt_hex, _ = self._srp_verifier(email, password)
        verify = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(verify.status_code, 401)

    def test_cross_purpose_reuse_fails(self):
        email = "cross-purpose@home.local"
        password = "cross-purpose-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        repair = self.client.post("/api/auth/repair-login/challenge", json={"email": email})
        self.assertEqual(repair.status_code, 200)
        salt_hex, _ = self._srp_verifier(email, password)
        b_hex = str(repair.get_json()["B"]).lower()
        verify = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(verify.status_code, 401)

    def test_cross_account_reuse_fails(self):
        email_a = "cross-a@home.local"
        email_b = "cross-b@home.local"
        password = "cross-account-pass"
        self.assertEqual(self._register(email_a, password).status_code, 200)
        self.assertEqual(self._register(email_b, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email_a})
        salt_b, _ = self._srp_verifier(email_b, password)
        b_hex = str(challenge.get_json()["B"]).lower()
        verify = self._srp_verify_with_b(email_b, password, salt_b, b_hex)
        self.assertEqual(verify.status_code, 401)

    def test_legacy_srp_state_in_session_is_ignored(self):
        email = "legacy@home.local"
        password = "legacy-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        with self.client.session_transaction() as sess:
            sess["srp_state"] = {"I": email, "b": "00", "v": "00", "s": "00"}
            sess["srp_email"] = email
            sess.pop("srp_login_challenge_id", None)
            sess.pop("srp_cred_challenge_id", None)
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": "1", "M1": "1"},
        )
        self.assertEqual(verify.status_code, 401)

    def test_shared_db_across_reconnected_worker(self):
        import db as notes_db

        email = "worker@home.local"
        password = "worker-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        with self.client.session_transaction() as sess:
            challenge_id = sess.get("srp_login_challenge_id")
        self.assertTrue(challenge_id)
        salt_hex, _ = self._srp_verifier(email, password)
        b_hex = str(challenge.get_json()["B"]).lower()
        notes_db._local.conn = None
        verify = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(verify.status_code, 200, verify.get_json())

    def test_login_challenge_fails_after_verifier_rotation(self):
        import db as notes_db

        email = "rotated-login@home.local"
        password = "rotated-login-pass"
        self.assertEqual(self._register(email, password).status_code, 200)
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        salt_hex, _ = self._srp_verifier(email, password)
        b_hex = str(challenge.get_json()["B"]).lower()
        user = notes_db.get_user_by_email(email)
        new_salt, new_verifier = self._srp_verifier(email, "new-password-after-rotation")
        notes_db.update_user_srp_verifier(int(user["id"]), new_salt, new_verifier)
        verify = self._srp_verify_with_b(email, password, salt_hex, b_hex)
        self.assertEqual(verify.status_code, 401)


if __name__ == "__main__":
    unittest.main()
