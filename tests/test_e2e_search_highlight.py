"""Discoverable wrapper around the preview search end-to-end script.

The heavy browser run lives in e2e_search_highlight.py so it can still be
started directly. unittest discover picks this module up and skips when
Chromium, chromedriver, Tesseract, or Poppler are missing.
"""
from __future__ import annotations

import os
import shutil
import unittest
from pathlib import Path


class SearchHighlightE2ETests(unittest.TestCase):
    def test_search_highlights_on_document_preview(self):
        if os.environ.get("E2E_SEARCH") != "1":
            self.skipTest("set E2E_SEARCH=1 to run the browser preview test")
        needed = {
            "chromium": Path("/usr/bin/chromium"),
            "chromedriver": Path("/usr/bin/chromedriver"),
            "tesseract": shutil.which("tesseract"),
            "pdftotext": shutil.which("pdftotext"),
            "pdftoppm": shutil.which("pdftoppm"),
        }
        missing = [name for name, path in needed.items() if not path]
        if missing:
            self.skipTest("missing " + ", ".join(missing))
        try:
            import selenium  # noqa: F401
        except ImportError:
            self.skipTest("selenium is not installed")

        from e2e_search_highlight import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
