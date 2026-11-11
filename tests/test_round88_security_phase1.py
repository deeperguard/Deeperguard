"""Security Phase 1 (M1): shared TOTP limits and disable rotation token."""
from __future__ import annotations

import importlib.util
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class SecurityPhase1TotpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round88"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round88-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app", "auth", "db", "config", "passwords", "totp", "srp_auth", "auth_rate_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        spec = importlib.util.spec_from_file_location("deeperguard_app", APP_DIR / "app.py")
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)

        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.notes_db = notes_db
        self.client = self.app_mod.app.test_client()
        email = "totp-p1@e2e.invalid"
        password = "Test-pass-phrase-1"
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        self.uid = notes_db.create_user_srp(email, new_kdf_salt(), salt, verifier, srp_kdf_version=2)
        notes_db.update_user_totp(self.uid, "JBSWY3DPEHPK3PXP", enabled=True)
        csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(self.uid)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
            sess["csrf"] = csrf
        self.headers = {"X-CSRF-Token": csrf}
        self._plan = patch.object(self.app_mod, "_plan_block", return_value=None)
        self._plan.start()

    def tearDown(self):
        self._plan.stop()
        self.tmp.cleanup()

    def _bad_codes(self, path: str, n: int) -> list[int]:
        statuses = []
        for _ in range(n):
            res = self.client.post(path, json={"code": "000000"}, headers=self.headers)
            statuses.append(res.status_code)
        return statuses

    def test_totp_shared_limit_across_routes(self):
        paths = ("/api/totp/enable", "/api/totp/disable", "/api/totp/setup", "/api/totp/verify")
        all_status: list[int] = []
        for path in paths:
            all_status.extend(self._bad_codes(path, 6))
        self.assertIn(429, all_status, f"expected 429 in combined attempts: {all_status}")

    def test_totp_disable_requires_rotation_token(self):
        res = self.client.post(
            "/api/totp/disable",
            json={"code": "123456"},
            headers=self.headers,
        )
        self.assertEqual(res.status_code, 401)
        self.assertIn("prove", (res.get_json() or {}).get("error", ""))

    def test_legacy_login_410(self):
        res = self.client.post("/api/auth/login", json={"email": "x@e2e.invalid", "password": "x"})
        self.assertEqual(res.status_code, 410)

    def test_legacy_resync_410(self):
        res = self.client.post(
            "/api/auth/srp/resync",
            json={
                "email": "x@e2e.invalid",
                "password": "x",
                "srp_salt": "ab" * 16,
                "srp_verifier": "cd" * 128,
            },
        )
        self.assertEqual(res.status_code, 410)


if __name__ == "__main__":
    unittest.main()
