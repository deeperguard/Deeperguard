"""Wrapper so pytest discovers the share target / quick capture Playwright E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class ShareTargetE2E(unittest.TestCase):
    def test_share_while_locked_stays_in_memory_then_saves_encrypted(self):
        if os.environ.get("E2E_SHARE_TARGET", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_SHARE_TARGET disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_share_target import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
