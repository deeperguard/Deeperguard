"""BSL 1.1 + marketing fence: no OSS/AGPL self-claims on public pages."""
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

DG_FORBIDDEN = (
    r"Open source · GitHub",
    r"Open source under",
    r"AGPL-3\.0",
    r"Deeperguard is open source",
    r"Open source on GitHub",
    r"\[AGPL-3\.0\]",
)


class SourceAvailableClaimsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "bsl-fence"
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

    def test_license_is_bsl(self):
        text = (REPO / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("Business Source License 1.1", text)
        self.assertIn("Schutten Invest B.V.", text)
        self.assertIn("Change Date:          2030-10-30", text)
        self.assertIn("Change License:       Apache License, Version 2.0", text)
        self.assertNotIn("GNU AFFERO", text)

    def test_homepage_locked_strings(self):
        body = self.client.get("/").get_data(as_text=True)
        self.assertIn("Source available · GitHub", body)
        self.assertIn(
            "Source available for review — inspect the encryption and client code yourself.",
            body,
        )
        self.assertIn("View source on GitHub", body)
        self.assertIn(
            "The license allows inspection and audit; it does not allow using the software "
            "in production or commercially without a separate agreement.",
            body,
        )
        self.assertIn("Source available for review · ", body)
        self.assertIn("Check the encryption yourself", body)

    def test_public_pages_no_dg_oss_self_claims(self):
        paths = ("/", "/security", "/compare/standard-notes", "/compare/notesnook")
        for path in paths:
            body = self.client.get(path).get_data(as_text=True)
            for pattern in DG_FORBIDDEN:
                self.assertIsNone(
                    re.search(pattern, body),
                    f"{pattern!r} found on {path}",
                )

    def test_shared_footer_fence_line(self):
        footer = (REPO / "app/templates/partials/mk-footer.html").read_text(encoding="utf-8")
        self.assertIn("Source available for review · ", footer)
        self.assertIn("Check the encryption yourself", footer)


if __name__ == "__main__":
    unittest.main()
