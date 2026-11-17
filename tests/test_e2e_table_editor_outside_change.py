"""Wrapper so unittest discovers the table-editor close-on-outside-change Playwright E2E.

Playwright is required: a missing install fails this test instead of skipping it.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


class TableEditorOutsideChangeE2E(unittest.TestCase):
    def test_outside_source_change_closes_table_editor_with_notice(self):
        from e2e_table_editor_outside_change import main

        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
