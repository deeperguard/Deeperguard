"""Per-route CSP: Turnstile and GitHub API allowlists (2026-10-30)."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))

TURNSTILE_TEST_SITE = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"


class PerRouteCspTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "per-route-csp"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_TURNSTILE_SITE_KEY"] = TURNSTILE_TEST_SITE
        os.environ["NOTES_TURNSTILE_SECRET_KEY"] = TURNSTILE_TEST_SECRET
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("per-route-csp-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {"app", "config", "auth", "db", "srp_auth", "auth_rate_limit"} or name.startswith(
                "app."
            ):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_TURNSTILE_SITE_KEY", "NOTES_TURNSTILE_SECRET_KEY"):
            os.environ.pop(key, None)

    def _csp(self, path: str) -> str:
        resp = self.client.get(path)
        self.assertEqual(resp.status_code, 200, path)
        return resp.headers.get("Content-Security-Policy") or ""

    def test_app_shell_omits_turnstile_and_github(self):
        from config import app_entry_path

        csp = self._csp(app_entry_path())
        self.assertNotIn("challenges.cloudflare.com", csp)
        self.assertNotIn("api.github.com", csp)
        self.assertIn("connect-src 'self'", csp)

    def test_secure_send_receive_omits_turnstile_and_github(self):
        send_id = "a" * 32
        resp = self.client.get(f"/receive/{send_id}")
        self.assertIn(resp.status_code, (200, 404))
        csp = resp.headers.get("Content-Security-Policy") or ""
        self.assertNotIn("challenges.cloudflare.com", csp)
        self.assertNotIn("api.github.com", csp)

    def test_register_includes_turnstile_not_github(self):
        csp = self._csp("/register")
        self.assertIn("challenges.cloudflare.com", csp)
        self.assertNotIn("api.github.com", csp)

    def test_login_omits_turnstile_when_register_has_it(self):
        csp = self._csp("/login")
        self.assertNotIn("challenges.cloudflare.com", csp)
        self.assertNotIn("api.github.com", csp)

    def test_marketing_home_omits_turnstile_and_github(self):
        csp = self._csp("/")
        self.assertNotIn("challenges.cloudflare.com", csp)
        self.assertNotIn("api.github.com", csp)

    def test_verify_includes_github_not_turnstile(self):
        csp = self._csp("/verify")
        self.assertIn("https://api.github.com", csp)
        self.assertNotIn("challenges.cloudflare.com", csp)


if __name__ == "__main__":
    unittest.main()
