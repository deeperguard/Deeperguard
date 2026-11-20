"""Wrapper so the test runner discovers the register-after-sign-out Playwright E2E.

See docs/findings/register-after-signout.md for the outcome of idea #224.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class RegisterAfterSignOutE2E(unittest.TestCase):
    def setUp(self):
        if os.environ.get("E2E_REGISTER_AFTER_SIGNOUT", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_REGISTER_AFTER_SIGNOUT disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

    def test_sign_out_then_create_account_shows_recovery_key_dialog(self):
        from e2e_register_after_signout import run

        self.assertEqual(run("stub"), "recovery-dialog")

    # With the Turnstile script unreachable, 'Create account' must say so.
    # See docs/findings/register-after-signout.md.
    def test_sign_out_then_create_account_without_turnstile_shows_error(self):
        from e2e_register_after_signout import run

        feedback = run("blocked")
        self.assertEqual(
            feedback,
            "register-error: Please complete the security check and try again.",
        )


if __name__ == "__main__":
    unittest.main()
