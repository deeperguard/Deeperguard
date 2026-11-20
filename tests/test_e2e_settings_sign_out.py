"""Wrapper so the test runner discovers the Settings sign-out Playwright E2E (idea #228)."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class SettingsSignOutE2E(unittest.TestCase):
    def setUp(self):
        if os.environ.get("E2E_SETTINGS_SIGN_OUT", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_SETTINGS_SIGN_OUT disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

    def _assert_left_app(self, mode):
        from e2e_settings_sign_out import sign_out_from_settings

        state = sign_out_from_settings(mode)
        self.assertTrue(state["unlockScreen"] or state["path"] == "/login", state)
        self.assertFalse(state["settings"], state)
        self.assertFalse(state["notes"], state)
        self.assertFalse(state["unlocked"], state)

    def test_sign_out_leaves_app_while_logout_request_hangs(self):
        self._assert_left_app("hang")

    def test_sign_out_leaves_app_when_logout_request_fails(self):
        self._assert_left_app("fail")


if __name__ == "__main__":
    unittest.main()
