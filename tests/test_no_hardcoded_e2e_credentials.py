"""H1: fail CI if live E2E credential defaults reappear in the tree."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCAN_ROOTS = [
    REPO / "tests",
    REPO / "app",
    REPO / "deploy",
    REPO / "docs",
]
# Patterns that must never return as defaults / literals in source.
FORBIDDEN = [
    re.compile(r"deeperguard-tester\+r19@mail\.grokbot\.com", re.I),
    re.compile(r"DgR19-Test-2026!xyz"),
    re.compile(r'NOTES_E2E_EMAIL["\'],\s*["\'][^"\']+@'),
    re.compile(r'NOTES_E2E_PASSWORD["\'],\s*["\'][^"\']+["\']'),
]
SKIP_SUFFIXES = {".pyc", ".png", ".jpg", ".webp", ".pdf", ".gz", ".wasm", ".woff2"}


class NoHardcodedE2ECredentialsTests(unittest.TestCase):
    def test_no_live_e2e_credential_defaults(self):
        hits: list[str] = []
        for root in SCAN_ROOTS:
            if not root.is_dir():
                continue
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix in SKIP_SUFFIXES:
                    continue
                if "node_modules" in path.parts or "__pycache__" in path.parts:
                    continue
                if path.name == Path(__file__).name:
                    continue
                try:
                    text = path.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                for pat in FORBIDDEN:
                    if pat.search(text):
                        rel = path.relative_to(REPO)
                        hits.append(f"{rel}: matched {pat.pattern}")
        self.assertEqual(hits, [], "hard-coded live E2E credentials found:\n" + "\n".join(hits))


if __name__ == "__main__":
    unittest.main()
