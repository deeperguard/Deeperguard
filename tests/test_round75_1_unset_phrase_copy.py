"""Round 75.1: calm unset device-phrase copy on login/unlock (client-only)."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

UNSET = (
    "No device phrase yet. After you unlock, you can set one in Settings "
    "to help spot fake sign-in pages."
)
WARN = "If you don't see your phrase here, you may be on a fake page."


class Round75_1UnsetPhraseCopyTests(unittest.TestCase):
    def test_banner_on_unlock_and_login(self):
        app_html = (ROOT / "app" / "templates" / "app.html").read_text(encoding="utf-8")
        login_html = (ROOT / "app" / "templates" / "login.html").read_text(
            encoding="utf-8"
        )
        banner = (
            ROOT / "app" / "templates" / "partials" / "device-phrase-banner.html"
        ).read_text(encoding="utf-8")
        self.assertIn("device-phrase-banner.html", app_html)
        self.assertLess(
            app_html.index("device-phrase-banner.html"),
            app_html.index('id="unlock-form"'),
        )
        self.assertIn("device-phrase-banner.html", login_html)
        self.assertIn('id="device-phrase-display"', banner)
        self.assertIn('id="device-phrase-hint"', banner)
        self.assertIn("hidden", banner)
        self.assertNotIn(WARN, banner)
        self.assertNotIn("No phrase on this device yet", banner)
        # R75 prompt card still present in-app only.
        self.assertIn('id="device-phrase-prompt"', app_html)
        self.assertNotIn("device-phrase-prompt", login_html)

    def test_js_copy_and_styles(self):
        js = (ROOT / "app" / "static" / "js" / "device-phrase.js").read_text(
            encoding="utf-8"
        )
        css = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn(UNSET, js)
        self.assertIn(WARN, js)
        self.assertIn("is-unset", js)
        self.assertIn("textContent", js)
        self.assertNotIn("innerHTML", js)
        self.assertIn(".device-phrase-display.is-unset", css)
        self.assertIn("@media (max-width: 390px)", css)
        self.assertIn("device-phrase-display", css)

    def test_no_server_change(self):
        app_py = (ROOT / "app" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("device_phrase", app_py)
        self.assertNotIn("notes_device_phrase", app_py)
        self.assertNotIn("UNSET_COPY", app_py)


if __name__ == "__main__":
    unittest.main()
