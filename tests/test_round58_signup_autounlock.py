"""Round 58: post-signup auto-unlock handoff + Turnstile register still returns vault salt."""
from __future__ import annotations

import importlib
import json
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))

TURNSTILE_TEST_SITE = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"


class _FakeResp:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status = status

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Round58SignupAutoUnlockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round58"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ["NOTES_TURNSTILE_SITE_KEY"] = TURNSTILE_TEST_SITE
        os.environ["NOTES_TURNSTILE_SECRET_KEY"] = TURNSTILE_TEST_SECRET
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round58-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app", "config", "auth", "db", "srp_auth", "auth_rate_limit",
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
        for key in ("NOTES_TURNSTILE_SITE_KEY", "NOTES_TURNSTILE_SECRET_KEY"):
            os.environ.pop(key, None)
        self.tmp.cleanup()

    def test_client_allows_empty_vault_prove_after_register(self):
        app_js = (REPO / "app/static/js/app.js").read_text(encoding="utf-8")
        auth_js = (REPO / "app/static/js/auth-pages.js").read_text(encoding="utf-8")
        self.assertIn("mayProveEmptyVaultOnSilentBoot", app_js)
        self.assertIn(
            "if (silent && !mayProveEmptyVaultOnSilentBoot()) deferAutoUnlock()",
            app_js,
        )
        self.assertIn("notes_just_registered", auth_js)
        self.assertIn("stashBootDerivedKey", auth_js)
        self.assertIn("notes_post_login_unlock", auth_js)
        self.assertIn("cf_turnstile_response", auth_js)

    def test_register_with_turnstile_returns_kdf_for_boot_unlock(self):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"r58-{secrets.token_hex(4)}@example.com"
        password = "round58-register-pass"
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        with patch(
            "urllib.request.urlopen",
            return_value=_FakeResp({"success": True, "hostname": "test"}),
        ):
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": email,
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                    "company": "",
                },
            )
        self.assertEqual(res.status_code, 200, res.get_json())
        body = res.get_json()
        self.assertTrue(body.get("kdf_salt"), "register must return kdf_salt for boot unlock")
        self.assertIn(int(body.get("vault_kdf_version") or 0), {1, 2})
        self.assertTrue(body.get("csrf"))

    def test_turnstile_still_required(self):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = f"r58-nots-{secrets.token_hex(4)}@example.com"
        password = "round58-register-pass"
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
                "company": "",
            },
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json().get("code"), "turnstile_required")


if __name__ == "__main__":
    unittest.main()
