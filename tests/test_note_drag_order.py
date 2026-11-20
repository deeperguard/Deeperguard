"""Drag notes into an own order inside a label, and move them with the keyboard.

Runs the Playwright flow in tests/e2e_note_drag_order.py in a child process with a hard
time limit, so a stuck browser or server fails this test instead of hanging the run.
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NoteDragOrderTests(unittest.TestCase):
    def test_drag_and_keyboard_reorder_survive_reload_e2e(self):
        if os.environ.get("E2E_NOTE_DRAG_ORDER", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_NOTE_DRAG_ORDER disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        proc = subprocess.run(
            [sys.executable, str(ROOT / "tests" / "e2e_note_drag_order.py")],
            capture_output=True, text=True, timeout=600, cwd=ROOT,
        )
        self.assertEqual(proc.returncode, 0, (proc.stdout + proc.stderr)[-4000:])
        self.assertIn("e2e_note_drag_order ok", proc.stdout)


if __name__ == "__main__":
    unittest.main()
