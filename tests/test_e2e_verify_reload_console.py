"""Wrapper so pytest discovers the /verify reload console E2E (see docs/VERIFY_RELOAD_ERROR.md)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class VerifyReloadConsoleE2E(unittest.TestCase):
    def test_verify_reload_has_no_own_origin_failures(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_verify_reload_console import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
