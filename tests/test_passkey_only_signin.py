"""Passkey-only account sign-in and recovery codes."""
from __future__ import annotations

import importlib
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class PasskeyOnlySignInTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "passkey-only"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("passkey-only-test-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "passkey_signin",
                "passwords",
                "srp_auth",
                "webauthn_helper",
                "auth_rate_limit",
                "plans",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        try:
            import auth_rate_limit as arl

            arl._hits.clear()
        except Exception:
            pass
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
            "NOTES_DISABLE_CIDR_GATE",
            "NOTES_ALLOW_REGISTER",
            "NOTES_SECURE_COOKIES",
            "NOTES_WEBAUTHN_ORIGIN",
            "NOTES_ADMIN_EMAILS",
        ):
            os.environ.pop(key, None)

    def _csrf(self) -> str:
        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return str(token)

    def _register(self, email: str):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, "vault-pass-123", kdf_version=2)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        import db as notes_db
        from plans import PLAN_PRO, plan_storage_quota_bytes

        user = notes_db.get_user_by_email(email)
        notes_db.connection().execute(
            "UPDATE users SET plan = ?, storage_quota_bytes = ? WHERE id = ?",
            (PLAN_PRO, plan_storage_quota_bytes(PLAN_PRO), int(user["id"])),
        )
        notes_db.connection().commit()
        return res.get_json()

    def _add_fake_passkeys(self, uid: int, count: int = 2):
        import db as notes_db

        for i in range(count):
            notes_db.add_webauthn_credential(
                uid,
                f"cred-{i}-{secrets.token_hex(8)}",
                "cHVibGljS2V5",
                sign_count=0,
            )

    def test_recovery_wait_and_password_disable(self):
        email = f"pk-{secrets.token_hex(4)}@example.com"
        self._register(email)
        import db as notes_db
        import passkey_signin as ps

        uid = int(notes_db.get_user_by_email(email)["id"])
        self._add_fake_passkeys(uid, 2)
        token = self._csrf()
        gen = self.client.post(
            "/api/account/passkey-signin/recovery-codes",
            json={"wait_seconds": ps.WAIT_FLOOR_SECONDS},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(gen.status_code, 200, gen.get_json())
        body = gen.get_json()
        self.assertEqual(len(body["codes"]), ps.RECOVERY_CODE_COUNT)
        activates_at = float(body["activates_at"])

        disable = self.client.post(
            "/api/account/passkey-signin/password-login",
            json={"disabled": True},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(disable.status_code, 200, disable.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertTrue(ps.password_login_disabled(user))

        methods = self.client.post("/api/auth/sign-in/methods", json={"email": email})
        self.assertEqual(methods.status_code, 200)
        m = methods.get_json()
        self.assertFalse(m["password"])
        self.assertTrue(m["passkey"])
        self.assertFalse(m["recovery"])

        bad = self.client.post(
            "/api/auth/recovery-code",
            json={"email": email, "code": body["codes"][0]},
        )
        self.assertEqual(bad.status_code, 403)

        notes_db.connection().execute(
            "UPDATE account_recovery_batches SET activates_at = ? WHERE user_id = ?",
            (time.time() - 10, uid),
        )
        notes_db.connection().commit()

        methods2 = self.client.post("/api/auth/sign-in/methods", json={"email": email})
        self.assertTrue(methods2.get_json()["recovery"])

        ok = self.client.post(
            "/api/auth/recovery-code",
            json={"email": email, "code": body["codes"][0]},
        )
        self.assertEqual(ok.status_code, 200, ok.get_json())

        reuse = self.client.post(
            "/api/auth/recovery-code",
            json={"email": email, "code": body["codes"][0]},
        )
        self.assertEqual(reuse.status_code, 401)

        cancel = self.client.post(
            "/api/account/passkey-signin/recovery-codes/cancel",
            json={},
            headers={"X-CSRF-Token": token},
        )
        self.assertIn(cancel.status_code, (400, 200))

    def test_cancel_pending_resets_password_login_when_needed(self):
        email = f"pk2-{secrets.token_hex(4)}@example.com"
        self._register(email)
        import db as notes_db
        import passkey_signin as ps

        uid = int(notes_db.get_user_by_email(email)["id"])
        self._add_fake_passkeys(uid, 2)
        token = self._csrf()
        self.client.post(
            "/api/account/passkey-signin/recovery-codes",
            json={"wait_seconds": ps.WAIT_FLOOR_SECONDS},
            headers={"X-CSRF-Token": token},
        )
        self.client.post(
            "/api/account/passkey-signin/password-login",
            json={"disabled": True},
            headers={"X-CSRF-Token": token},
        )
        cancel = self.client.post(
            "/api/account/passkey-signin/recovery-codes/cancel",
            json={},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(cancel.status_code, 200, cancel.get_json())
        user = notes_db.get_user_by_email(email)
        self.assertFalse(ps.password_login_disabled(user))

    def test_wait_floor_enforced(self):
        email = f"pk3-{secrets.token_hex(4)}@example.com"
        self._register(email)
        import db as notes_db
        import passkey_signin as ps

        uid = int(notes_db.get_user_by_email(email)["id"])
        self._add_fake_passkeys(uid, 2)
        token = self._csrf()
        gen = self.client.post(
            "/api/account/passkey-signin/recovery-codes",
            json={"wait_seconds": 3600},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(gen.status_code, 200)
        batch = notes_db.get_latest_recovery_batch(uid)
        self.assertGreaterEqual(int(batch["wait_seconds"]), ps.WAIT_FLOOR_SECONDS)

    def test_cannot_remove_last_passkeys_when_password_disabled(self):
        email = f"pk4-{secrets.token_hex(4)}@example.com"
        self._register(email)
        import db as notes_db
        import passkey_signin as ps

        uid = int(notes_db.get_user_by_email(email)["id"])
        self._add_fake_passkeys(uid, 2)
        token = self._csrf()
        self.client.post(
            "/api/account/passkey-signin/recovery-codes",
            json={"wait_seconds": ps.WAIT_FLOOR_SECONDS},
            headers={"X-CSRF-Token": token},
        )
        self.client.post(
            "/api/account/passkey-signin/password-login",
            json={"disabled": True},
            headers={"X-CSRF-Token": token},
        )
        rows = notes_db.list_webauthn_credentials(uid)
        rem = self.client.post(
            "/api/auth/webauthn/remove",
            json={"credential_id": rows[0]["credential_id"]},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(rem.status_code, 400, rem.get_json())


if __name__ == "__main__":
    unittest.main()
