"""Public /security marketing page: route, honest copy, no forbidden claims."""
from __future__ import annotations

import importlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
REPO = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

FORBIDDEN_PATTERNS = (
    r"\bPRF\b",
    r"passkey.{0,40}vault unlock",
    r"free tier",
    r"per-route CSP",
    r"WebDAV",
    r"OCR accuracy",
    r"offline dirty-sign-out",
    r"\buser counts?\b",
    r"Secure Send.{0,30}(Free|Basic).{0,30}cap",
)


class SecurityMarketingPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "security-page"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_ALLOWED_CIDRS",
            "NOTES_BUILD",
            "NOTES_STRICT_ZK",
            "NOTES_DISABLE_CIDR_GATE",
        ):
            os.environ.pop(key, None)

    def test_security_route_returns_200(self):
        res = self.client.get("/security", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers.get("Content-Type", ""))

    def test_security_copy_and_verify_link(self):
        body = self.client.get("/security").get_data(as_text=True)
        self.assertIn("<title>Security — Deeperguard</title>", body)
        self.assertIn(
            "How Deeperguard encrypts notes on your device, what the server can see, "
            "and how to verify it yourself.",
            body,
        )
        self.assertIn("Privacy by architecture", body)
        self.assertIn("AES-GCM 256 encrypts note content in the browser before sync.", body)
        self.assertIn("pCloud account password is never stored on this server", body)
        self.assertIn('href="/verify">/verify</a>', body)
        self.assertIn("Verify it yourself", body)
        self.assertIn("Ask AI (honest exception)", body)
        self.assertIn("Open the app", body)
        self.assertIn('href="https://www.deeperguard.com/app"', body)
        self.assertIn('rel="canonical" href="https://www.deeperguard.com/security">', body)

    def test_security_no_forbidden_claims(self):
        body = self.client.get("/security").get_data(as_text=True)
        for pattern in FORBIDDEN_PATTERNS:
            self.assertIsNone(
                re.search(pattern, body, re.IGNORECASE | re.DOTALL),
                f"forbidden pattern {pattern!r} found on /security",
            )

    def test_security_linked_from_chrome(self):
        topbar = (REPO / "app/templates/partials/mk-topbar.html").read_text(encoding="utf-8")
        footer = (REPO / "app/templates/partials/mk-footer.html").read_text(encoding="utf-8")
        self.assertIn('href="/security">Security</a>', topbar)
        self.assertIn('href="/security">Security</a>', footer)
        self.assertNotIn('href="/#security"', topbar)
        self.assertNotIn('href="/#security"', footer)

    def test_marketing_home_keeps_in_page_security_section(self):
        marketing = (REPO / "app/templates/marketing.html").read_text(encoding="utf-8")
        self.assertIn('href="#security">Security</a>', marketing)
        self.assertNotIn('href="/#security"', marketing)

    def test_blog_page_topbar_links_security_route(self):
        body = self.client.get("/blog").get_data(as_text=True)
        self.assertIn('href="/security">Security</a>', body)
        self.assertIn('href="/blog">Blog</a>', body)
        self.assertIn('href="/verify">Verify</a>', body)

    def test_security_is_public_path(self):
        import auth

        self.assertTrue(auth.public_path("/security"))


if __name__ == "__main__":
    unittest.main()
