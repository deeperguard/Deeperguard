"""Wrapper so pytest discovers the folder tree Playwright E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class FolderTreeE2E(unittest.TestCase):
    def test_folder_tree_create_rename_delete_filter_and_keyboard(self):
        if os.environ.get("E2E_FOLDER_TREE", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_FOLDER_TREE disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_folder_tree import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
