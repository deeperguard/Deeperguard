"""Wrapper so pytest discovers the public header Playwright E2E."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class PublicHeaderE2E(unittest.TestCase):
    def test_header_never_clips_links(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_public_header import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
