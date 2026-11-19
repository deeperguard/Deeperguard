"""Own order of notes inside a label (docs/FOLDERS_SPEC.md section 4).

Runs tests/test_note_manual_order.js (format, old notes without a key, ciphertext-only
on the wire, two-device sync conflict) and the Playwright flow in
tests/e2e_note_own_order.py (pick "Own order", move notes, order kept after reload).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))


class NoteManualOrderTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is required")
    def test_format_old_notes_wire_and_sync_conflict(self):
        proc = subprocess.run(
            ["node", str(ROOT / "tests" / "test_note_manual_order.js")],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertIn("test_note_manual_order.js: ok", proc.stdout)

    def test_own_order_choice_survives_reload_e2e(self):
        if os.environ.get("E2E_NOTE_OWN_ORDER", "1") not in {"1", "true", "yes"}:
            self.skipTest("E2E_NOTE_OWN_ORDER disabled")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("playwright is not installed")

        from e2e_note_own_order import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
