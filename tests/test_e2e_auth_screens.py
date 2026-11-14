"""Wrapper so pytest discovers the sign-in/registration/unlock Playwright E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class AuthScreensE2E(unittest.TestCase):
    def test_auth_screens_fields_errors_layout_and_smoke(self):
        if os.environ.get("E2E_AUTH_SCREENS", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_AUTH_SCREENS disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_auth_screens import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
