"""Round 65: CSP + template wiring for client release-hash check."""
from __future__ import annotations

import importlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
TESTS_DIR = REPO / "tests"
sys.path.insert(0, str(APP_DIR))


class Round65ReleaseHashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round65"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["SOURCE_DATE_EPOCH"] = "0"
        os.environ["NOTES_RELEASE_SIGNED"] = "1"
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        os.environ.pop("NOTES_CLIENT_MANIFEST", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round65-secret", encoding="utf-8")
        tag = (
            (REPO / "RELEASE_TAG").read_text(encoding="utf-8").strip()
            if (REPO / "RELEASE_TAG").exists()
            else "v0.62.1"
        )
        (root / "RELEASE_TAG").write_text(tag + "\n", encoding="utf-8")
        (root / "RELEASE_SIGNED").write_text("1\n", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "config",
                "auth",
                "db",
                "srp_auth",
                "auth_rate_limit",
                "client_assets",
                "server_info_cache",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_csp_allows_github_api_only_on_verify(self):
        from config import app_entry_path

        app_csp = self.client.get(app_entry_path()).headers.get("Content-Security-Policy") or ""
        self.assertNotIn("https://api.github.com", app_csp)
        verify_csp = self.client.get("/verify").headers.get("Content-Security-Policy") or ""
        self.assertIn("https://api.github.com", verify_csp)
        self.assertNotIn("release-assets.githubusercontent.com", verify_csp)

    def test_verify_page_has_status_and_meta(self):
        resp = self.client.get("/verify")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn("data-release-hash-status", html)
        self.assertIn('name="notes-client-hash"', html)
        self.assertIn('name="notes-release-tag"', html)
        self.assertIn("api.github.com", html)
        self.assertIn("release-integrity", html)
        self.assertIn("Could not check", html)
        self.assertIn("Does not match", html)
        self.assertIn("data-status-prefix", html)
        self.assertIn("Status:", html)
        self.assertIn("SubtleCrypto", html)
        self.assertIn("newer release", html)
        self.assertIn("timed out", html)
        self.assertIn("unlisted asset", html)

    def test_about_has_status(self):
        from config import app_entry_path

        resp = self.client.get(app_entry_path())
        html = resp.get_data(as_text=True)
        self.assertIn('id="about-release-hash-status"', html)
        self.assertIn("release-integrity", html)
        self.assertIn('name="notes-release-tag"', html)

    def test_node_unit_suite(self):
        script = TESTS_DIR / "test_round65_release_hash.js"
        completed = subprocess.run(
            ["node", str(script)],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(REPO),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)


if __name__ == "__main__":
    unittest.main()
