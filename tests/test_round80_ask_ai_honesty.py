"""Round 80: Ask AI honesty — static copy exceptions + cloud relay confirm wiring."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCEPTION = (
    "except text you choose to send to Ask AI with Ollama Cloud, "
    "which passes through our server to ollama.com unstored"
)


class Round80AskAiHonestyTests(unittest.TestCase):
    def test_marketing_and_compare_copy(self):
        marketing = (ROOT / "app/templates/marketing.html").read_text(encoding="utf-8")
        compare = (ROOT / "app/templates/compare-standard-notes.html").read_text(encoding="utf-8")
        self.assertIn("The server cannot read your notes", marketing)
        self.assertIn(EXCEPTION, marketing)
        self.assertIn("Can Deeperguard or its host read my notes?", marketing)
        self.assertIn(EXCEPTION, compare)

    def test_verify_claim_copy(self):
        verify = (ROOT / "app/templates/verify.html").read_text(encoding="utf-8")
        self.assertIn(
            "never leave your device in plaintext, except text you choose to send to Ask AI with Ollama Cloud",
            verify,
        )
        self.assertIn("never appear on the wire, except text you choose to send to Ask AI with Ollama Cloud", verify)
        self.assertIn('data-claim-version="2"', verify)

    def test_ai_chat_confirm_wiring(self):
        ai = (ROOT / "app/static/js/ai-chat.js").read_text(encoding="utf-8")
        app = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
        self.assertIn("CLOUD_RELAY_ACK_KEY", ai)
        self.assertIn("ensureCloudRelayConsent", ai)
        self.assertIn("through Deeperguard's server to ollama.com. It isn't stored. Continue?", ai)
        self.assertIn("confirm: (message, options) => confirmAction(message, options)", app)


if __name__ == "__main__":
    unittest.main()
