"""Round 77: Terms and Privacy page content (static HTML + marketing CSS)."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEGAL = ROOT / "app" / "templates" / "legal.html"
MARKETING_CSS = ROOT / "app" / "static" / "css" / "marketing.css"


class Round77TermsPrivacyTests(unittest.TestCase):
    def test_legal_template_has_terms_headings(self):
        text = LEGAL.read_text(encoding="utf-8")
        self.assertIn("page == 'terms'", text)
        for heading, anchor in (
            ("Operator identity", "operator-identity"),
            ("Limitation of liability", "limitation-of-liability"),
            ("DSA notice-and-action", "dsa-notice-and-action"),
            ("Changes to terms", "changes-to-terms"),
            ("Termination", "termination"),
            ("Governing law and disputes", "governing-law-and-disputes"),
            ("Acceptable use", "acceptable-use"),
        ):
            self.assertIn(f'<h2 id="{anchor}">{heading}</h2>', text)

    def test_legal_template_has_privacy_headings(self):
        text = LEGAL.read_text(encoding="utf-8")
        self.assertIn("page == 'privacy'", text)
        for heading, anchor in (
            ("Data controller", "data-controller"),
            ("What is processed and legal basis", "what-is-processed-and-legal-basis"),
            ("Retention", "retention"),
            ("Processors and server location", "processors-and-server-location"),
            ("Your rights", "your-rights"),
        ):
            self.assertIn(f'<h2 id="{anchor}">{heading}</h2>', text)

    def test_webdesigner_fix_round_copy(self):
        text = LEGAL.read_text(encoding="utf-8")
        css = MARKETING_CSS.read_text(encoding="utf-8")
        self.assertIn("Schutten Invest", text)
        self.assertIn("Dutch law (the Netherlands)", text)
        self.assertIn("the competent court in the Netherlands", text)
        self.assertIn(
            "without prejudice to any mandatory consumer rights to bring a claim in your own country",
            text,
        )
        self.assertIn("Austria (EU)", text)
        self.assertIn("netcup GmbH", text)
        self.assertNotIn("see deployment docs", text)
        self.assertNotIn("Germany (EU)", text)
        self.assertIn("notes@deeperguard.com", text)
        self.assertIn("You use Deeperguard at your own risk.", text)
        self.assertIn("as is</strong> during the public beta", text)
        self.assertIn("Keep your own backups using Export", text)
        self.assertIn("To the extent the law allows, Schutten Invest is not liable for loss of data", text)
        self.assertIn("except in case of intent or gross negligence", text)
        self.assertIn("Chamber of Commerce (KvK):", text)
        self.assertNotIn("(KvK), if any:", text)
        self.assertIn("AES-256-GCM, with keys derived from your password using Argon2id", text)
        self.assertIn("default on this deployment", text)
        self.assertNotIn("always on", text)
        self.assertIn("We keep up to <strong>14</strong> encrypted server backups", text)
        self.assertNotIn("NOTES_BACKUP_LOCAL_KEEP", text)
        self.assertNotIn("NOTES_SESSION_SECONDS", text)
        self.assertIn("the link stops working when it expires (max 7 days)", text)
        self.assertNotIn("purged", text)
        self.assertIn("Proton Mail", text)
        self.assertIn("encrypted account backups sent by email", text)
        self.assertIn("pCloud", text)
        self.assertIn("AI relay (Ollama Cloud)", text)
        self.assertIn(
            "Cloudflare may process connection data outside the EU under Standard Contractual Clauses.",
            text,
        )
        self.assertIn(
            "You can request account deletion at any time by emailing notes@deeperguard.com. "
            "Self-service deletion in Settings, with a 7-day undo window, is planned.",
            text,
        )
        self.assertNotIn("Settings or notes@deeperguard.com", text)
        self.assertIn(".mk-legal { max-width: 46rem; overflow-wrap: anywhere; }", css)
        # Brand spelling unchanged.
        self.assertIn("Deeperguard", text)
        self.assertNotIn("DeeperGuard", text)
        for ph in (
            "[ADDRESS]",
            "[RETENTION PERIOD]",
            "[OPERATOR NAME]",
            "[KVK NUMBER if any]",
            "[CONTACT EMAIL]",
            "[ABUSE CONTACT EMAIL]",
            "[SERVER LOCATION]",
            "[GOVERNING LAW, e.g. the Netherlands]",
            "[COURT]",
        ):
            self.assertNotIn(ph, text)
        leftover = re.findall(r"\[[A-Z][A-Z0-9 /.,_-]*\]", text)
        self.assertEqual(leftover, [], f"leftover placeholders: {leftover}")

    def test_last_updated_and_no_draft_banner_on_page(self):
        text = LEGAL.read_text(encoding="utf-8")
        self.assertIn("Last updated: 24 October 2026", text)
        self.assertNotIn("Draft – to be reviewed by a lawyer", text)
        self.assertNotIn("Draft - to be reviewed by a lawyer", text)

    def test_pages_render_via_routes(self):
        """Both routes return 200 and expose the new section headings."""
        import importlib
        import os
        import sys
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "r77"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        app_dir = ROOT / "app"
        if str(app_dir) not in sys.path:
            sys.path.insert(0, str(app_dir))
        for name in list(sys.modules):
            if name in {"app", "auth", "db", "config", "admin_api", "client_assets"} or name.startswith(
                "app."
            ):
                sys.modules.pop(name, None)
        try:
            app_mod = importlib.import_module("app")
            client = app_mod.app.test_client()
            privacy = client.get("/privacy")
            terms = client.get("/terms")
            self.assertEqual(privacy.status_code, 200)
            self.assertEqual(terms.status_code, 200)
            phtml = privacy.get_data(as_text=True)
            thtml = terms.get_data(as_text=True)
            self.assertIn('id="data-controller"', phtml)
            self.assertIn("What is processed and legal basis", phtml)
            self.assertIn("Retention", phtml)
            self.assertIn("Processors and server location", phtml)
            self.assertIn("Your rights", phtml)
            self.assertIn("Autoriteit Persoonsgegevens", phtml)
            self.assertIn("Operator identity", thtml)
            self.assertIn("Limitation of liability", thtml)
            self.assertIn("DSA notice-and-action", thtml)
            self.assertIn("Governing law and disputes", thtml)
            self.assertIn("Termination", thtml)
            self.assertIn("Schutten Invest", phtml)
            self.assertIn("Schutten Invest", thtml)
            self.assertIn("Dutch law (the Netherlands)", thtml)
            self.assertIn("Austria (EU)", phtml)
            self.assertIn("netcup GmbH", phtml)
            self.assertIn("Proton Mail", phtml)
            self.assertIn("pCloud", phtml)
            self.assertIn("AI relay (Ollama Cloud)", phtml)
            self.assertIn("Standard Contractual Clauses", phtml)
            self.assertIn("AES-256-GCM", phtml)
            self.assertIn("Argon2id", phtml)
            self.assertIn("We keep up to", phtml)
            self.assertIn("14", phtml)
            self.assertIn("the link stops working when it expires (max 7 days)", phtml)
            self.assertIn(
                "Self-service deletion in Settings, with a 7-day undo window, is planned.",
                thtml,
            )
            self.assertIn("To the extent the law allows", thtml)
            self.assertNotIn("see deployment docs", phtml)
            self.assertNotIn("Germany (EU)", phtml)
            self.assertNotIn("purged", phtml)
            self.assertNotIn("NOTES_BACKUP_LOCAL_KEEP", phtml)
            self.assertIn("notes@deeperguard.com", phtml)
            self.assertIn("notes@deeperguard.com", thtml)
            self.assertIn("You use Deeperguard at your own risk.", thtml)
            self.assertIn("during the public beta", thtml)
            self.assertIn("using Export", thtml)
            self.assertIn("Lisdodde 66, 2408 LX Alphen aan den Rijn", phtml)
            self.assertIn("Chamber of Commerce (KvK):", phtml)
            self.assertIn("KvK 99268876", phtml)
            self.assertIn("KvK 99268876", thtml)
            self.assertNotIn("[ADDRESS]", phtml)
            self.assertNotIn("[RETENTION PERIOD]", phtml)
            self.assertIn("30 days", phtml)
            self.assertIn("300 seconds", phtml)
            self.assertIn("30 minutes", phtml)
            self.assertIn("Last updated: 24 October 2026", phtml)
            self.assertIn("Last updated: 24 October 2026", thtml)
            self.assertNotIn("Draft – to be reviewed by a lawyer", phtml)
            self.assertNotIn("Draft – to be reviewed by a lawyer", thtml)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
