"""Wrapper so pytest discovers the unlock derive-progress E2E."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class UnlockDeriveProgressE2E(unittest.TestCase):
    def test_progress_and_failure_release(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")
        from e2e_unlock_derive_progress import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
