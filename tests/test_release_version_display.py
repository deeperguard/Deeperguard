"""Release version label at the top of the login screen and the unlocked app.

The shown value must equal RELEASE_TAG (the release source) or be "dev" when
no tag is available; never a commit hash, build time or network lookup.
"""
from __future__ import annotations

import html
import importlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))

_ENV_KEYS = (
    "NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_ALLOWED_CIDRS", "NOTES_SKIP_LOGIN",
    "NOTES_BUILD", "NOTES_SERVER_INFO_REFRESH", "NOTES_STRICT_ZK", "NOTES_RELEASE_TAG",
    "NOTES_RELEASE_SIGNED",
)
_LABEL_RE = re.compile(
    r'<span id="release-version" class="release-version" aria-label="Appversie ([^"]*)">([^<]*)</span>'
)
_PAGES = ("/login", "/app")


def _luminance(hex_color: str) -> float:
    hex_color = hex_color.lstrip("#")
    chans = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in chans]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def _contrast(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class ReleaseVersionDisplayTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in _ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)  # no RELEASE_TAG here
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_RELEASE_SIGNED"] = "0"  # no GitHub probe
        os.environ.pop("NOTES_RELEASE_TAG", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {"app", "auth", "db", "config"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _label(self, path: str) -> tuple[str, str]:
        res = self.client.get(path)
        self.assertEqual(res.status_code, 200, path)
        matches = _LABEL_RE.findall(res.get_data(as_text=True))
        self.assertEqual(len(matches), 1, f"{path}: expected one release label")
        aria, text = (html.unescape(m) for m in matches[0])
        return aria, text

    def test_shows_repo_release_tag_on_login_and_app(self):
        expected = (REPO / "RELEASE_TAG").read_text(encoding="utf-8").strip()
        self.assertTrue(expected)
        for path in _PAGES:
            aria, text = self._label(path)
            self.assertEqual(text, expected, path)
            self.assertEqual(aria, expected, path)

    def test_deployed_release_tag_file_wins(self):
        (Path(os.environ["NOTES_ROOT"]) / "RELEASE_TAG").write_text("v9.8.7\n", encoding="utf-8")
        for path in _PAGES:
            self.assertEqual(self._label(path), ("v9.8.7", "v9.8.7"), path)

    def test_env_release_tag_is_shown(self):
        os.environ["NOTES_RELEASE_TAG"] = "v1.2.3"
        for path in _PAGES:
            self.assertEqual(self._label(path), ("v1.2.3", "v1.2.3"), path)

    def test_shows_dev_without_release_source(self):
        import client_assets

        repo_tag = REPO / "RELEASE_TAG"
        real_read = Path.read_text

        def no_release_tag(self_path, *args, **kwargs):
            # Simulate a local dev checkout without any RELEASE_TAG file.
            if self_path.name == "RELEASE_TAG":
                raise FileNotFoundError(str(self_path))
            return real_read(self_path, *args, **kwargs)

        self.assertTrue(repo_tag.is_file())
        with mock.patch.object(client_assets.Path, "read_text", no_release_tag):
            self.assertEqual(client_assets.release_tag(), "")
            for path in _PAGES:
                self.assertEqual(self._label(path), ("dev", "dev"), path)

    def test_version_commit_hash_is_not_used(self):
        # VERSION holds a git commit hash; it must never become the label.
        version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
        for path in _PAGES:
            _, text = self._label(path)
            if version:
                self.assertNotIn(version[:8], text)

    def test_label_contrast_meets_wcag_aa(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        dark = re.search(r"\n\.release-version \{[^}]*?color: (#[0-9a-fA-F]{6});", css)
        light = re.search(
            r'html\[data-theme="light"\] \.release-version,\s*'
            r'body\[data-theme="light"\] \.release-version \{\s*color: (#[0-9a-fA-F]{6});',
            css,
        )
        self.assertIsNotNone(dark)
        self.assertIsNotNone(light)
        self.assertNotIn("var(--muted)", css[dark.start():dark.end()])
        # Backgrounds the label sits on: auth card + sidebar nav in each theme.
        for bg in ("#0f1419", "#171d24", "#1c2430"):
            self.assertGreaterEqual(_contrast(dark.group(1), bg), 4.5, bg)
        for bg in ("#ffffff", "#f2f2f7", "#f1f5f9", "#f8fafc"):
            self.assertGreaterEqual(_contrast(light.group(1), bg), 4.5, bg)

    def test_no_network_or_signed_wording(self):
        partial = (APP_DIR / "templates" / "partials" / "release-version.html").read_text(
            encoding="utf-8"
        )
        lowered = partial.lower()
        for word in ("fetch(", "http", "verified", "signed", "geverifieerd", "ondertekend"):
            self.assertNotIn(word, lowered.split("-#}")[-1])


if __name__ == "__main__":
    unittest.main()
