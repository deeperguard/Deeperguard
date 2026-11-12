"""Production secret guard: refuse defaults on WAN boot."""
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"


class SecretGuardTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("NOTES_ALLOW_DEFAULT_SECRETS", None)
        os.environ.pop("NOTES_DISABLE_CIDR_GATE", None)
        os.environ.pop("NOTES_INDEXNOW_KEY", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)

    def test_lan_boot_allows_builtin_indexnow(self):
        sys.path.insert(0, str(APP_DIR))
        os.environ.pop("NOTES_DISABLE_CIDR_GATE", None)
        import secret_guard

        importlib.reload(secret_guard)
        self.assertFalse(secret_guard.production_secrets_enforced())
        self.assertEqual(secret_guard.collect_production_secret_violations(), [])

    def test_wan_refuses_default_indexnow(self):
        sys.path.insert(0, str(APP_DIR))
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ.pop("NOTES_INDEXNOW_KEY", None)
        import secret_guard

        importlib.reload(secret_guard)
        with tempfile.TemporaryDirectory() as td:
            os.environ["NOTES_KEYS"] = td
            (Path(td) / "flask-secret").write_text("wan-test-flask-secret", encoding="utf-8")
            with mock.patch.object(secret_guard, "production_secrets_enforced", return_value=True):
                violations = secret_guard.collect_production_secret_violations()
        self.assertIn("NOTES_INDEXNOW_KEY", violations)

    def test_wan_accepts_custom_indexnow(self):
        sys.path.insert(0, str(APP_DIR))
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_INDEXNOW_KEY"] = "custom-indexnow-key-7f2c"
        with tempfile.TemporaryDirectory() as td:
            os.environ["NOTES_KEYS"] = td
            (Path(td) / "flask-secret").write_text("x" * 40, encoding="utf-8")
            import secret_guard

            importlib.reload(secret_guard)
            with mock.patch.object(secret_guard, "production_secrets_enforced", return_value=True):
                violations = secret_guard.collect_production_secret_violations()
        self.assertNotIn("NOTES_INDEXNOW_KEY", violations)


if __name__ == "__main__":
    unittest.main()
