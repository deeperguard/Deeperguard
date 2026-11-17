"""Wrapper so the test runner discovers the note private-reminder E2E."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class NotePrivateReminderE2E(unittest.TestCase):
    def test_reminder_set_change_clear_encrypted_and_legacy_notes_load(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_note_private_reminder import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
