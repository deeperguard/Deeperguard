"""Round 59: View server copy GET + public /verify page."""
from __future__ import annotations

import importlib
import json
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DIR = REPO / "app"
sys.path.insert(0, str(APP_DIR))


class Round59ServerCopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round59"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        os.environ["NOTES_WEBAUTHN_ORIGIN"] = "https://www.deeperguard.com"
        os.environ.pop("NOTES_TURNSTILE_SECRET_KEY", None)
        os.environ.pop("NOTES_TURNSTILE_SITE_KEY", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round59-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app", "config", "auth", "db", "srp_auth", "auth_rate_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        try:
            import auth_rate_limit as arl

            arl._hits.clear()
        except Exception:
            pass
        self.tmp.cleanup()

    def _csrf(self) -> str:
        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return str(token)

    def _register(self, email: str, password: str):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        res = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
                "company": "",
            },
        )
        self.assertEqual(res.status_code, 200, res.get_json())
        return res.get_json()

    def test_verify_page_200_and_footer_link(self):
        res = self.client.get("/verify")
        self.assertEqual(res.status_code, 200)
        body = res.get_data(as_text=True)
        self.assertIn("Verify zero-knowledge", body)
        self.assertIn("/api/auth/srp/challenge", body)
        self.assertIn("/api/auth/srp/verify", body)
        self.assertIn("/api/sync/pull", body)
        self.assertIn("/api/sync/items", body)
        self.assertIn('"A"', body)
        self.assertIn("M1", body)
        self.assertIn("M2", body)
        self.assertIn("What these tests can’t prove", body)
        self.assertIn("How to check the code you’re running", body)
        self.assertIn("Our claim fails if", body)
        # Round 65: one SRI'd release-integrity.js is allowed at the end for the
        # automatic GitHub release-hash status. No early / inline scripts.
        head = body.lower().split("marketing.", 1)[0]
        self.assertNotIn("<script", head)
        scripts = [s for s in body.lower().split("<script") if s.strip()]
        # split leaves preamble then each script; expect exactly one script tag
        self.assertEqual(body.lower().count("<script"), 1)
        self.assertIn("release-integrity", body.lower())
        self.assertIn("integrity=", body.lower())

        home = self.client.get("/")
        self.assertEqual(home.status_code, 200)
        home_body = home.get_data(as_text=True)
        self.assertIn('href="/verify"', home_body)
        self.assertIn("verify zero-knowledge", home_body.lower())

        footer = (REPO / "app/templates/partials/mk-footer.html").read_text(encoding="utf-8")
        self.assertIn('href="/verify"', footer)

    def test_sync_item_get_owner_scoped(self):
        email = f"r59-{secrets.token_hex(4)}@example.com"
        password = "round59-server-copy"
        self._register(email, password)
        import db as notes_db

        user = notes_db.get_user_by_email(email)
        uid = int(user["id"])
        item_uuid = "11111111-2222-4333-8444-555555555555"
        cipher = json.dumps({"v": 1, "iv": "AAAAAAAAAAAAAAAA", "data": "QUFBQUFBQUFBQUE="})
        notes_db.upsert_item(
            uid,
            item_uuid,
            cipher,
            1,
            "hash-" + item_uuid[:8],
            False,
            time.time(),
            "",
        )

        # Signed-in owner can GET the raw row.
        res = self.client.get(f"/api/sync/item/{item_uuid}")
        self.assertEqual(res.status_code, 200, res.get_json())
        body = res.get_json()
        item = body["item"]
        self.assertEqual(item["item_uuid"], item_uuid)
        self.assertEqual(item["ciphertext"], cipher)
        self.assertIn("content_hash", item)
        self.assertIn("updated_at", item)
        self.assertIn("rev", item)
        # No decrypted fields invented by the server.
        self.assertNotIn("title", item)
        self.assertNotIn("content", item)

        # Missing id → 404 (anti-enumeration shape).
        miss = self.client.get("/api/sync/item/00000000-0000-4000-8000-000000000000")
        self.assertEqual(miss.status_code, 404)

        # Other account cannot read it.
        self.client.post("/api/auth/logout", headers={"X-CSRF-Token": self._csrf()})
        other = f"r59-other-{secrets.token_hex(4)}@example.com"
        self._register(other, password)
        denied = self.client.get(f"/api/sync/item/{item_uuid}")
        self.assertEqual(denied.status_code, 404)

    def test_client_wires_view_server_copy(self):
        app_js = (REPO / "app/static/js/app.js").read_text(encoding="utf-8")
        store_js = (REPO / "app/static/js/store.js").read_text(encoding="utf-8")
        html = (REPO / "app/templates/app.html").read_text(encoding="utf-8")
        self.assertIn("fetchServerItem", store_js)
        self.assertIn("/api/sync/item/", store_js)
        self.assertIn("openServerCopyView", app_js)
        # Lead copy lives once in the dialog markup (not re-set on success in JS).
        self.assertIn("Without your vault password it", html)
        self.assertIn("unreadable", html)
        self.assertIn("status.hidden = true", app_js)
        self.assertIn("note-info-server-copy", html)
        self.assertIn("server-copy-dialog", html)
        self.assertIn("data-server-copy", app_js)


if __name__ == "__main__":
    unittest.main()
