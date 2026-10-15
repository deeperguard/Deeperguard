"""Discoverable wrapper around the open-note-from-search end-to-end script.

The browser run lives in e2e_search_open_note.py so it can be started
directly. unittest discover picks this module up and skips unless
E2E_SEARCH=1 is set and Chrome/Chromium plus selenium are available.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class SearchOpenNoteE2ETests(unittest.TestCase):
    def test_open_matched_note_shows_attachment_and_hit_count(self):
        if os.environ.get("E2E_SEARCH") != "1":
            self.skipTest("set E2E_SEARCH=1 to run the browser open-note test")
        try:
            import selenium  # noqa: F401
        except ImportError:
            self.skipTest("selenium is not installed")
        from e2e_search_open_note import chrome_binary, main

        if not chrome_binary():
            self.skipTest("no Chrome/Chromium binary found (set E2E_CHROME)")
        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
