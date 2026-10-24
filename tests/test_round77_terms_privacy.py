"""Round 77: Terms and Privacy page content (static HTML only)."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEGAL = ROOT / "app" / "templates" / "legal.html"


class Round77TermsPrivacyTests(unittest.TestCase):
    def test_legal_template_has_terms_headings(self):
        text = LEGAL.read_text(encoding="utf-8")
        self.assertIn("page == 'terms'", text)
        for heading in (
            "Operator identity",
            "Limitation of liability",
            "DSA notice-and-action",
            "Changes to terms",
            "Termination",
            "Governing law and disputes",
            "Acceptable use",
        ):
            self.assertIn(f"<h2>{heading}</h2>", text)

    def test_legal_template_has_privacy_headings(self):
        text = LEGAL.read_text(encoding="utf-8")
        self.assertIn("page == 'privacy'", text)
        for heading in (
            "Data controller",
            "What is processed and legal basis",
            "Retention",
            "Processors and server location",
            "Your rights",
        ):
            self.assertIn(f"<h2>{heading}</h2>", text)

    def test_placeholders_present(self):
        text = LEGAL.read_text(encoding="utf-8")
        # Filled from Dennis (24 Oct); remaining placeholders stay until supplied.
        self.assertIn("Schutten Invest", text)
        self.assertIn("Dutch law (the Netherlands)", text)
        self.assertIn("the competent court in the Netherlands", text)
        self.assertIn(
            "without prejudice to any mandatory consumer rights to bring a claim in your own country",
            text,
        )
        self.assertIn("Germany (EU)", text)
        self.assertNotIn("[OPERATOR NAME]", text)
        self.assertNotIn("[GOVERNING LAW, e.g. the Netherlands]", text)
        self.assertNotIn("[COURT]", text)
        self.assertNotIn("[SERVER LOCATION]", text)
        for ph in (
            "[ADDRESS]",
            "[KVK NUMBER if any]",
            "[CONTACT EMAIL]",
            "[ABUSE CONTACT EMAIL]",
            "[RETENTION PERIOD]",
        ):
            self.assertIn(ph, text)

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
            self.assertIn("Data controller", phtml)
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
            self.assertIn("Germany (EU)", phtml)
            self.assertIn("[ABUSE CONTACT EMAIL]", thtml)
            self.assertIn("[ADDRESS]", phtml)
            self.assertIn("[CONTACT EMAIL]", thtml)
            self.assertIn("Last updated: 24 October 2026", phtml)
            self.assertIn("Last updated: 24 October 2026", thtml)
            # Page must stay static / text-safe (no draft banner on the public page).
            self.assertNotIn("Draft – to be reviewed by a lawyer", phtml)
            self.assertNotIn("Draft – to be reviewed by a lawyer", thtml)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
