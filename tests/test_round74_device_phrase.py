"""Round 74: anti-phishing device phrase stays client-only (no API)."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Round74DevicePhraseTests(unittest.TestCase):
    def test_no_server_device_phrase_api(self):
        app_py = (ROOT / "app" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("device_phrase", app_py)
        self.assertNotIn("notes_device_phrase", app_py)
        # No leftover server-derived phrase module from the mistaken PR.
        self.assertFalse((ROOT / "app" / "device_phrase.py").exists())

    def test_templates_and_assets_present(self):
        app_html = (ROOT / "app" / "templates" / "app.html").read_text(encoding="utf-8")
        login_html = (ROOT / "app" / "templates" / "login.html").read_text(encoding="utf-8")
        banner = (
            ROOT / "app" / "templates" / "partials" / "device-phrase-banner.html"
        ).read_text(encoding="utf-8")
        self.assertIn("device-phrase-banner.html", app_html)
        self.assertLess(
            app_html.index("device-phrase-banner.html"),
            app_html.index('id="unlock-form"'),
        )
        self.assertIn("device-phrase-banner.html", login_html)
        self.assertIn("js/device-phrase.js", app_html)
        self.assertIn("js/device-phrase.js", login_html)
        self.assertIn('id="device-phrase-display"', banner)
        self.assertIn('id="device-phrase-hint"', banner)
        self.assertIn('id="device-phrase-input"', app_html)
        self.assertIn("maxlength=\"64\"", app_html)

    def test_client_module_key_and_cap(self):
        js = (ROOT / "app" / "static" / "js" / "device-phrase.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("notes_device_phrase", js)
        self.assertIn("MAX_LEN = 64", js)
        self.assertIn("textContent", js)
        self.assertNotIn("innerHTML", js)
        self.assertIn(
            "If you don't see your phrase here, you may be on a fake page.",
            js,
        )
        self.assertIn("No device phrase yet.", js)


if __name__ == "__main__":
    unittest.main()
