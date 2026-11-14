"""Wrapper so the test runner discovers the 2FA-tab-after-prompt E2E (idea #93)."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class TotpTabAfterPromptE2E(unittest.TestCase):
    def test_totp_tab_opens_after_dismissing_prompt_and_not_when_locked(self):
        if os.environ.get("E2E_TOTP_TAB", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_TOTP_TAB disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_totp_tab_after_prompt import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
