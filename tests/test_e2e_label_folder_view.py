"""Wrapper so pytest discovers the label folder view Playwright E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class LabelFolderViewE2E(unittest.TestCase):
    def test_breadcrumb_include_sublabels_and_new_note(self):
        if os.environ.get("E2E_LABEL_FOLDER_VIEW", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_LABEL_FOLDER_VIEW disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_label_folder_view import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
