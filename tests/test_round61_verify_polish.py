"""Round 61: /verify release link, signed-release copy, no duplicate About."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round61VerifyPolishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round61"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["SOURCE_DATE_EPOCH"] = "0"
        os.environ["NOTES_RELEASE_SIGNED"] = "0"
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round61-secret", encoding="utf-8")
        # Point RELEASE_TAG at the repo file via NOTES_ROOT copy.
        tag = (REPO / "RELEASE_TAG").read_text(encoding="utf-8").strip() if (REPO / "RELEASE_TAG").exists() else "v0.61.0"
        (root / "RELEASE_TAG").write_text(tag + "\n", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app", "config", "auth", "db", "srp_auth", "auth_rate_limit",
                "client_assets", "server_info_cache",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_verify_unsigned_copy_and_release_link(self):
        import client_assets

        tag = client_assets.release_tag()
        url = client_assets.release_url()
        self.assertTrue(tag.startswith("v"), tag)
        self.assertIn(f"/tag/{tag}", url)
        self.assertFalse(client_assets.release_is_signed())

        resp = self.client.get("/verify")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn(url, html)
        self.assertIn("once release signing is active", html)
        self.assertIn("cosign verify-blob (signed releases)", html)
        self.assertIn("figcaption", html)
        self.assertNotIn('<span class="mk-code-label">', html)
        # No stray brace glued to a label
        self.assertNotIn("{Redacted", html.replace(" ", ""))
        self.assertNotIn('{<span class="mk-code-label">', html)
        self.assertNotIn("{Redacted —", html)

    def test_verify_signed_copy_when_flag_on(self):
        os.environ["NOTES_RELEASE_SIGNED"] = "1"
        import client_assets

        client_assets._SIGNED_CACHE["tag"] = ""
        client_assets._SIGNED_CACHE["checked_at"] = 0.0
        self.assertTrue(client_assets.release_is_signed())
        # Re-import app context by hitting verify after clearing modules is heavy;
        # render template globals via a fresh request after forcing env.
        for name in list(sys.modules):
            if name in {"app", "client_assets"} or name.startswith("app."):
                sys.modules.pop(name, None)
        app_mod = importlib.import_module("app")
        client = app_mod.app.test_client()
        html = client.get("/verify").get_data(as_text=True)
        self.assertIn("This release is Sigstore-signed", html)
        self.assertNotIn("once release signing is active", html)
        os.environ["NOTES_RELEASE_SIGNED"] = "0"

    def test_release_is_signed_probes_github(self):
        import client_assets

        os.environ.pop("NOTES_RELEASE_SIGNED", None)
        # Repo may ship RELEASE_SIGNED=1; isolate so the GitHub probe path runs.
        (Path(self.tmp.name) / "RELEASE_SIGNED").write_text("maybe\n", encoding="utf-8")
        client_assets._SIGNED_CACHE["tag"] = ""
        client_assets._SIGNED_CACHE["checked_at"] = 0.0
        with mock.patch.object(client_assets, "release_tag", return_value="v0.0.0-test"):
            with mock.patch(
                "pathlib.Path.read_text",
                side_effect=OSError("skip RELEASE_SIGNED files for probe test"),
            ):
                with mock.patch.object(
                    client_assets, "_probe_release_has_sigstore", return_value=True
                ):
                    client_assets._SIGNED_CACHE["tag"] = ""
                    client_assets._SIGNED_CACHE["checked_at"] = 0.0
                    self.assertTrue(client_assets.release_is_signed())
                client_assets._SIGNED_CACHE["tag"] = ""
                client_assets._SIGNED_CACHE["checked_at"] = 0.0
                with mock.patch.object(
                    client_assets, "_probe_release_has_sigstore", return_value=False
                ):
                    self.assertFalse(client_assets.release_is_signed())


if __name__ == "__main__":
    unittest.main()
