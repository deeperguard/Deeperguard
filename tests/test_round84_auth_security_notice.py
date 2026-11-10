"""Round 84: auth_security_at + in-app notice after recovery/password/2FA events."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round84AuthSecurityNoticeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round84"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round84-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "config",
                "auth",
                "db",
                "srp_auth",
                "totp",
                "auth_rate_limit",
                "passkey_signin",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()
        import db as notes_db

        self.notes_db = notes_db

    def tearDown(self):
        try:
            import auth_rate_limit as arl

            arl._hits.clear()
        except Exception:
            pass
        self.tmp.cleanup()

    def _srp_pair(self, email: str, password: str):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        return salt, verifier

    def _create_user(self, email: str, password: str, *, totp: bool = False):
        from passwords import new_kdf_salt

        salt, verifier = self._srp_pair(email, password)
        uid = self.notes_db.create_user_srp(
            email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )
        self.notes_db.mark_email_verified(uid)
        secret = None
        if totp:
            import totp as totp_mod

            secret = totp_mod.new_secret()
            self.notes_db.connection().execute(
                "UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?",
                (secret, uid),
            )
            self.notes_db.connection().commit()
        return uid, secret

    def _srp_rotation_token(self, email: str, password: str, csrf: str) -> str:
        import secrets

        from srp_auth import G, K, N, _from_hex, _h, _to_hex, generate_x, normalize_srp_kdf_version

        challenge = self.client.post(
            "/api/account/password/challenge",
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        chal = challenge.get_json()
        b_hex = str(chal["B"]).lower()
        stored_salt = str(chal["srp_salt"]).lower()
        version = normalize_srp_kdf_version(chal.get("srp_kdf_version") or 2)
        x = generate_x(stored_salt, email, password, kdf_version=version)
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
        prove = self.client.post(
            "/api/account/password/prove",
            json={"A": a_hex, "M1": m1},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(prove.status_code, 200, prove.get_json())
        return str(prove.get_json()["rotation_token"])

    def test_account_payload_includes_auth_security_at(self):
        email = "r84@example.com"
        password = "r84-secure-password-ok"
        uid, _ = self._create_user(email, password)
        csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(uid)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
            sess["csrf"] = csrf
        res = self.client.get("/api/account")
        self.assertEqual(res.status_code, 200, res.get_json())
        body = res.get_json()
        self.assertIn("auth_security_at", body)

    def test_recovery_login_bumps_auth_security_at(self):
        import passkey_signin

        email = "r84-recovery@example.com"
        password = "r84-secure-password-ok"
        uid, _ = self._create_user(email, password)
        for i in range(2):
            self.notes_db.add_webauthn_credential(
                uid,
                f"cred-r84-{i}-{secrets.token_hex(6)}",
                "cHVibGljS2V5",
                sign_count=0,
            )
        batch = passkey_signin.issue_recovery_codes(uid, passkey_signin.WAIT_FLOOR_SECONDS)
        self.notes_db.connection().execute(
            "UPDATE account_recovery_batches SET activates_at = ? WHERE user_id = ?",
            (time.time() - 10, uid),
        )
        self.notes_db.connection().commit()
        code = batch["codes"][0]
        before = self.notes_db.user_auth_security_at(self.notes_db.get_user_by_id(uid))
        res = self.client.post(
            "/api/auth/recovery-code",
            json={"email": email, "code": code},
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        after = self.notes_db.user_auth_security_at(self.notes_db.get_user_by_id(uid))
        self.assertGreater(after, before)
        self.assertGreaterEqual(float(res.get_json().get("auth_security_at") or 0), after - 0.001)

    def test_totp_disable_bumps_auth_security_at(self):
        import totp as totp_mod

        email = "r84-totp@example.com"
        password = "r84-secure-password-ok"
        uid, secret = self._create_user(email, password, totp=True)
        csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(uid)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
            sess["csrf"] = csrf
        before = self.notes_db.user_auth_security_at(self.notes_db.get_user_by_id(uid))
        step = totp_mod.current_step(time.time())
        code = __import__("pyotp").TOTP(secret).at(step * 30)
        rotation_token = self._srp_rotation_token(email, password, csrf)
        res = self.client.post(
            "/api/totp/disable",
            json={"code": code, "rotation_token": rotation_token},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        after = self.notes_db.user_auth_security_at(self.notes_db.get_user_by_id(uid))
        self.assertGreater(after, before)
        self.assertGreater(float(res.get_json().get("auth_security_at") or 0), 0)

    def test_client_wiring_present(self):
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("remoteAuthSecurityEvent", store_js)
        self.assertIn("ackAuthSecurity", store_js)
        self.assertIn("checkRemoteAuthSecurityNotice", app_js)
        self.assertIn("auth-security-notice", html)
        self.assertIn("Account sign-in changed", html)


if __name__ == "__main__":
    unittest.main()
