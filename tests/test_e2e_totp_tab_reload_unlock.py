"""Wrapper so the test runner discovers the 2FA-tab reload+unlock E2E (idea #116).

See docs/bugs/2fa-tab-switch.md.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class TotpTabReloadUnlockE2E(unittest.TestCase):
    def test_totp_pane_visible_after_not_now_and_reload_unlock(self):
        if os.environ.get("E2E_TOTP_TAB_RELOAD", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_TOTP_TAB_RELOAD disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_totp_tab_reload_unlock import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
