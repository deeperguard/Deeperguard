"""Discoverable wrapper around the offline vault end-to-end script."""
from __future__ import annotations

import os
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class OfflineVaultE2ETests(unittest.TestCase):
    def test_offline_vault_unlock_and_image_search(self):
        if os.environ.get("E2E_OFFLINE") != "1":
            self.skipTest("set E2E_OFFLINE=1 to run the offline browser test")
        needed = {
            "chromium": Path("/usr/bin/chromium"),
            "chromedriver": Path("/usr/bin/chromedriver"),
            "tesseract": shutil.which("tesseract"),
        }
        missing = [name for name, path in needed.items() if not path]
        if missing:
            self.skipTest("missing " + ", ".join(missing))
        try:
            import selenium  # noqa: F401
        except ImportError:
            self.skipTest("selenium is not installed")

        from e2e_offline_vault import main  # noqa: E402

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
