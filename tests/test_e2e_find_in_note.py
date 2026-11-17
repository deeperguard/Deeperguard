"""Wrapper so unittest discovers the Ctrl+F find-in-note Playwright E2E.

Playwright is required: a missing install fails this test instead of skipping it.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class FindInNoteE2E(unittest.TestCase):
    def test_ctrl_f_finds_inside_the_open_note_only(self):
        from e2e_find_in_note import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
