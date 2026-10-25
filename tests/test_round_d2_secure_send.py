"""D2 Secure Send: opaque ciphertext, fragment key, Open burns, previews do not."""
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

APP_DIR = Path(__file__).resolve().parents[1] / "app"
ROOT = Path(__file__).resolve().parents[1]
# Always put app/ first: with repo root on sys.path, bare "import app" binds the empty package.
sys.path = [p for p in sys.path if p != str(APP_DIR)]
sys.path.insert(0, str(APP_DIR))


class D2SecureSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "d2test"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "secure_send",
                "auth_rate_limit",
                "client_assets",
                "srp_auth",
                "passwords",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()
        self._login()

    def tearDown(self):
        self.tmp.cleanup()

    def _login(self):
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "d2sender@example.com"
        password = "correct-horse-battery-staple"
        salt = new_srp_salt_hex()
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        reg = self.client.post(
            "/api/auth/srp/register",
            json={
                "email": email,
                "srp_salt": salt,
                "srp_verifier": verifier,
                "srp_kdf_version": 2,
            },
        )
        self.assertEqual(reg.status_code, 200, reg.get_json())

    def _csrf(self):
        with self.client.session_transaction() as sess:
            return sess.get("csrf") or secrets.token_urlsafe(16)

    def _create(self, **overrides):
        body = {
            "ciphertext": {"v": 1, "iv": "AAECAwQFBgcICQoLDA0ODw==", "data": "AQIDBAUGBwgJ"},
            "expires_in": 3600,
            "max_views": 1,
        }
        body.update(overrides)
        return self.client.post(
            "/api/secure-send",
            json=body,
            headers={"X-CSRF-Token": self._csrf()},
        )

    def test_create_list_cancel_opaque_metadata(self):
        import db as notes_db
        import secure_send as ss

        created = self._create(max_views=3)
        self.assertEqual(created.status_code, 200, created.get_json())
        data = created.get_json()
        send_id = data["id"]
        self.assertTrue(ss.valid_id(send_id))
        self.assertTrue(ss.blob_path(send_id).is_file())
        self.assertIn("ciphertext_len", data)
        self.assertNotIn("has_file", data)
        self.assertNotIn("has_passphrase", data)
        self.assertNotIn("filename", data)

        row = notes_db.get_secure_send(send_id)
        # DB holds length only — legacy flag columns stay zero (no plaintext file meta).
        self.assertEqual(int(row["has_file"]), 0)
        self.assertEqual(int(row["has_passphrase"]), 0)
        self.assertEqual(int(row["byte_size"]), int(data["ciphertext_len"]))

        listed = self.client.get("/api/secure-send/sent")
        self.assertEqual(listed.status_code, 200)
        item = listed.get_json()["items"][0]
        self.assertEqual(item["status"], "active")
        self.assertEqual(item["status_label"], "Waiting")
        self.assertIn("created_at", item)
        self.assertNotIn("ciphertext_len", item)
        self.assertNotIn("has_file", item)
        self.assertNotIn("filename", json.dumps(item))

        canceled = self.client.post(
            f"/api/secure-send/{send_id}/cancel",
            json={},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(canceled.status_code, 200)
        msg = canceled.get_json().get("message", "").lower()
        self.assertTrue("stopped working" in msg or "stops working" in msg)
        self.assertFalse(ss.blob_path(send_id).is_file())
        self.assertEqual(self.client.get(f"/receive/{send_id}").status_code, 404)

    def test_rejects_plaintext_file_metadata_and_keys(self):
        for payload in (
            {"filename": "secret.pdf"},
            {"file_name": "secret.pdf"},
            {"mime": "application/pdf"},
            {"file_size": 12},
            {"key": "v1.abc"},
            {"fragment": "v1.x"},
            {"passphrase": "x"},
        ):
            bad = self._create(**payload)
            self.assertEqual(bad.status_code, 400, payload)

    def test_preview_get_and_head_do_not_burn(self):
        import secure_send as ss

        created = self._create(max_views=1)
        send_id = created.get_json()["id"]
        self.assertTrue(ss.blob_path(send_id).is_file())

        head = self.client.head(f"/receive/{send_id}")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.headers.get("Content-Disposition", "inline"), "inline")
        self.assertTrue(ss.blob_path(send_id).is_file())

        page = self.client.get(f"/receive/{send_id}")
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn("receive-open", html)
        self.assertIn("Someone sent you an encrypted note", html)
        self.assertIn("This can be opened once.", html)
        self.assertIn("stops working", html.lower())
        self.assertNotIn("deleted", html.lower())
        self.assertNotIn("fragment", html.lower().split("receive-boot")[0])
        self.assertNotIn("ciphertext", html.lower().split("receive-boot")[0])
        self.assertRegex(html, r"secure-send\.[0-9a-f]{16}\.js")
        self.assertRegex(html, r"secure-send-receive\.[0-9a-f]{16}\.js")
        self.assertIn("integrity=", html)
        self.assertTrue(ss.blob_path(send_id).is_file())

        opened = self.client.post(
            f"/api/secure-send/{send_id}/open",
            json={},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(opened.status_code, 200, opened.get_json())
        body = opened.get_json()
        self.assertIn("ciphertext", body)
        self.assertNotIn("has_file", body)
        self.assertNotIn("filename", json.dumps(body))
        self.assertEqual(opened.headers.get("Content-Disposition"), "inline")
        self.assertNotIn("filename=", (opened.headers.get("Content-Disposition") or "").lower())
        self.assertFalse(ss.blob_path(send_id).is_file())
        again = self.client.post(
            f"/api/secure-send/{send_id}/open",
            json={},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(again.status_code, 404)

    def test_expiry_and_max_seven_days(self):
        import secure_send as ss
        import db as notes_db

        over = self._create(expires_in=30 * 24 * 3600)
        self.assertEqual(over.status_code, 200)
        send_id = over.get_json()["id"]
        row = notes_db.get_secure_send(send_id)
        self.assertLessEqual(float(row["expires_at"]) - time.time(), ss.MAX_EXPIRES_SECONDS + 5)
        with notes_db.tx() as conn:
            conn.execute(
                "UPDATE secure_sends SET expires_at = ? WHERE id = ?",
                (time.time() - 10, send_id),
            )
        stopped = self.client.get(f"/receive/{send_id}")
        self.assertEqual(stopped.status_code, 404)
        stopped_html = stopped.get_data(as_text=True)
        self.assertIn("Ask the sender for a new one", stopped_html)
        self.assertIn("Someone sent you an encrypted note", stopped_html)

    def test_ciphertext_too_large(self):
        import secure_send as ss

        huge = "A" * (ss.MAX_CIPHERTEXT_BYTES + 10)
        too_big = self._create(ciphertext={"v": 1, "iv": "AAECAwQFBgcICQoLDA0ODw==", "data": huge})
        self.assertEqual(too_big.status_code, 413)

    def test_rate_limit_buckets_exist(self):
        app_py = (ROOT / "app" / "app.py").read_text(encoding="utf-8")
        self.assertIn("secure-send-create-ip:", app_py)
        self.assertIn("secure-send-create-user:", app_py)
        self.assertIn("secure-send-open-ip:", app_py)
        self.assertIn("secure-send-open-sender:", app_py)

    def test_copy_never_says_deleted(self):
        js = (ROOT / "app" / "static" / "js" / "secure-send.js").read_text(encoding="utf-8")
        recv = (ROOT / "app" / "static" / "js" / "secure-send-receive.js").read_text(
            encoding="utf-8"
        )
        py = (ROOT / "app" / "secure_send.py").read_text(encoding="utf-8")
        for src in (js, recv, py):
            self.assertTrue(
                "stopped working" in src.lower() or "stops working" in src.lower()
            )
            self.assertNotRegex(src.lower(), r"\bdeleted\b")

    def test_manifest_and_verify_cover_receive(self):
        """Spec §3: share/open JS in signed manifest + SRI; /verify documents it."""
        manifest = json.loads(
            (ROOT / "app" / "static" / "client-manifest.json").read_text(encoding="utf-8")
        )
        assets = manifest.get("assets") or {}
        self.assertIn("js/secure-send.js", assets)
        self.assertIn("js/secure-send-receive.js", assets)
        for key in ("js/secure-send.js", "js/secure-send-receive.js"):
            entry = assets[key]
            self.assertTrue(entry.get("sri") or entry.get("integrity") or entry.get("sha384"))
        verify = (ROOT / "app" / "templates" / "verify.html").read_text(encoding="utf-8")
        self.assertIn("verify-secure-send", verify)
        self.assertIn("secure-send", verify.lower())
        self.assertIn("fragment", verify.lower())
        self.assertIn("integrity", verify.lower())

    def test_passphrase_kdf_uses_argon2id(self):
        """Spec §2: slow KDF (Argon2id / vault v2) combined with fragment key."""
        js = (ROOT / "app" / "static" / "js" / "secure-send.js").read_text(encoding="utf-8")
        self.assertIn("VAULT_KDF_V2", js)
        self.assertIn("derivePassphraseContentKey", js)
        self.assertIn("v1p.", js)
        self.assertIn("Argon2id", js)

    def test_no_email_on_secure_send_paths(self):
        app_py = (ROOT / "app" / "app.py").read_text(encoding="utf-8")
        idx = app_py.index("def api_secure_send_create")
        end = app_py.index("def contact_page")
        chunk = app_py[idx:end]
        self.assertNotIn("send_plain_email", chunk)
        self.assertNotIn("send_contact_email", chunk)
        self.assertNotIn("mailer", chunk)

    def test_max_views_capped_at_ten(self):
        import secure_send as ss
        import db as notes_db

        self.assertEqual(ss.MAX_VIEWS_CAP, 10)
        self.assertEqual(ss.DEFAULT_MAX_VIEWS, 1)
        self.assertEqual(ss.clamp_max_views(50), 10)
        self.assertEqual(ss.clamp_max_views(None), 1)
        created = self._create(max_views=50)
        self.assertEqual(created.status_code, 200)
        row = notes_db.get_secure_send(created.get_json()["id"])
        self.assertEqual(int(row["max_views"]), 10)

    def test_passphrase_verifier_required_before_view_burn(self):
        import db as notes_db
        import secure_send as ss

        created = self._create(max_views=1, open_verifier="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        self.assertEqual(created.status_code, 200)
        send_id = created.get_json()["id"]
        self.assertTrue(ss.blob_path(send_id).is_file())

        # Wrong verifier must not burn the open.
        wrong = self.client.post(
            f"/api/secure-send/{send_id}/open",
            json={"open_verifier": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(wrong.status_code, 401, wrong.get_json())
        self.assertEqual(wrong.get_json().get("error"), "wrong_passphrase")
        self.assertEqual(wrong.get_json().get("attempts_left"), 4)
        self.assertTrue(ss.blob_path(send_id).is_file())
        row = notes_db.get_secure_send(send_id)
        self.assertEqual(int(row["views_used"]), 0)

        # Correct verifier burns the open and returns ciphertext.
        ok = self.client.post(
            f"/api/secure-send/{send_id}/open",
            json={"open_verifier": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(ok.status_code, 200, ok.get_json())
        self.assertIn("ciphertext", ok.get_json())
        self.assertFalse(ss.blob_path(send_id).is_file())

    def test_passphrase_verifier_lockout_stops_link(self):
        import db as notes_db
        import secure_send as ss

        created = self._create(max_views=1, open_verifier="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        send_id = created.get_json()["id"]
        for i in range(5):
            res = self.client.post(
                f"/api/secure-send/{send_id}/open",
                json={"open_verifier": "wrongwrongwrongwrongwrongwrongwrongwrongwo"},
                headers={"Sec-Fetch-Site": "same-origin"},
            )
            if i < 4:
                self.assertEqual(res.status_code, 401)
            else:
                self.assertEqual(res.status_code, 404)
        self.assertFalse(ss.blob_path(send_id).is_file())
        row = notes_db.get_secure_send(send_id)
        self.assertIsNotNone(row["locked_out_at"])
        self.assertIsNone(row["canceled_at"])
        listed = self.client.get("/api/secure-send/sent")
        self.assertEqual(listed.status_code, 200)
        item = next(i for i in listed.get_json()["items"] if i["id"] == send_id)
        self.assertEqual(item["status"], "locked_out")
        self.assertEqual(item["status_label"], "Stopped: too many wrong passphrases")
        stopped = self.client.get(f"/receive/{send_id}")
        self.assertEqual(stopped.status_code, 404)
        html = stopped.get_data(as_text=True)
        self.assertIn("Ask the sender for a new one", html)
        self.assertIn('id="receive-heading"', html)
        self.assertIn("hidden", html.split('id="receive-heading"', 1)[1][:40])

    def test_receive_intro_uses_remaining_opens_without_burning(self):
        import secure_send as ss

        self.assertEqual(ss.receive_opens_intro(1), "This can be opened once.")
        self.assertEqual(ss.receive_opens_intro(3), "This can be opened 3 more times.")
        created = self._create(max_views=3)
        send_id = created.get_json()["id"]
        page = self.client.get(f"/receive/{send_id}")
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn("This can be opened 3 more times.", html)
        self.assertIn('"viewsRemaining": 3', html)
        # GET must not burn a view.
        listed = self.client.get("/api/secure-send/sent")
        item = next(i for i in listed.get_json()["items"] if i["id"] == send_id)
        self.assertEqual(int(item["views_used"]), 0)
        self.assertEqual(item["status"], "active")
        # Still one open available after a single burn.
        opened = self.client.post(
            f"/api/secure-send/{send_id}/open",
            json={},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(opened.status_code, 200)
        again = self.client.get(f"/receive/{send_id}")
        self.assertEqual(again.status_code, 200)
        self.assertIn("This can be opened 2 more times.", again.get_data(as_text=True))

    def test_receive_intro_once_for_single_open(self):
        created = self._create(max_views=1)
        send_id = created.get_json()["id"]
        page = self.client.get(f"/receive/{send_id}")
        self.assertEqual(page.status_code, 200)
        self.assertIn("This can be opened once.", page.get_data(as_text=True))

    def test_share_link_is_textarea_with_break_all(self):
        app_html = (ROOT / "app" / "templates" / "app.html").read_text(encoding="utf-8")
        css = (ROOT / "app" / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn('<textarea id="secure-send-link"', app_html)
        self.assertIn("word-break: break-all", css)
        self.assertIn(
            "Send an encrypted note and optional file. The key is in the link itself",
            app_html,
        )

    def test_no_math_random_in_secure_send_js(self):
        for name in ("secure-send.js", "secure-send-receive.js"):
            src = (ROOT / "app" / "static" / "js" / name).read_text(encoding="utf-8")
            self.assertNotIn("Math.random", src, name)

    def test_secure_send_note_attachment_staging_js(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        script = ROOT / "tests" / "test_secure_send_note_attachments.js"
        completed = subprocess.run(
            [node, str(script)],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)

    def test_share_by_link_stages_note_attachments_in_app_js(self):
        app_js = (ROOT / "app" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("NotesSecureSendNoteAttachments", app_js)
        self.assertIn("stageSecureSendNoteAttachments", app_js)
        self.assertNotIn("multiple attachments. Pick a file", app_js)
        app_html = (ROOT / "app" / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("secure-send-note-attachments.js", app_html)
        self.assertIn("secure-send-file-inclusion", app_html)
        self.assertIn("secure-send-file-picker-wrap", app_html)
        self.assertIn("btn-secure-send-use-different-file", app_html)
        self.assertIn("setSecureSendFileInclusion", app_js)
        self.assertIn("From this note", app_js)
        self.assertIn("Use a different file", app_js)
        self.assertIn("updateSecureSendFilePickerUi", app_js)


if __name__ == "__main__":
    unittest.main()
