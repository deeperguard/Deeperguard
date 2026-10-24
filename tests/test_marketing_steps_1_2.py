"""Marketing steps 1–2: new routes, canonical URLs, and hero copy."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

NEW_MARKETING_ROUTES = (
    ("/compare/notesnook", "Deeperguard vs Notesnook"),
    ("/compare/joplin", "Deeperguard vs Joplin"),
    ("/evernote-alternative", "Evernote alternative"),
    ("/for/freelancers", "freelancers"),
)


class MarketingSteps12Tests(unittest.TestCase):
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

    def test_homepage_hero_and_og(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("Encrypted before they leave your device", body)
        self.assertIn("sync only ever sees ciphertext", body)
        self.assertIn("The one exception is Ask AI", body)
        self.assertIn('href="/verify">check it yourself</a>', body)
        self.assertIn(
            "ciphertext-only sync (except Ask AI), servers in the EU",
            body,
        )
        self.assertIn("mk-trust-strip", body)
        self.assertIn("/terms#operator-identity", body)

    def test_new_marketing_pages(self):
        for path, title_fragment in NEW_MARKETING_ROUTES:
            res = self.client.get(path, follow_redirects=False)
            self.assertEqual(res.status_code, 200, path)
            body = res.get_data(as_text=True)
            self.assertIn(title_fragment, body, path)
            self.assertIn('rel="canonical"', body, path)
            canon = f'<link rel="canonical" href="https://www.deeperguard.com{path}">'
            self.assertIn(canon, body, path)
            title_res = self.client.get(path)
            self.assertIn("<title>", title_res.get_data(as_text=True))

    def test_sitemap_lists_new_pages(self):
        sm = self.client.get("/sitemap.xml").get_data(as_text=True)
        for path, _ in NEW_MARKETING_ROUTES:
            self.assertIn(f"<loc>https://www.deeperguard.com{path}</loc>", sm)

    def test_compare_pages_use_stacked_table_and_verify_link_text(self):
        for path in ("/compare/notesnook", "/compare/joplin"):
            res = self.client.get(path)
            body = res.get_data(as_text=True)
            self.assertIn("mk-compare-stack", body)
            self.assertRegex(body, r'href="/verify"[^>]*>check it yourself</a>')
            self.assertNotIn('href="/verify">/verify</a>', body)


if __name__ == "__main__":
    unittest.main()
