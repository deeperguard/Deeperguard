"""Wrapper so the test runner discovers the Contacts-tab E2E (idea #225, task #470)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class ContactsTabE2E(unittest.TestCase):
    def test_contacts_tab_add_edit_search_delete_and_keyboard(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_contacts_tab import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
