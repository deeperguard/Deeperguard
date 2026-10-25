"""Round 80: Ask AI honesty — static copy exceptions + cloud relay confirm wiring."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCEPTION = (
    "except text you choose to send to Ask AI with Ollama Cloud, "
    "which passes through our server to ollama.com without being stored"
)


class Round80AskAiHonestyTests(unittest.TestCase):
    def test_marketing_and_compare_copy(self):
        marketing = (ROOT / "app/templates/marketing.html").read_text(encoding="utf-8")
        compare = (ROOT / "app/templates/compare-standard-notes.html").read_text(encoding="utf-8")
        self.assertIn("<strong>The server cannot read your notes</strong>", marketing)
        self.assertIn(EXCEPTION, marketing)
        self.assertIn(
            "The server never receives a readable copy unless you send text to Ask AI with Ollama Cloud.",
            marketing,
        )
        self.assertIn("stay unreadable to the host unless sent to Ask AI", marketing)
        self.assertIn("Stored notes: no.", marketing)
        self.assertNotIn("unstored", marketing)
        self.assertIn("Stored notes: no.", compare)
        self.assertIn(EXCEPTION, compare)
        self.assertNotIn("unstored", compare)

    def test_verify_zk_plain_legal(self):
        verify = (ROOT / "app/templates/verify.html").read_text(encoding="utf-8")
        zk = (ROOT / "app/templates/partials/zk-plain.html").read_text(encoding="utf-8")
        legal = (ROOT / "app/templates/legal.html").read_text(encoding="utf-8")
        self.assertIn(
            "never leave your device in plaintext, except text you choose to send to Ask AI with Ollama Cloud",
            verify,
        )
        self.assertIn(EXCEPTION, verify)
        self.assertNotIn("unstored", verify)
        self.assertIn(
            "we cannot read your notes (unless you send text to Ask AI with Ollama Cloud).",
            zk,
        )
        self.assertIn(
            "we cannot read note titles, body text, or attachment contents (unless you send text to Ask AI with Ollama Cloud)",
            legal,
        )

    def test_ai_chat_confirm_wiring(self):
        ai = (ROOT / "app/static/js/ai-chat.js").read_text(encoding="utf-8")
        app = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
        self.assertIn("CLOUD_RELAY_ACK_KEY", ai)
        self.assertIn("ensureCloudRelayConsent", ai)
        self.assertIn("ensureCloudSendConsent", ai)
        self.assertIn("CLOUD_ROUTE_LABEL", ai)
        self.assertIn(
            "Your message and any note content will go through Deeperguard's server to ollama.com. Nothing is stored. Send?",
            ai,
        )
        self.assertIn("confirm: (message, options) => confirmAction(message, options)", app)


if __name__ == "__main__":
    unittest.main()
