"""Moltbook: pinned Ask AI (Ollama Cloud) disclosure on /verify + settings notice."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class MoltbookVerifyAskAiProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "moltbook-verify-ask-ai"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["SOURCE_DATE_EPOCH"] = "0"
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("moltbook-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {"app", "config", "ask_ai_provider_pin"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_verify_ask_ai_section_and_pin(self):
        import ask_ai_provider_pin

        resp = self.client.get("/verify")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertIn('id="verify-ask-ai"', html)
        self.assertIn("6. Ask AI with Ollama Cloud", html)
        self.assertIn("7. Optional: mitmproxy", html)
        self.assertIn('href="#verify-ask-ai">Ask AI details → section 6.', html)
        self.assertIn("What our server does:", html)
        self.assertIn("relays the request to ollama.com", html)
        self.assertIn("does <strong>not</strong> store your API key", html)
        self.assertNotIn("Deeperguard's server", html)
        self.assertNotIn("Deeperguard’s server", html)
        self.assertIn("Use the in-app send preview to see the exact payload", html)
        self.assertIn("checked 25 Oct 2026", html)
        self.assertIn(ask_ai_provider_pin.VERIFY_ASK_AI_PIN_ID, html)
        self.assertIn('name="notes-verify-ask-ai-pin"', html)
        self.assertIn("verify-ask-ai-provider.", html)
        self.assertNotIn("never logs", html.lower())
        self.assertIn("we update this section and show a notice in Ask AI Settings", html)
        self.assertNotIn("update this section and show a one-line", html)

    def test_app_shell_meta_and_notice(self):
        import ask_ai_provider_pin

        # App shell is behind login; use skip_login for HTML smoke.
        os.environ["NOTES_SKIP_LOGIN"] = "1"
        for name in list(sys.modules):
            if name in {"app"} or name.startswith("app."):
                sys.modules.pop(name, None)
        app_mod = importlib.import_module("app")
        client = app_mod.app.test_client()
        html = client.get("/app").get_data(as_text=True)
        self.assertIn('name="notes-verify-ask-ai-pin"', html)
        self.assertIn(ask_ai_provider_pin.VERIFY_ASK_AI_PIN_ID, html)
        self.assertIn('id="ai-chat-verify-pin-notice"', html)
        self.assertIn("review section 6 before sending note text", html)
        self.assertIn("verify-ask-ai-provider.", html)
        self.assertIn("our server relays the request to ollama.com", html)
        self.assertIn("checked 25 Oct 2026", html)
        self.assertIn("not stored beyond fulfilling the request", html)
        self.assertNotIn("never logs", html.lower())
        self.assertNotIn("Deeperguard server relays", html)


if __name__ == "__main__":
    unittest.main()
