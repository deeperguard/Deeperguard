"""Wrapper so pytest discovers the Round 59 server-copy E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class ServerCopyE2E(unittest.TestCase):
    def test_view_server_copy_each_item_type(self):
        if os.environ.get("E2E_SERVER_COPY", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_SERVER_COPY disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_server_copy import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
