"""Wrapper so pytest discovers the [[ note link picker Playwright E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class NoteLinkPickerE2E(unittest.TestCase):
    def test_double_bracket_opens_picker_and_inserts_link(self):
        if os.environ.get("E2E_NOTE_LINK_PICKER", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_NOTE_LINK_PICKER disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_note_link_picker import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
