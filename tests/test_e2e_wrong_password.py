"""Discoverable wrapper around the wrong-password end-to-end script."""
from __future__ import annotations

import os
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class WrongPasswordE2ETests(unittest.TestCase):
    def test_wrong_password_preserves_cache_and_locks(self):
        if os.environ.get("E2E_WRONGPW") != "1":
            self.skipTest("set E2E_WRONGPW=1 to run the wrong-password browser test")
        missing = [
            name for name, path in {
                "chromium": Path("/usr/bin/chromium"),
                "chromedriver": Path("/usr/bin/chromedriver"),
            }.items() if not path
        ]
        if missing:
            self.skipTest("missing " + ", ".join(missing))
        try:
            import selenium  # noqa: F401
        except ImportError:
            self.skipTest("selenium is not installed")

        from e2e_wrong_password import main  # noqa: E402

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
