"""Regression: browser code under app/static must not use an unprotected free `global`.

A bare `global` throws "global is not defined" in browsers. It is only allowed
as a parameter of an IIFE wrapper in the same file, or behind `typeof global`.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "app" / "static"
USE = re.compile(r"(?<![\w.$])global\b(?!\s*:)")
DECL = re.compile(
    r"function\s*\(\s*global\s*\)|\(\s*global\s*\)\s*=>|\bglobal\s*=>"
    r"|\b(?:const|let|var)\s+global\b"
)


class NoFreeGlobalTests(unittest.TestCase):
    def test_no_unprotected_global(self):
        bad = []
        for path in sorted(STATIC.rglob("*.js")):
            if "vendor" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if DECL.search(text):
                # Wrapper parameter present; only the invocation argument can be free.
                for m in re.finditer(r"\}\)\(([^;]*)\)\s*;?\s*$", text, re.M):
                    arg = m.group(1)
                    if re.search(r"(?<![\w.$])global\b", arg) and "typeof global" not in arg \
                            and "window" not in arg:
                        bad.append(f"{path.relative_to(STATIC)}: {arg}")
                continue
            for n, line in enumerate(text.splitlines(), 1):
                code = line.split("//", 1)[0]
                if USE.search(code) and "typeof global " not in line and "typeof global!" not in line:
                    bad.append(f"{path.relative_to(STATIC)}:{n}: {line.strip()[:100]}")
        self.assertEqual(bad, [], "unprotected free `global` in browser code")


if __name__ == "__main__":
    unittest.main()
