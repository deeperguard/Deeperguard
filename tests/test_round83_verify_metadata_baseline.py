"""Round 83: /verify metadata baseline page and JSON."""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round83VerifyMetadataBaseline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round83"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round83-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {"app", "config", "auth", "db", "verify_metadata_baseline"} or name.startswith(
                "app."
            ):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        self.tmp.cleanup()

    def test_regenerate_check(self):
        proc = subprocess.run(
            [sys.executable, str(REPO / "scripts/regenerate-verify-metadata-baseline.py"), "--check"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)

    def test_verify_page_includes_baseline(self):
        res = self.client.get("/verify")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn('id="verify-metadata-baseline"', body)
        self.assertIn("Compare this with your own DevTools", body)
        self.assertIn("Unlock vault", body)
        self.assertIn("Sends nothing", body)
        verify_tpl = (REPO / "app/templates/verify.html").read_text(encoding="utf-8")
        self.assertIn("UNCHECKED", verify_tpl)
        self.assertIn("mk-verify-measure unchecked", verify_tpl)

    def test_baseline_json_loads(self):
        import verify_metadata_baseline as vmb

        data = vmb.load_baseline()
        self.assertGreaterEqual(data.get("baseline_version", 0), 1)
        path = REPO / "app" / "verify-metadata-baseline.json"
        on_disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["schema_version"], on_disk["schema_version"])


if __name__ == "__main__":
    unittest.main()
