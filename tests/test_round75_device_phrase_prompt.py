"""Round 75: in-app device-phrase prompt is client-only."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Round75DevicePhrasePromptTests(unittest.TestCase):
    def test_prompt_markup_and_css(self):
        app_html = (ROOT / "app" / "templates" / "app.html").read_text(encoding="utf-8")
        login_html = (ROOT / "app" / "templates" / "login.html").read_text(encoding="utf-8")
        css = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn('id="device-phrase-prompt"', app_html)
        self.assertIn("btn-device-phrase-prompt-set", app_html)
        self.assertIn("btn-device-phrase-prompt-dismiss", app_html)
        self.assertNotIn("device-phrase-prompt", login_html)
        unlock_prefix = app_html.split('id="unlock-form"', 1)[0]
        self.assertNotIn("device-phrase-prompt", unlock_prefix)
        self.assertIn(".device-phrase-prompt", css)
        self.assertIn("@media (max-width: 390px)", css)

    def test_no_server_prompt_api(self):
        app_py = (ROOT / "app" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("device_phrase_prompt", app_py)
        self.assertNotIn("notes_device_phrase_prompt_dismissed", app_py)


if __name__ == "__main__":
    unittest.main()
