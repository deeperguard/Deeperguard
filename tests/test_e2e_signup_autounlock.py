"""Wrapper so pytest discovers the Round 58 signup auto-unlock E2E."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class SignupAutoUnlockE2E(unittest.TestCase):
    def test_register_lands_unlocked(self):
        if os.environ.get("E2E_SIGNUP_AUTOUNLOCK", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_SIGNUP_AUTOUNLOCK disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_signup_autounlock import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
