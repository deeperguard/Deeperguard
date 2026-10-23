"""Round 73 Part A: server refuses plaintext password for SRP accounts."""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class Round73SrpNoPlaintext(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round73"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_REPAIR_LOGIN_PASSWORD"] = "0"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round73-secret", encoding="utf-8")

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
                "deeperguard_app",
                "email_verify",
                "plans",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        spec = importlib.util.spec_from_file_location(
            "deeperguard_app", APP_DIR / "app.py",
        )
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)
        import auth_rate_limit as arl
        import db as notes_db
        from passwords import hash_password, new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        arl._hits.clear()
        self.notes_db = notes_db
        self.hash_password = hash_password
        self.new_kdf_salt = new_kdf_salt
        self.generate_verifier_hex = generate_verifier_hex
        self.new_srp_salt_hex = new_srp_salt_hex
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def _register_srp(self, email: str, password: str) -> None:
        salt = self.new_srp_salt_hex()
        verifier = self.generate_verifier_hex(salt, email, password, kdf_version=2)
        self.notes_db.create_user_srp(
            email, self.new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )

    def _register_legacy(self, email: str, password: str) -> None:
        self.notes_db.create_user(
            email, self.hash_password(password), self.new_kdf_salt(),
        )

    def test_login_rejects_srp_account(self):
        email = "r73-srp-login@home.local"
        password = "r73-srp-login-pass-ok"
        self._register_srp(email, password)
        res = self.client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.get_json().get("error"), "invalid credentials")

    def test_repair_login_plaintext_flag_ignored_for_srp(self):
        email = "r73-srp-repair@home.local"
        password = "r73-srp-repair-pass-ok"
        self._register_srp(email, password)
        with mock.patch.object(self.app_mod, "repair_login_password_enabled", return_value=True):
            res = self.client.post(
                "/api/auth/repair-login",
                json={"email": email, "password": password},
            )
        self.assertIn(res.status_code, (400, 401))
        data = res.get_json()
        self.assertNotEqual(data.get("code"), "legacy_login")
        self.assertFalse(data.get("login_repaired"))
        self.assertNotIn("csrf", data)

    def test_repair_login_returns_legacy_login_for_argon2(self):
        email = "r73-legacy@home.local"
        password = "r73-legacy-pass-ok"
        self._register_legacy(email, password)
        res = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "A": "aa", "M1": "bb"},
        )
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.get_json().get("code"), "legacy_login")

    def test_repair_login_srp_wrong_proof_has_no_legacy_code(self):
        email = "r73-srp-wrong@home.local"
        password = "r73-srp-wrong-pass-ok"
        self._register_srp(email, password)
        challenge = self.client.post(
            "/api/auth/repair-login/challenge",
            json={"email": email},
        )
        self.assertEqual(challenge.status_code, 200)
        res = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "A": "11", "M1": "22"},
        )
        self.assertEqual(res.status_code, 401)
        self.assertNotEqual(res.get_json().get("code"), "legacy_login")

    def test_legacy_login_still_works(self):
        email = "r73-legacy-ok@home.local"
        password = "r73-legacy-ok-pass"
        self._register_legacy(email, password)
        res = self.client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(res.get_json().get("auth_method"), "argon2")

    def test_client_sources_omit_srp_plaintext_paths(self):
        srp = (APP_DIR / "static" / "js" / "srp-auth.js").read_text(encoding="utf-8")
        auth_pages = (APP_DIR / "static" / "js" / "auth-pages.js").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        sign_in = srp[srp.index("async function passwordSignIn") : srp.index("async function register")]
        self.assertIn("legacy_login", sign_in)
        self.assertIn("incorrectPassword", sign_in)
        self.assertIn("showSecureSignInReload", auth_pages)
        self.assertNotIn(
            "postJson('/api/auth/repair-login', { email, password })",
            auth_pages,
        )
        self.assertIn("authMethod !== 'srp'", app_js)


if __name__ == "__main__":
    unittest.main()
