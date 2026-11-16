"""Vendored rich-view libraries match docs/THIRD_PARTY.md and the client manifest."""
from __future__ import annotations

import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THIRD_PARTY = ROOT / "docs" / "THIRD_PARTY.md"
VENDOR_DIRS = ["markdown-it", "dompurify", "highlightjs", "mermaid", "codemirror"]


def _listed() -> dict[str, str]:
    text = THIRD_PARTY.read_text(encoding="utf-8")
    return dict(re.findall(r"\|\s*`(app/static/js/vendor/[^`]+)`\s*\|[^|]*\|\s*`([0-9a-f]{64})`\s*\|", text))


class VendorHashTests(unittest.TestCase):
    def test_every_vendored_file_is_listed_with_matching_sha256(self):
        listed = _listed()
        for name in VENDOR_DIRS:
            folder = ROOT / "app" / "static" / "js" / "vendor" / name
            files = [p for p in folder.iterdir() if p.is_file()]
            self.assertTrue(files, name)
            self.assertTrue((folder / "LICENSE").is_file(), f"{name}: LICENSE missing")
            for path in files:
                rel = path.relative_to(ROOT).as_posix()
                self.assertIn(rel, listed, f"{rel} not in docs/THIRD_PARTY.md")
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), listed[rel], rel)

    def test_versions_and_licenses_documented(self):
        text = THIRD_PARTY.read_text(encoding="utf-8")
        self.assertRegex(text, r"\| markdown-it \| 14\.1\.0 \| MIT \|")
        self.assertRegex(text, r"\| DOMPurify \| 3\.2\.6 \| Apache-2\.0")
        head = (ROOT / "app/static/js/vendor/markdown-it/markdown-it.min.js").read_text(encoding="utf-8")[:120]
        self.assertIn("markdown-it 14.1.0", head)
        head = (ROOT / "app/static/js/vendor/dompurify/purify.min.js").read_text(encoding="utf-8")[:120]
        self.assertIn("DOMPurify 3.2.6", head)
        self.assertRegex(text, r"\| highlight\.js \| 11\.11\.1 \| BSD-3-Clause \|")
        head = (ROOT / "app/static/js/vendor/highlightjs/highlight.min.js").read_text(encoding="utf-8")[:120]
        self.assertIn("Highlight.js v11.11.1", head)
        self.assertRegex(text, r"\| Mermaid \| 11\.4\.1 \| MIT \|")
        self.assertRegex(text, r"\| CodeMirror 6 \| state 6\.5\.2, view 6\.36\.8, commands 6\.8\.1, language 6\.11\.0 \| MIT \|")

    def test_no_eval_in_vendored_rich_libraries(self):
        for rel in ("markdown-it/markdown-it.min.js", "dompurify/purify.min.js", "highlightjs/highlight.min.js", "mermaid/mermaid.min.js", "codemirror/codemirror.min.js"):
            body = (ROOT / "app/static/js/vendor" / rel).read_text(encoding="utf-8")
            self.assertNotIn("new Function", body, rel)
            self.assertNotRegex(body, r"\beval\(", rel)

    def test_client_manifest_lists_vendored_files(self):
        manifest = json.loads((ROOT / "app" / "static" / "client-manifest.json").read_text(encoding="utf-8"))
        assets = manifest["assets"]
        listed = _listed()
        for rel, digest in listed.items():
            # The manifest covers scripts and styles only (scripts/build-client-manifest.py INCLUDE_SUFFIXES);
            # LICENSE files are documented in THIRD_PARTY.md but not shipped as assets.
            if not rel.endswith((".js", ".mjs", ".css")):
                continue
            key = rel.split("app/static/", 1)[1]
            self.assertIn(key, assets, rel)
            self.assertEqual(assets[key]["sha256"], digest, rel)


if __name__ == "__main__":
    unittest.main()
