"""Sign out clears session and key material, also after a reload (contract: docs/LOGOUT.md)."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

WIPED_LOCAL = (
    "notes_device_password_enc", "notes_device_key", "notes_kdf_salt", "notes_vault_kdf_version",
    "notes_last_sync", "notes_sync_log", "notes_email",
)
KEPT_LOCAL = ("notes_device_id", "deeperguard-prefs")


class SignOutStorageE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("E2E_SIGN_OUT_STORAGE", "1") not in {"1", "true", "yes"}:
            raise unittest.SkipTest("E2E_SIGN_OUT_STORAGE disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("playwright is not installed")
        from e2e_sign_out_storage import sign_out_and_inspect

        cls.r = sign_out_and_inspect()

    def test_precondition_secrets_existed_before_sign_out(self):
        before = self.r["before"]
        for key in ("notes_device_password_enc", "notes_device_key", "notes_email"):
            self.assertIn(key, before["local"])
        self.assertEqual(before["session"].get("notes_unlocked"), "1")
        self.assertIn("session", [c["name"] for c in self.r["old_cookies"]])

    def test_reload_shows_no_unlocked_vault_and_no_session_cookie(self):
        self.assertFalse(self.r["unlocked_after_reload"])
        self.assertEqual(self.r["path_after_reload"], "/login")
        self.assertNotIn("session", self.r["cookies_after"])

    def test_old_session_is_refused_by_server(self):
        self.assertEqual(self.r["replay_status"], 401)

    def test_storage_is_wiped_as_documented(self):
        after = self.r["after"]
        for key in WIPED_LOCAL:
            self.assertNotIn(key, after["local"])
        self.assertEqual(after["session"], {})
        self.assertEqual(sum(after["idb"]["deeperguard"].values()), 0)

    def test_documented_leftovers_stay(self):
        for key in KEPT_LOCAL:
            self.assertIn(key, self.r["after"]["local"])


if __name__ == "__main__":
    unittest.main()
