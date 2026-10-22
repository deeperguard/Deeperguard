"""Round 57: Cloudflare Turnstile on sign-up (mocked siteverify — never hits CF)."""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))

# Official Cloudflare dummy keys for automated tests (docs).
# Always-passes pair — we still mock urlopen so CI never contacts Cloudflare.
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


class Round57TurnstileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round57"
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
        (root / "keys" / "flask-secret").write_text("round57-secret", encoding="utf-8")
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
        for key in (
            "NOTES_TURNSTILE_SITE_KEY",
            "NOTES_TURNSTILE_SECRET_KEY",
        ):
            os.environ.pop(key, None)
        self.tmp.cleanup()

    def _pair(self, email: str, password: str):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        return salt, verifier

    def test_register_page_renders_turnstile_widget_and_csp(self):
        res = self.client.get("/register")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("cf-turnstile", body)
        self.assertIn(TURNSTILE_TEST_SITE, body)
        self.assertIn("challenges.cloudflare.com/turnstile", body)
        csp = res.headers.get("Content-Security-Policy") or ""
        self.assertIn("challenges.cloudflare.com", csp)
        self.assertIn("script-src", csp)
        self.assertIn("frame-src", csp)
        self.assertIn("connect-src", csp)

    def test_register_without_token_rejected(self):
        salt, verifier = self._pair("no-token@example.com", "no-token-secure-pass")
        with patch("urllib.request.urlopen") as mock_open:
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": "no-token@example.com",
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                },
            )
            mock_open.assert_not_called()
        self.assertEqual(res.status_code, 400)
        body = res.get_json()
        self.assertEqual(body.get("code"), "turnstile_required")
        self.assertIn("security check", body.get("error", "").lower())
        import db as notes_db

        self.assertIsNone(notes_db.get_user_by_email("no-token@example.com"))

    def test_register_invalid_token_rejected(self):
        salt, verifier = self._pair("bad-token@example.com", "bad-token-secure-pass")

        def fake_open(req, timeout=8):
            return _FakeResp({"success": False, "error-codes": ["invalid-input-response"]})

        with patch("urllib.request.urlopen", side_effect=fake_open) as mock_open:
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": "bad-token@example.com",
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
            mock_open.assert_called_once()
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json().get("code"), "turnstile_failed")
        import db as notes_db

        self.assertIsNone(notes_db.get_user_by_email("bad-token@example.com"))

    def test_register_siteverify_unreachable_503(self):
        salt, verifier = self._pair("down@example.com", "down-secure-password")

        with patch("urllib.request.urlopen", side_effect=TimeoutError("simulated")):
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": "down@example.com",
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
        self.assertEqual(res.status_code, 503)
        body = res.get_json()
        self.assertEqual(body.get("code"), "turnstile_unavailable")
        self.assertIn("try again", body.get("error", "").lower())
        import db as notes_db

        self.assertIsNone(notes_db.get_user_by_email("down@example.com"))

    def test_register_valid_token_succeeds_mocked(self):
        salt, verifier = self._pair("ok-token@example.com", "ok-token-secure-pass")

        def fake_open(req, timeout=8):
            # Ensure secret is posted but never assert its value into logs.
            body = req.data.decode("utf-8") if isinstance(req.data, (bytes, bytearray)) else ""
            self.assertIn("response=dummy-token", body)
            self.assertIn("secret=", body)
            return _FakeResp({"success": True})

        with patch("urllib.request.urlopen", side_effect=fake_open):
            res = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": "ok-token@example.com",
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
        self.assertEqual(res.status_code, 200, res.get_json())
        import db as notes_db

        self.assertIsNotNone(notes_db.get_user_by_email("ok-token@example.com"))

    def test_login_srp_unaffected_by_turnstile(self):
        """Existing-account SRP challenge/verify does not require Turnstile."""
        salt, verifier = self._pair("login57@example.com", "login57-secure-pass")

        def fake_open(req, timeout=8):
            return _FakeResp({"success": True})

        with patch("urllib.request.urlopen", side_effect=fake_open):
            reg = self.client.post(
                "/api/auth/srp/register",
                json={
                    "email": "login57@example.com",
                    "srp_salt": salt,
                    "srp_verifier": verifier,
                    "srp_kdf_version": 2,
                    "cf_turnstile_response": "dummy-token",
                },
            )
        self.assertEqual(reg.status_code, 200, reg.get_json())
        with self.client.session_transaction() as sess:
            sess.clear()
        chal = self.client.post(
            "/api/auth/srp/challenge",
            json={"email": "login57@example.com"},
        )
        self.assertEqual(chal.status_code, 200)
        self.assertIn("B", chal.get_json())

    def test_privacy_mentions_turnstile(self):
        res = self.client.get("/privacy")
        self.assertEqual(res.status_code, 200)
        text = res.get_data(as_text=True).lower()
        self.assertIn("turnstile", text)
        self.assertIn("bot", text)


if __name__ == "__main__":
    unittest.main()
