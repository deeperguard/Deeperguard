"""Tests for Deeperguard."""
import importlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from io import BytesIO
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


class NotesAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        # Pin build so host EnvironmentFile (e.g. live CT) cannot override defaults.
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ.pop("NOTES_SERVER_OCR", None)
        os.environ.pop("NOTES_ADMIN_EMAILS", None)
        os.environ.pop("NOTES_DEFAULT_USER_QUOTA_MB", None)
        os.environ.pop("NOTES_DEFAULT_PLAN", None)
        os.environ.pop("NOTES_DISABLE_CIDR_GATE", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {"app", "auth", "db", "config", "passwords", "totp", "ocr", "ocr_index", "ocr_jobs", "server_info_cache", "backup_pcloud", "backup_mail", "srp_auth", "webauthn_helper", "admin_api", "admin_notify", "auth_rate_limit", "plans", "ai_relay"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_ALLOWED_CIDRS", "NOTES_SKIP_LOGIN", "NOTES_BUILD", "NOTES_SERVER_INFO_REFRESH", "NOTES_SERVER_OCR", "NOTES_STRICT_ZK", "NOTES_ADMIN_EMAILS", "NOTES_DEFAULT_USER_QUOTA_MB", "NOTES_DEFAULT_PLAN", "NOTES_APP_PATH", "NOTES_AUTH_RATE_LIMIT", "NOTES_REPAIR_LOGIN_PASSWORD"):
            os.environ.pop(key, None)

    def _srp_verifier(self, email: str, password: str, salt_hex: str | None = None) -> tuple[str, str]:
        import hashlib

        from srp_auth import G, N

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(hashlib.sha256(text.encode("utf-8")).hexdigest())

        if not salt_hex:
            salt_hex = sha_hex(f"test-salt::{email}")
        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{salt_hex}{hash1}".upper())
        x = int(x_hash, 16) % N
        return salt_hex, format(pow(G, x, N), "x")

    def _register_user(self, email: str, password: str):
        salt_hex, verifier = self._srp_verifier(email, password)
        return self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )

    def _register_legacy_user(self, email: str, password: str):
        import secrets
        import time

        import db as notes_db
        from config import SESSION_SECONDS
        from passwords import hash_password, new_kdf_salt

        user_id = notes_db.create_user(email, hash_password(password), new_kdf_salt())
        with self.client.session_transaction() as sess:
            sess["uid"] = int(user_id)
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True

    def _srp_login(self, email: str, password: str, salt_hex: str):
        import secrets

        from srp_auth import G, K, N, _from_hex, _h, _to_hex

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(_h(text))

        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        body = challenge.get_json()
        b_hex = str(body["B"]).lower()
        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{salt_hex}{hash1}".upper())
        x = int(x_hash, 16) % N
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        A = pow(G, a, N)
        a_hex = _to_hex(A)
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        s_hex = _to_hex(S)
        m1 = _h(a_hex + b_hex + s_hex)
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": a_hex, "M1": m1},
        )
        return verify

    def _srp_credential_proof(
        self,
        email: str,
        password: str,
        salt_hex: str,
        challenge_path: str,
        *,
        headers: dict | None = None,
    ):
        """Challenge + proof against the server-returned (stored) salt/verifier.

        `password` is the password used for the proof; `salt_hex` only seeds the
        rotation verifier returned as the third tuple element.
        """
        import secrets

        from srp_auth import G, K, N, _from_hex, _h, _to_hex

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(_h(text))

        from srp_auth import generate_verifier_hex

        rotation_verifier = generate_verifier_hex(salt_hex, email, password)
        challenge = self.client.post(
            challenge_path,
            json={"email": email},
            headers=headers or {},
        )
        self.assertEqual(challenge.status_code, 200, challenge.get_json())
        b_hex = str(challenge.get_json()["B"]).lower()
        stored_salt = str(challenge.get_json()["srp_salt"]).lower()
        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{stored_salt}{hash1}".upper())
        x = int(x_hash, 16) % N
        byte_len = (N.bit_length() + 7) // 8
        while True:
            a_bytes = secrets.token_bytes(byte_len)
            a = int.from_bytes(a_bytes, "big") % N
            if a != 0:
                break
        A = pow(G, a, N)
        a_hex = _to_hex(A)
        u = _from_hex(_h(a_hex + b_hex))
        B = _from_hex(b_hex)
        v = pow(G, x, N)
        tmp = (v * K) % N
        S = pow((B - tmp + N) % N, (u * x + a) % N, N)
        s_hex = _to_hex(S)
        m1 = _h(a_hex + b_hex + s_hex)
        return a_hex, m1, rotation_verifier

    def test_server_info_requires_admin(self):
        self._register_user("plain@home.local", "plain-secure-pass")
        res = self.client.get("/api/server/info", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(res.status_code, 403)

    def test_server_info_returns_vault_and_disk_stats(self):
        import db as notes_db
        import server_info_cache as sic
        from config import DATA_DIR

        self._register_user("stats@home.local", "stats-secure-pass")
        user = notes_db.get_user_by_email("stats@home.local")
        notes_db.update_user_admin_flag(int(user["id"]), True)
        self.assertIsNotNone(user)
        sic.refresh_user(int(user["id"]))
        res = self.client.get("/api/server/info", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])
        self.assertTrue(data["cached"])
        self.assertEqual(data["sync_items"], 0)
        self.assertEqual(data["vault_bytes"], 0)
        self.assertIn("server", data)
        self.assertGreater(data["server"]["disk_total_bytes"], 0)
        self.assertGreaterEqual(data["server"]["disk_free_bytes"], 0)
        self.assertIn("ocr_bytes_total", data["server"])
        ocr_dir = DATA_DIR / "ocr" / str(int(user["id"]))
        ocr_dir.mkdir(parents=True, exist_ok=True)
        (ocr_dir / "sample.bin").write_bytes(b"x" * 2048)
        sic.refresh_user(int(user["id"]))
        res2 = self.client.get("/api/server/info", headers={"X-CSRF-Token": self._csrf()})
        from config import ocr_ephemeral

        expected_ocr = 0 if ocr_ephemeral() else 2048
        self.assertEqual(res2.get_json()["ocr_bytes"], expected_ocr)

    def test_server_info_cache_persists_on_disk(self):
        import db as notes_db
        import server_info_cache as sic
        from config import DATA_DIR

        self._register_user("cache@home.local", "cache-secure-pass")
        user = notes_db.get_user_by_email("cache@home.local")
        payload = sic.refresh_user(int(user["id"]))
        cache_file = DATA_DIR / "server-info-cache" / f"user-{int(user['id'])}.json"
        self.assertTrue(cache_file.is_file())
        sic._memory.clear()
        loaded = sic.get(int(user["id"]))
        self.assertEqual(loaded["computed_at"], payload["computed_at"])
        self.assertEqual(loaded["vault_bytes"], payload["vault_bytes"])

    def test_health(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["build"], "192")
        self.assertIn("ocr_queue", data)
        self.assertIn("db_bytes", data)
        self.assertIn("checks", data)
        self.assertIn("server", data)
        self.assertFalse(res.headers.get("Clear-Site-Data"))
        again = self.client.get("/api/health")
        self.assertFalse(again.headers.get("Clear-Site-Data"))

    # Check that marketing features are all present and clearly pitted
    def test_homepage_distinction_and_pricing(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Standard Notes", res.data)
        self.assertIn(b"Notesnook", res.data)
        self.assertIn(b"Joplin", res.data)
        self.assertIn(b"Evernote", res.data)
        self.assertIn(b"Public Beta", res.data)
        self.assertIn(b"pricing", res.data.lower())
        self.assertIn(b"Free", res.data)
        self.assertIn(b"On-Device", res.data)
        self.assertIn(b"encrypted notes", res.data.lower())
        self.assertIn(b"id=\"discover\"", res.data)

    def test_homepage_serves_marketing(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Zero-knowledge", res.data)
        self.assertIn(b"Open notes app", res.data)
        self.assertIn(b'href="https://www.deeperguard.com/app"', res.data)
        self.assertIn(b"Sign in", res.data)
        self.assertIn(b'href="https://www.deeperguard.com/login"', res.data)
        self.assertIn(b"Standard Notes", res.data)
        self.assertIn(b"Evernote", res.data)
        self.assertIn(b'id="compare"', res.data)
        self.assertIn(b'id="contact-form"', res.data)
        self.assertIn(b"notes@deeperguard.com", res.data)
        self.assertIn(b"Basic", res.data)
        self.assertIn(b"Pro", res.data)
        self.assertIn(b"marketing.css", res.data)
        self.assertNotIn(b'id="editor"', res.data)
        self.assertFalse(res.headers.get("Clear-Site-Data"))
        self.assertIn("max-age=300", res.headers.get("Cache-Control") or "")

    def test_notes_app_entry_serves_shell(self):
        res = self.client.get("/app")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'id="editor"', res.data)
        self.assertIn(b'data-notes-boot', res.data)

    def test_legacy_root_note_deep_link_redirects_to_app(self):
        res = self.client.get("/?note=11111111-1111-4111-8111-111111111111", follow_redirects=False)
        self.assertEqual(res.status_code, 302)
        self.assertIn("/app?note=", res.headers.get("Location", ""))

    def test_pricing_page_serves_marketing(self):
        res = self.client.get("/pricing")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"id=\"pricing\"", res.data)

    def test_compare_standard_notes_is_public(self):
        res = self.client.get("/compare/standard-notes", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("Location", res.headers)
        self.assertIn(b"Standard Notes alternative", res.data)
        self.assertIn(b"encrypted notes alternative (PWA + OCR)", res.data)
        self.assertIn(b"Import Standard Notes or Deeperguard backup", res.data)
        self.assertIn(b"marketing.css", res.data)
        self.assertIn("max-age=300", res.headers.get("Cache-Control") or "")

    def test_homepage_links_standard_notes_compare_page(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'href="/compare/standard-notes"', res.data)
        self.assertIn(b"Full Standard Notes comparison", res.data)

    def test_homepage_has_seo_tags(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'rel="canonical"', res.data)
        self.assertIn(b"application/ld+json", res.data)
        self.assertIn(b"og:image", res.data)
        self.assertIn(b"Deeperguard (encrypted notes)", res.data)
        self.assertIn(b"DeepGuard deepfake", res.data)

    def test_robots_and_sitemap_are_public(self):
        robots = self.client.get("/robots.txt")
        self.assertEqual(robots.status_code, 200)
        self.assertIn(b"Sitemap:", robots.data)
        self.assertIn(b"/api/promo", robots.data)
        sm = self.client.get("/sitemap.xml")
        self.assertEqual(sm.status_code, 200)
        self.assertIn(b"<loc>", sm.data)
        self.assertIn(b"/api/promo</loc>", sm.data)

    def test_api_promo_returns_outreach_copy(self):
        res = self.client.get("/api/promo")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("ok"))
        self.assertIn("reddit", data.get("copy", {}))
        self.assertIn("directories", data)

    def test_contact_form_sends_email(self):
        from unittest.mock import patch

        sent = []
        with patch("app.send_contact_email", side_effect=lambda *a, **k: sent.append((a, k))):
            res = self.client.post(
                "/api/contact",
                headers={"Sec-Fetch-Site": "same-origin"},
                json={
                    "name": "Ada Lovelace",
                    "email": "ada@example.com",
                    "subject": "Beta question",
                    "message": "Hello, I have a question about encrypted backups.",
                },
            )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json().get("ok"))
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0][0], "notes@deeperguard.com")
        self.assertEqual(sent[0][1]["sender_email"], "ada@example.com")

    def test_contact_form_rejects_cross_origin(self):
        res = self.client.post(
            "/api/contact",
            headers={"Sec-Fetch-Site": "cross-site"},
            json={
                "name": "Ada Lovelace",
                "email": "ada@example.com",
                "subject": "Beta question",
                "message": "Hello, I have a question about encrypted backups.",
            },
        )
        self.assertEqual(res.status_code, 403)

    def test_contact_form_rejects_short_message(self):
        res = self.client.post(
            "/api/contact",
            headers={"Sec-Fetch-Site": "same-origin"},
            json={"email": "ada@example.com", "message": "Hi"},
        )
        self.assertEqual(res.status_code, 400)

    def test_contact_honeypot_is_silent(self):
        from unittest.mock import patch

        with patch("app.send_contact_email") as send:
            res = self.client.post(
                "/api/contact",
                headers={"Sec-Fetch-Site": "same-origin"},
                json={"email": "bot@example.com", "message": "spam link", "website": "http://spam"},
            )
        self.assertEqual(res.status_code, 200)
        send.assert_not_called()

    def test_self_host_page_is_public(self):
        res = self.client.get("/self-host")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Self-host guide", res.data)
        self.assertIn(b"deploy/deeperguard.env.example", res.data)

    def test_sync_watermark(self):
        self._register_user("wm@home.local", "wm-secure-pass")
        csrf = self._csrf()
        self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "wm-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "abc",
                    "deleted": False,
                    "updated_at": 5.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        res = self.client.get("/api/sync/watermark")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertGreaterEqual(body["watermark"], 5.0)
        self.assertEqual(body["item_count"], 1)

    def test_sync_known_hashes_skips_ciphertext(self):
        self._register_user("hash@home.local", "hash-secure-pass")
        csrf = self._csrf()
        self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "h-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "same-hash",
                    "deleted": False,
                    "updated_at": 2.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        res = self.client.get(
            '/api/sync/items?since=0&known_hashes={"h-1":"same-hash"}'
        )
        self.assertEqual(res.status_code, 200)
        row = res.get_json()["items"][0]
        self.assertTrue(row.get("unchanged"))
        self.assertEqual(row.get("ciphertext"), "")

    def test_sync_pull_post_known_hashes(self):
        self._register_user("pull@home.local", "pull-secure-pass")
        csrf = self._csrf()
        self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "h-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "same-hash",
                    "deleted": False,
                    "updated_at": 2.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        big_map = {f"item-{i}": f"hash-{i}" for i in range(400)}
        big_map["h-1"] = "same-hash"
        res = self.client.post(
            "/api/sync/pull",
            json={
                "since": 0,
                "limit": 50,
                "known_hashes": big_map,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(res.status_code, 200)
        row = res.get_json()["items"][0]
        self.assertTrue(row.get("unchanged"))
        self.assertEqual(row.get("ciphertext"), "")

    def test_sync_blobs_endpoint(self):
        self._register_user("blobs@home.local", "blobs-secure-pass")
        csrf = self._csrf()
        self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "b-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"meta"}',
                    "blob_ciphertext": '{"v":1,"iv":"CC","data":"file"}',
                    "content_hash": "blob-hash",
                    "deleted": False,
                    "updated_at": 3.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        res = self.client.post(
            "/api/sync/blobs",
            json={"uuids": ["b-1"]},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(res.status_code, 200)
        blobs = res.get_json()["blobs"]
        self.assertEqual(len(blobs), 1)
        self.assertEqual(blobs[0]["blob_ciphertext"], '{"v":1,"iv":"CC","data":"file"}')

    def test_sync_refetch_returns_full_ciphertext(self):
        self._register_user("refetch@home.local", "refetch-secure-pass")
        csrf = self._csrf()
        self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "rf-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "refetch-hash",
                    "deleted": False,
                    "updated_at": 4.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        res = self.client.post(
            "/api/sync/refetch",
            json={"uuids": ["rf-1"]},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(res.status_code, 200)
        row = res.get_json()["items"][0]
        self.assertFalse(row.get("unchanged"))
        self.assertEqual(row.get("ciphertext"), '{"v":1,"iv":"AA","data":"BB"}')

    def test_sync_push_returns_per_item_results(self):
        self._register_user("results@home.local", "results-secure-pass")
        csrf = self._csrf()
        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "r-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "r-hash",
                    "deleted": False,
                    "updated_at": 1.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        body = push.get_json()
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(len(body["results"]), 1)
        self.assertEqual(body["results"][0]["status"], "ok")
        dup = self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "r-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                    "content_hash": "r-hash",
                    "deleted": False,
                    "updated_at": 0.5,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        dup_body = dup.get_json()
        self.assertEqual(dup_body["unchanged"], 1)

    def test_device_report_upload(self):
        from config import DATA_DIR

        self._register_user("device@home.local", "device-secure-pass")
        report = "iPhone checklist (auto-detected where possible — fill remaining pass/fail):\n7. Photo OCR search — PASS"
        res = self.client.post(
            "/api/device-report",
            json={"report": report},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["ok"])
        from uploads import user_upload_dir

        latest = (user_upload_dir("device@home.local") / "device-reports" / "latest.txt").read_text(encoding="utf-8")
        self.assertIn("Photo OCR search — PASS", latest)
        self.assertFalse((DATA_DIR / "device-reports" / "latest.txt").exists())

    def test_user_upload_dir_and_device_sessions(self):
        import db as notes_db
        from uploads import email_fs_name, ensure_user_upload_dir, user_upload_dir

        email = "vault.user@home.local"
        self._register_user(email, "device-secure-pass")
        upload = user_upload_dir(email)
        self.assertTrue(upload.is_dir())
        self.assertEqual(upload.name, email_fs_name(email))
        self.assertTrue((upload / "device-reports").is_dir())
        self.assertTrue((upload / "ocr").is_dir())
        (upload / "ocr").chmod(0o555)
        ensure_user_upload_dir(email)
        self.assertTrue((upload / "ocr").stat().st_mode & 0o200)

        listed = self.client.get("/api/sessions")
        self.assertEqual(listed.status_code, 200)
        sessions = listed.get_json()["sessions"]
        self.assertEqual(len(sessions), 1)
        self.assertTrue(sessions[0]["current"])
        self.assertEqual(sessions[0]["ip_location"], "Local network")
        self.assertGreater(sessions[0]["last_login_at"], 0)
        self.assertTrue(sessions[0]["device"])

        user = notes_db.get_user_by_email(email)
        notes_db.create_user_session(
            int(user["id"]),
            device_label="iPhone · Safari",
            ip="203.0.113.10",
            ip_location="Vienna, AT",
        )
        listed = self.client.get("/api/sessions")
        rows = listed.get_json()["sessions"]
        self.assertEqual(len(rows), 2)
        other = next(item for item in rows if not item["current"])
        self.assertEqual(other["device"], "iPhone · Safari")
        self.assertEqual(other["ip"], "203.0.113.10")
        self.assertEqual(other["ip_location"], "Vienna, AT")

        revoked = self.client.delete(
            f"/api/sessions/{other['id']}",
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(revoked.status_code, 200)
        self.assertFalse(revoked.get_json()["current"])
        left = self.client.get("/api/sessions").get_json()["sessions"]
        self.assertEqual(len(left), 1)
        self.assertTrue(left[0]["current"])

        current_id = left[0]["id"]
        gone = self.client.delete(
            f"/api/sessions/{current_id}",
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(gone.status_code, 200)
        self.assertTrue(gone.get_json()["current"])
        self.assertEqual(self.client.get("/api/sessions").status_code, 401)

    def test_remote_sign_out_tells_device_to_wipe(self):
        import secrets
        import time

        import db as notes_db
        from config import SESSION_SECONDS

        email = "wipe.remote@home.local"
        self._register_user(email, "wipe-secure-pass")
        user = notes_db.get_user_by_email(email)
        uid = int(user["id"])
        token = notes_db.create_user_session(
            uid,
            device_label="iPhone · Safari",
            ip="203.0.113.22",
            ip_location="Vienna, AT",
            device_id="iphone-wipe-device-1",
        )
        other = self.app_mod.app.test_client()
        with other.session_transaction() as sess:
            sess["uid"] = uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            sess["sid"] = token

        listed = self.client.get("/api/sessions")
        self.assertEqual(listed.status_code, 200)
        other_row = next(item for item in listed.get_json()["sessions"] if not item["current"])
        revoked = self.client.delete(
            f"/api/sessions/{other_row['id']}",
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(revoked.status_code, 200)
        self.assertFalse(revoked.get_json()["current"])
        stored = notes_db.get_user_session(int(other_row["id"]), uid)
        self.assertGreater(float(stored["revoked_at"] or 0), 0)
        self.assertEqual(str(stored["revoke_reason"] or ""), "user")

        wiped = other.get("/api/account")
        self.assertEqual(wiped.status_code, 401)
        self.assertEqual(wiped.get_json()["code"], "session_revoked")
        self.assertEqual(wiped.get_json()["error"], "session revoked")

        after_cookie = other.get("/api/account")
        self.assertEqual(after_cookie.status_code, 401)
        self.assertNotEqual(after_cookie.get_json().get("code"), "session_revoked")

        by_device = other.get("/api/account", headers={"X-Device-Id": "iphone-wipe-device-1"})
        self.assertEqual(by_device.status_code, 401)
        self.assertEqual(by_device.get_json()["code"], "session_revoked")

        self.assertEqual(self.client.get("/api/account").status_code, 200)

        notes_db.create_user_session(
            uid,
            device_label="iPhone · Safari",
            ip="203.0.113.22",
            device_id="iphone-wipe-device-1",
        )
        signed_in = other.get("/api/account", headers={"X-Device-Id": "iphone-wipe-device-1"})
        self.assertEqual(signed_in.status_code, 401)
        self.assertNotEqual(signed_in.get_json().get("code"), "session_revoked")

        stale_token = notes_db.create_user_session(
            uid,
            device_label="iPad · Safari",
            ip="203.0.113.30",
            device_id="ipad-prune-device-1",
        )
        stale = notes_db.get_session_by_token(stale_token)
        with notes_db.tx() as conn:
            conn.execute(
                "UPDATE user_sessions SET last_seen_at = 1 WHERE id = ?",
                (int(stale["id"]),),
            )
        notes_db.prune_user_sessions(uid, older_than=time.time() - 10)
        pruned = notes_db.get_user_session(int(stale["id"]), uid)
        self.assertGreater(float(pruned["revoked_at"] or 0), 0)
        self.assertEqual(str(pruned["revoke_reason"] or ""), "prune")
        prune_client = self.app_mod.app.test_client()
        with prune_client.session_transaction() as sess:
            sess["uid"] = uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            sess["sid"] = stale_token
        expired = prune_client.get("/api/account")
        self.assertEqual(expired.status_code, 401)
        self.assertNotEqual(expired.get_json().get("code"), "session_revoked")

    def test_duplicate_iphone_sessions_collapse(self):
        import db as notes_db

        email = "iphone.dup@home.local"
        self._register_user(email, "device-secure-pass")
        user = notes_db.get_user_by_email(email)
        uid = int(user["id"])
        notes_db.create_user_session(
            uid,
            device_label="iPhone · Safari",
            ip="203.0.113.10",
            ip_location="Vienna, AT",
            device_id="iphone-safari-1",
        )
        notes_db.create_user_session(
            uid,
            device_label="iPhone · Safari",
            ip="203.0.113.10",
            ip_location="Vienna, AT",
            device_id="iphone-safari-1",
        )
        ts = notes_db.now()
        with notes_db.tx() as conn:
            for idx in range(2):
                conn.execute(
                    """
                    INSERT INTO user_sessions (
                        user_id, token_hash, device_id, device_label, user_agent, ip, ip_location,
                        created_at, last_seen_at, last_login_at, revoked_at
                    )
                    VALUES (?, ?, '', 'iPhone · Safari', 'Safari', '203.0.113.10', 'Vienna, AT', ?, ?, ?, 0)
                    """,
                    (uid, f"orphan-hash-{idx}", ts, ts, ts),
                )
        listed = self.client.get("/api/sessions")
        self.assertEqual(listed.status_code, 200)
        iphones = [row for row in listed.get_json()["sessions"] if row["device"] == "iPhone · Safari"]
        self.assertEqual(len(iphones), 1)
        self.assertEqual(iphones[0]["ip"], "203.0.113.10")

    def test_live_http_shell_shows_certificate_setup(self):
        insecure = self.client.get(
            "/?from=http",
            base_url="http://192.168.178.146",
            follow_redirects=False,
        )
        self.assertEqual(insecure.status_code, 200)
        body = insecure.get_data(as_text=True)
        self.assertIn("/ca.crt", body)
        self.assertIn("https://192.168.178.146/", body)
        self.assertIn("Certificate Trust Settings", body)
        secure = self.client.get(
            "/?from=https",
            base_url="https://192.168.178.146",
            follow_redirects=False,
        )
        self.assertEqual(secure.status_code, 200)
        self.assertIn("Deeperguard", secure.get_data(as_text=True))

    def test_http_setup_ignores_poisoned_host_header(self):
        os.environ["NOTES_PUBLIC_HOST"] = "192.168.178.143"
        try:
            insecure = self.client.get(
                "/",
                base_url="http://evil.example",
                headers={"Host": "evil.example"},
                follow_redirects=False,
            )
        finally:
            os.environ.pop("NOTES_PUBLIC_HOST", None)
        self.assertEqual(insecure.status_code, 200)
        body = insecure.get_data(as_text=True)
        self.assertIn("https://192.168.178.143/", body)
        self.assertNotIn("evil.example", body)

    def test_register_login_and_sync(self):
        reg = self._register_user("me@home.local", "super-secure-pass")
        self.assertEqual(reg.status_code, 200)
        data = reg.get_json()
        self.assertIn("kdf_salt", data)

        with self.client.session_transaction() as sess:
            sess.clear()

        import db as notes_db

        user = notes_db.get_user_by_email("me@home.local")
        login = self._srp_login("me@home.local", "super-secure-pass", str(user["srp_salt"]))
        self.assertEqual(login.status_code, 200)

        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [
                    {
                        "item_uuid": "note-1",
                        "content_version": 1,
                        "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                        "content_hash": "abc",
                        "deleted": False,
                        "updated_at": 1.0,
                    }
                ]
            },
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(push.status_code, 200)
        self.assertEqual(push.get_json()["accepted"], 1)

        items = self.client.get("/api/sync/items?since=0")
        self.assertEqual(items.status_code, 200)
        payload = items.get_json()
        self.assertEqual(len(payload["items"]), 1)
        self.assertIn("has_more", payload)
        page = self.client.get("/api/sync/items?since=0&limit=1")
        self.assertEqual(page.status_code, 200)
        self.assertEqual(len(page.get_json()["items"]), 1)

    def test_sync_push_batch_transaction(self):
        self._register_user("batch@home.local", "batch-secure-pass")
        items = [
            {
                "item_uuid": f"note-{index}",
                "content_version": 1,
                "ciphertext": f'{{"v":1,"iv":"AA","data":"BB{index}"}}',
                "content_hash": f"hash-{index}",
                "deleted": False,
                "updated_at": float(index),
            }
            for index in range(1, 6)
        ]
        push = self.client.post(
            "/api/sync/items",
            json={"items": items},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(push.status_code, 200)
        self.assertEqual(push.get_json()["accepted"], 5)
        listed = self.client.get("/api/sync/items?since=0")
        self.assertEqual(len(listed.get_json()["items"]), 5)

    def test_sync_pull_skips_total_on_paged_requests(self):
        self._register_user("pages@home.local", "pages-secure-pass")
        csrf = self._csrf()
        for index in range(3):
            self.client.post(
                "/api/sync/items",
                json={
                    "items": [{
                        "item_uuid": f"p-{index}",
                        "content_version": 1,
                        "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                        "content_hash": "abc",
                        "deleted": False,
                        "updated_at": float(index + 1),
                    }]
                },
                headers={"X-CSRF-Token": csrf},
            )
        first = self.client.get("/api/sync/items?since=0&limit=1")
        self.assertEqual(first.status_code, 200)
        first_body = first.get_json()
        self.assertEqual(first_body["total_undeleted"], 3)
        last_uuid = first_body["items"][0]["item_uuid"]
        last_ts = first_body["items"][0]["updated_at"]
        second = self.client.get(
            f"/api/sync/items?since={last_ts}&after={last_uuid}&limit=1"
        )
        self.assertEqual(second.status_code, 200)
        self.assertIsNone(second.get_json()["total_undeleted"])

    def _push_item(self, csrf, uuid, updated_at, content_hash="h", data="BB", deleted=False):
        return self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": uuid,
                    "content_version": 1,
                    "ciphertext": f'{{"v":1,"iv":"AA","data":"{data}"}}',
                    "content_hash": content_hash,
                    "deleted": deleted,
                    "updated_at": updated_at,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )

    def test_sync_pull_synced_cursor_sees_late_push_with_old_updated_at(self):
        """Cross-device regression: an offline/late edit carries an old client
        updated_at. Another device whose cursor already passed that time must
        still receive it when paging on the server's synced_at."""
        self._register_user("late@home.local", "late-secure-pass")
        csrf = self._csrf()
        self._push_item(csrf, "n-1", 100.0, "h1")
        first = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 50, "cursor": "synced_at"},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertEqual(first["cursor_kind"], "synced_at")
        self.assertEqual(len(first["items"]), 1)
        self.assertGreater(first["items"][0]["synced_at"], 1_000_000)
        cursor = first["cursor"]
        self.assertGreaterEqual(cursor, first["items"][0]["synced_at"])
        # The same client immediately re-polling gets at most "unchanged" stubs
        # (the cursor is held a few seconds behind now so in-flight pushes from
        # other devices are never skipped) — never ciphertext it already has.
        again = self.client.post(
            "/api/sync/pull",
            json={"since": cursor, "limit": 50, "cursor": "synced_at", "known_hashes": {"n-1": "h1"}},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertTrue(all(row.get("unchanged") for row in again["items"]))
        self.assertGreaterEqual(again["cursor"], cursor)
        # Phone pushes an edit it made while offline: client time 50 < cursor.
        self._push_item(csrf, "n-2", 50.0, "h2", data="CC")
        legacy = self.client.post(
            "/api/sync/pull",
            json={"since": cursor, "limit": 50},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertEqual(legacy["items"], [], "legacy updated_at cursor cannot see the late push")
        synced = self.client.post(
            "/api/sync/pull",
            json={"since": cursor, "limit": 50, "cursor": "synced_at", "known_hashes": {"n-1": "h1"}},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        fresh = [row for row in synced["items"] if not row.get("unchanged")]
        self.assertEqual([row["item_uuid"] for row in fresh], ["n-2"])
        self.assertEqual(fresh[0]["updated_at"], 50.0)
        self.assertGreater(fresh[0]["synced_at"], cursor)

    def test_sync_synced_cursor_is_monotonic_and_pages_in_commit_order(self):
        self._register_user("mono@home.local", "mono-secure-pass")
        csrf = self._csrf()
        # Pushed in reverse client-time order; synced_at must follow push order.
        for index, ts in enumerate([30.0, 20.0, 10.0]):
            self._push_item(csrf, f"m-{index}", ts, f"h{index}")
        page = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 2, "cursor": "synced_at"},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertTrue(page["has_more"])
        self.assertEqual([row["item_uuid"] for row in page["items"]], ["m-0", "m-1"])
        synced = [row["synced_at"] for row in page["items"]]
        self.assertLess(synced[0], synced[1])
        last = page["items"][-1]
        rest = self.client.post(
            "/api/sync/pull",
            json={
                "since": last["synced_at"],
                "after": last["item_uuid"],
                "limit": 2,
                "cursor": "synced_at",
            },
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertFalse(rest["has_more"])
        self.assertEqual([row["item_uuid"] for row in rest["items"]], ["m-2"])
        self.assertGreaterEqual(rest["cursor"], rest["items"][0]["synced_at"])
        watermark = self.client.get("/api/sync/watermark").get_json()
        self.assertEqual(watermark["synced_watermark"], rest["items"][0]["synced_at"])
        self.assertEqual(watermark["watermark"], 30.0)

    def test_sync_push_reports_stale_when_server_has_newer_version(self):
        self._register_user("stale@home.local", "stale-secure-pass")
        csrf = self._csrf()
        self._push_item(csrf, "s-1", 200.0, "new-hash", data="NEW")
        res = self._push_item(csrf, "s-1", 100.0, "old-hash", data="OLD").get_json()
        self.assertEqual(res["results"][0]["status"], "stale")
        self.assertEqual(res["stale"], 1)
        self.assertEqual(res["accepted"], 0)
        row = self.client.post(
            "/api/sync/refetch",
            json={"uuids": ["s-1"]},
            headers={"X-CSRF-Token": csrf},
        ).get_json()["items"][0]
        self.assertEqual(row["content_hash"], "new-hash")
        # A stale write must not bump the server cursor either.
        pulled = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 50, "cursor": "synced_at"},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        cursor = pulled["cursor"]
        before = self.client.get("/api/sync/watermark").get_json()["synced_watermark"]
        self._push_item(csrf, "s-1", 50.0, "older-hash", data="OLDER")
        self.assertEqual(self.client.get("/api/sync/watermark").get_json()["synced_watermark"], before)
        after = self.client.post(
            "/api/sync/pull",
            json={"since": cursor, "limit": 50, "cursor": "synced_at", "known_hashes": {"s-1": "new-hash"}},
            headers={"X-CSRF-Token": csrf},
        ).get_json()
        self.assertTrue(all(row.get("unchanged") for row in after["items"]))

    def test_sync_blob_ciphertext_roundtrip(self):
        self._register_user("blob@home.local", "blob-secure-pass")
        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "att-1",
                    "content_version": 1,
                    "ciphertext": '{"v":1,"iv":"AA","data":"meta"}',
                    "blob_ciphertext": '{"v":1,"iv":"CC","data":"file"}',
                    "content_hash": "meta-hash",
                    "deleted": False,
                    "updated_at": 10.0,
                }]
            },
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(push.status_code, 200)
        listed = self.client.get("/api/sync/items?since=0")
        row = listed.get_json()["items"][0]
        self.assertEqual(row["blob_ciphertext"], '{"v":1,"iv":"CC","data":"file"}')

    def test_sync_items_without_csrf(self):
        self._register_user("csrf@home.local", "csrf-secure-pass")
        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [
                    {
                        "item_uuid": "note-plain",
                        "content_version": 1,
                        "ciphertext": '{"v":1,"iv":"AA","data":"BB"}',
                        "content_hash": "abc",
                        "deleted": False,
                        "updated_at": 1.0,
                    }
                ]
            },
        )
        self.assertEqual(push.status_code, 400)
        self.assertEqual(push.get_json()["error"], "invalid CSRF token")

    def test_sync_pull_without_csrf(self):
        self._register_user("pull-nocsrf@home.local", "pull-secure-pass")
        pull = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 10, "cursor": "synced_at"},
        )
        self.assertEqual(pull.status_code, 200)
        self.assertEqual(pull.get_json()["items"], [])

    def test_notes_subdomain_redirects_to_canonical_www(self):
        res = self.client.get("/", base_url="https://notes.deeperguard.com/")
        self.assertEqual(res.status_code, 301)
        self.assertEqual(res.headers["Location"], "https://www.deeperguard.com/")
        app_res = self.client.get("/app", base_url="https://notes.deeperguard.com/")
        self.assertEqual(app_res.status_code, 301)
        self.assertEqual(app_res.headers["Location"], "https://www.deeperguard.com/app")
        login_res = self.client.get("/login", base_url="https://notes.deeperguard.com/")
        self.assertEqual(login_res.status_code, 301)
        self.assertEqual(login_res.headers["Location"], "https://www.deeperguard.com/login")

    def test_app_page_has_create_ui(self):
        self._register_user("ui@home.local", "ui-secure-pass")
        res = self.client.get("/app")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'id="tag-composer"', res.data)
        self.assertIn(b'id="tag-color-bar"', res.data)
        self.assertIn(b'data-notes-boot', res.data)
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="tag-bar-form"', app_js)
        self.assertIn('enterkeyhint="done"', app_js)
        self.assertIn('id="tag-bar-add"', app_js)
        self.assertIn("commitTagBarInput", app_js)
        self.assertIn("iosDeferPdfPreview", app_js)
        self.assertIn("note list overview", app_js)
        self.assertIn("paintIosPdfPlaceholder", app_js)
        self.assertIn(b'id="btn-empty-new"', res.data)
        self.assertIn(b'data-filter="untagged"', res.data)
        self.assertIn(b'id="app-update-banner"', res.data)
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("Do NOT auto-reload", html)
        self.assertIn("showUpdateBanner", html)
        self.assertNotIn("app-update-modal", html)
        self.assertIn("app-update-banner", html)
        self.assertIn("Top banner only", (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8"))
        self.assertIn("sidebar strip stays hidden", (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8"))
        self.assertNotIn("notes_update_modal_build", html)
        self.assertIn("notes_require_unlock_after_update", html)
        self.assertIn("hardRefresh", html)
        self.assertIn("btn-app-update-dismiss", html)
        self.assertLess(html.index('id="app-update-banner"'), html.index('id="unlock-screen"'))
        self.assertIn(b'probeHealth', res.data)
        self.assertIn(b"app.js?v=192", res.data)
        self.assertIn(b"vaultlock.js?v=192", res.data)
        self.assertIn(b"store.js?v=192", res.data)
        self.assertIn(b'data-skip-login="0"', res.data)
        self.assertIn(b"preview.js?v=192", res.data)
        self.assertIn(b'snimport.js?v=192', res.data)
        self.assertIn(b"checklist.js?v=192", res.data)
        self.assertIn(b"superscript.js?v=192", res.data)
        self.assertIn(b"Superscript", res.data)
        self.assertIn(b'value="superscript"', res.data)
        self.assertIn(b'id="sync-indicator"', res.data)
        self.assertIn(b'id="app-version"', res.data)
        self.assertIn(b'id="sync-meta"', res.data)
        self.assertIn(b'>v192</span>', res.data)
        self.assertIn(b"nosync=1", res.data)
        self.assertIn(b'id="search-clear"', res.data)
        self.assertIn(b'id="sync-progress"', res.data)
        self.assertIn(b'id="note-list-head"', res.data)
        self.assertIn(b'id="btn-editor-settings"', res.data)
        self.assertIn(b'data-theme-opt="light"', res.data)
        self.assertIn(b'id="checklist"', res.data)
        self.assertIn(b'id="note-options"', res.data)
        self.assertIn(b'id="note-info-created"', res.data)
        self.assertIn(b'id="vault-stats"', res.data)
        self.assertIn(b'id="pref-remember-device"', res.data)
        self.assertIn(b'id="pref-lock-on-unfocus"', res.data)
        self.assertIn(b'value="immediate"', res.data)
        self.assertIn(b'value="1min"', res.data)
        self.assertIn("onAppBackground", app_js)
        self.assertIn("settleUnfocusLockOnForeground", app_js)
        self.assertIn("lockOnUnfocus", app_js)
        self.assertIn("notes_require_typed_unlock", app_js)
        self.assertIn("beginNotesPicker", app_js)
        self.assertIn("isTransientUnfocus", app_js)
        self.assertIn("consumeUnlockGates", app_js)
        self.assertIn("pageshowAction", app_js)
        self.assertIn("filterAfterLeavingFiles", app_js)
        lock_fn = app_js[app_js.find("async function lockVault"):app_js.find("function rememberOpen")]
        self.assertIn("async function lockVault", lock_fn)
        self.assertNotIn("vaultNeedsReload = true", lock_fn)
        self.assertIn("Do not set vaultNeedsReload", app_js)
        self.assertIn("remotePasswordChanged", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("vaultlock.js", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('role="tablist"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('role="tab"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn(b"pdf.min.js?v=8", res.data)
        self.assertIn(b"notes_device_password_enc", res.data)
        self.assertIn(b'id="confirm-dialog"', res.data)
        self.assertIn(b'id="btn-find"', res.data)
        self.assertIn(b'id="unlock-secure-hint"', res.data)
        self.assertIn(b'id="btn-note-info"', res.data)
        self.assertIn(b'id="btn-prevent-edit"', res.data)
        self.assertIn(b'edit-lock-btn', res.data)
        self.assertIn(b'id="find-bar"', res.data)
        self.assertIn(b'find-bar-search', res.data)
        self.assertIn(b'id="btn-note-info"', res.data)
        self.assertIn(b'note-more-btn', res.data)
        self.assertIn(b'id="tag-bar-shell"', res.data)
        self.assertIn(b'id="doc-gallery-nav"', res.data)
        self.assertIn(b'find-btn', res.data)
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("defaultTagBarExpanded", app_js)
        self.assertIn("refreshDocGalleryIds", app_js)
        self.assertIn("activeFindNeedle", app_js)
        self.assertIn("openDocPreviewFromSearch", app_js)
        self.assertIn("finishDocPreviewFind", app_js)
        self.assertIn(b'id="doc-viewer-find-slot"', res.data)
        self.assertIn("mountFindBarToDocViewer", app_js)
        self.assertIn("syncDocFindCounter", app_js)
        self.assertIn("ensureDocFindHits", app_js)
        self.assertIn("resolveDocFindHits", app_js)
        self.assertIn("countStoredSearchHits", (APP_DIR / "static" / "js" / "preview.js").read_text(encoding="utf-8"))
        self.assertIn(b'id="find-doc-status"', res.data)
        self.assertIn("docSwipeY", app_js)
        self.assertIn(b'note-info-star', res.data)
        self.assertIn(b'id="note-info-protect"', res.data)
        self.assertIn(b'id="note-warn-at"', res.data)
        self.assertIn(b'id="note-warn-save"', res.data)
        self.assertIn(b'id="note-warn-clear"', res.data)
        self.assertIn("saveNoteWarning", app_js)
        save_warn = app_js[app_js.find("async function saveNoteWarning"):app_js.find("function toggleNoteProtection")]
        self.assertLess(save_warn.find("await NotesStore.api('/api/reminders'"), save_warn.find("live.content.warn_at = iso"))
        self.assertLess(save_warn.find("await NotesStore.api(`/api/reminders/"), save_warn.find("live.content.warn_at = ''"))
        self.assertIn("function cancelNoteReminder", app_js)
        self.assertIn("function restoreNoteReminder", app_js)
        trash_fn = app_js[app_js.find("function trashNote(id)"):app_js.find("function restoreNote(id)")]
        self.assertIn("cancelNoteReminder(id)", trash_fn)
        restore_fn = app_js[app_js.find("function restoreNote(id)"):app_js.find("async function deleteNoteForever")]
        self.assertIn("restoreNoteReminder", restore_fn)
        self.assertIn("setFilter(live.content.archived ? 'archived' : 'all')", restore_fn)
        self.assertIn("note-row-restore", app_js)
        self.assertIn('data-action="restore"', app_js)
        self.assertIn("consumeNoteDeepLink", app_js)
        self.assertIn("noteIdFromUrl", app_js)
        self.assertIn("warn_at: ''", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn(b'id="search-filter-toggle"', res.data)
        self.assertIn(b'id="search-filter-panel"', res.data)
        self.assertNotIn(b'id="find-replace-input"', res.data)
        self.assertIn(b'id="find-case-toggle"', res.data)
        self.assertIn(b'class="doc-viewer-tools"', res.data)
        self.assertIn(b'id="doc-zoom-in"', res.data)
        self.assertIn(b'id="doc-zoom-out"', res.data)
        self.assertIn(b'id="doc-zoom-reset"', res.data)
        self.assertIn(b'id="doc-enhance-toggle"', res.data)
        self.assertIn(b'id="doc-white-borders"', res.data)
        self.assertIn(b'id="btn-manage-tags"', res.data)
        self.assertNotIn('data-tag-remove', app_js)
        self.assertIn(b"Super checklist", res.data)
        self.assertIn(b'id="btn-undo"', res.data)
        self.assertNotIn("richLiveEditActive", app_js)
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertNotIn("rich-live-edit", css)
        self.assertIn("box-decoration-break: clone", css)
        self.assertIn("function undoEdit", app_js)
        self.assertIn("syncEditLinkOverlay", app_js)
        editor_html = html[html.find('<article id="editor"'):html.find('<footer class="editor-foot"')]
        self.assertIn('id="editor-scroll"', editor_html)
        self.assertLess(editor_html.index('id="editor-scroll"'), editor_html.index('id="note-body-wrap"'))
        self.assertLess(editor_html.index('id="note-body-wrap"'), editor_html.index('id="preview"'))
        self.assertIn('id="note-body-links"', editor_html)
        self.assertIn(".editor-scroll {", css)
        self.assertIn(".editor-scroll > .note-body-wrap:not([hidden])", css)
        self.assertIn("--note-after-body-gap:", css)
        self.assertIn("padding-bottom: var(--note-after-body-gap)", css)
        self.assertIn(".editor-scroll > .doc-inline:not([hidden])", css)
        self.assertIn("function autosizeNoteBody", app_js)
        self.assertIn(
            ".editor-pane .editor:not(.doc-preview-active) .editor-scroll > .note-body-wrap:not([hidden])",
            css,
        )
        self.assertIn("min-height: 100%;", css)
        self.assertIn(".attachment-list:empty", css)
        self.assertIn("renderInlinePlainSegment", (APP_DIR / "static" / "js" / "superscript.js").read_text(encoding="utf-8"))
        self.assertIn("previewBtn.hidden = checklistOn || !hasDocs", app_js)
        # Update must not navigate to ?hard=1 (Safari crash-looped on cellular).
        self.assertNotIn(b"&hard=1", res.data)
        hard = self.client.get("/app?hard=1&nosync=1", follow_redirects=False)
        self.assertIn(hard.status_code, (301, 302))
        self.assertNotIn("hard=1", hard.headers.get("Location", ""))
        self.assertIn("/app", hard.headers.get("Location", ""))
        self.assertIn(b"notes_pending_update_build", res.data)
        self.assertIn(b"showUpdateBanner", res.data)
        self.assertIn(b'empty-state-card', res.data)
        sw = (APP_DIR / "static" / "sw.js").read_text(encoding="utf-8")
        self.assertIn("get('hard')", sw)
        self.assertNotIn("const BUILD = '__NOTES_BUILD__'", sw)
        self.assertIn("SKIP_WAITING", sw)
        self.assertIn("await self.skipWaiting()", sw)
        self.assertIn("Keep this file byte-stable", sw)
        self.assertIn("const CACHE = 'deeperguard-offline'", sw)
        self.assertIn("You're offline", sw)
        self.assertIn("Deeperguard", sw)
        self.assertIn("pdf.min.js?v=8", sw)
        self.assertIn("pdf.worker.min.js?v=8", sw)
        preview_js = (APP_DIR / "static" / "js" / "preview.js").read_text(encoding="utf-8")
        self.assertIn("MAX_PAGE_DPR", preview_js)
        self.assertIn("MAX_CANVAS_PIXELS", preview_js)
        self.assertIn("MAX_SNAPSHOT_PIXELS", preview_js)
        self.assertIn("hard total canvas budget", preview_js)
        self.assertIn("cacheFirstNavigate", sw)
        self.assertIn("function isMarketingPage", sw)
        self.assertIn("isMarketingPage(url)", sw)
        self.assertIn("client.navigate", sw)
        sw_live = self.client.get("/sw.js")
        self.assertEqual(sw_live.status_code, 200)
        sw_served = sw_live.data.decode("utf-8")
        self.assertNotIn("__NOTES_BUILD__", sw_served)
        self.assertIn("const CACHE = 'deeperguard-offline'", sw_served)
        self.assertIn("must-revalidate", sw_live.headers.get("Cache-Control", ""))
        manifest_live = self.client.get("/manifest.json")
        self.assertEqual(manifest_live.status_code, 200)
        manifest_served = manifest_live.data.decode("utf-8")
        self.assertIn('icon-192.png?v=192', manifest_served)
        self.assertNotIn("__NOTES_BUILD__", manifest_served)
        # Versioned assets must never be served from a different build's cache
        # entry, or a deploy lands as new HTML running the previous scripts.
        self.assertIn("matchExact", sw)
        self.assertIn("isVersioned", sw)
        self.assertIn("notes-build-ping", sw)
        self.assertIn(b'name="notes-build"', res.data)
        self.assertIn("deeperguard-shell", sw)
        self.assertIn(b'id="btn-ocr-text"', res.data)
        self.assertIn(b'id="doc-share"', res.data)
        self.assertIn(b'id="doc-viewer"', res.data)
        self.assertIn(b'id="doc-inline"', res.data)
        self.assertIn(b'id="scan-input"', res.data)
        self.assertIn(b'id="scan-camera"', res.data)
        self.assertIn(b'capture="environment"', res.data)
        self.assertIn(b'id="scan-take-photo"', res.data)
        self.assertIn(b'class="sr-file"', res.data)
        self.assertNotIn(b'id="scan-input" type="file" accept="image/*,.pdf,.txt,.md,application/pdf,text/plain" hidden', res.data)
        self.assertIn(b'id="scan-name"', res.data)
        self.assertIn(b'id="scan-empty"', res.data)
        self.assertIn(b'class="scan-dialog-foot"', res.data)
        self.assertIn(b'id="attachment-add-label"', res.data)
        self.assertIn(b'id="btn-list-scan"', res.data)
        self.assertIn(b'class="sn-add" title="Add document"', res.data)
        self.assertIn(b'data-filter="documents"', res.data)
        self.assertIn(b'id="app-tab-notes"', res.data)
        self.assertIn(b'id="app-tab-files"', res.data)
        self.assertIn(b'data-app-tab="files"', res.data)
        self.assertIn(b'id="app-tab-2fa"', res.data)
        self.assertNotIn(b'id="files-tab-count"', res.data)
        self.assertNotIn(b'id="totp-tab-count"', res.data)
        notes_tab = res.data.find(b'id="app-tab-notes"')
        files_tab = res.data.find(b'id="app-tab-files"')
        twofa_tab = res.data.find(b'id="app-tab-2fa"')
        self.assertTrue(0 <= notes_tab < files_tab < twofa_tab)
        self.assertIn("normalizeAppTab", app_js)
        self.assertIn("listStoredFiles", app_js)
        self.assertNotIn("updateFilesTabCount", app_js)
        self.assertNotIn("updateTotpTabCount", app_js)
        self.assertIn(b'id="tag-suggest"', res.data)

    def test_update_banner_hidden_while_vault_locked(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        vault = (APP_DIR / "static" / "js" / "vaultlock.js").read_text(encoding="utf-8")
        self.assertIn("body.locked #app-update-banner", css)
        self.assertIn("body.locked:not(.app-updating) #app-update-progress", css)
        self.assertIn("never overlay it with Update", css)
        self.assertNotIn("body.locked #app-update-banner { z-index: 55; }", css)
        self.assertNotIn("body.locked:has(#app-update-banner", css)
        self.assertLess(html.index('vaultlock.js'), html.index("var showUpdateBanner"))
        self.assertIn("function lockedUpdateUi", vault)
        self.assertIn("function mayStartAppUpdate", vault)
        self.assertIn("function mayLockVault", vault)
        self.assertIn("function hideProgressWhenLocking", vault)
        reveal = html[html.index("var reveal = function"):html.index("if (document.readyState === 'loading')")]
        self.assertIn("lockedUpdateUi", reveal)
        self.assertIn("revealBanner", reveal)
        banner_fn = js[js.index("function updateAppUpdateBanner"):js.index("function showAppUpdateModal")]
        self.assertIn("lockedUpdateUi", banner_fn)
        self.assertIn("notes_pending_update_build", banner_fn)
        self.assertIn("persistPending", banner_fn)
        self.assertIn("unlock-update-hint", html)
        self.assertIn("updateUnlockUpdateHint", js)
        flush_fn = js[js.index("function flushPendingUpdatePrompt"):js.index("function updateAppVersionBadge")]
        self.assertIn("/api/health", flush_fn)
        show_unlock = js[js.index("function showUnlock"):js.index("function updateSecureContextHint")]
        self.assertIn("app-update-banner", show_unlock)
        self.assertIn("hideProgressWhenLocking", show_unlock)
        version_click = html[html.index("#app-version.stale"):html.index("var dismissBtn")]
        self.assertIn("mayStartAppUpdate", version_click)
        self.assertIn("mayStartAppUpdate", html[html.index("var hardRefresh"):html.index("window.__notesHardRefresh")])
        force_fn = js[js.index("async function forceRefreshApp"):js.index("window.notesForceRefreshApp")]
        self.assertIn("mayStartAppUpdate", force_fn)
        self.assertIn("mayStartAppUpdate", js[js.index("window.notesForceRefreshApp"):js.index("async function checkAppUpdate")])
        self.assertIn("mayLockVault", js[js.index("async function lockVault"):js.index("function rememberOpen")])
        refresh_click = js[js.index("getElementById('btn-refresh-app')?.addEventListener"):js.index("const offlineSetupBtn")]
        self.assertIn("mayStartAppUpdate", refresh_click)

    def test_note_time_warning_chip_in_list(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function noteTagChipsHtml", js)
        self.assertIn("function noteWarnChipHtml", js)
        self.assertIn("note-tag-warn", js)
        self.assertIn(".note-tag-warn", css)
        chips = js[js.index("function noteTagChipsHtml"):js.index("function renderFileRow")]
        self.assertIn("noteWarnChipHtml(note)", chips)
        note_row = js[js.index("function renderNoteRow"):js.index("const NOTE_LIST_VIRTUAL_THRESHOLD")]
        file_row = js[js.index("function renderFileRow"):js.index("function renderNoteRow")]
        secondary = js[js.index("function noteRowSecondaryLine"):js.index("function noteLockBadgeHtml")]
        self.assertIn("noteTagChipsHtml(note)", secondary)
        self.assertNotIn("noteTagChipsHtml", note_row, "comfortable rows render tags only in noteRowSecondaryLine")
        self.assertNotIn("noteTagChipsHtml", file_row)
        chip = js[js.index("function noteWarnChipHtml"):js.index("function noteTagChipsHtml")]
        self.assertIn("warnMs <= Date.now()", chip, "chip must disappear once the warning has fired")
        self.assertIn("note-tag-warn-text", chip, "chip shows a short time next to the clock")
        fmt = js[js.index("function formatWarnChipTime"):js.index("function noteTagChipsHtml")]
        # The chip always carries the date, not just a clock time.
        self.assertIn("day: 'numeric', month: 'short'", fmt)
        self.assertNotIn("sameDay", fmt)
        self.assertIn("dateOpts.year = 'numeric'", fmt)

    def test_comfortable_list_row_single_note_item_tags_block(self):
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        chips_fn = js[js.index("function noteTagChipsHtml"):js.index("function noteRowDeleteLabel")]
        self.assertIn("new Set(note?.content?.tags || [])", chips_fn)
        secondary = js[js.index("function noteRowSecondaryLine"):js.index("function noteLockBadgeHtml")]
        self.assertEqual(secondary.count("note-item-tags"), 0)
        self.assertEqual(secondary.count("noteTagChipsHtml"), 1)
        note_row = js[js.index("function renderNoteRow"):js.index("const NOTE_LIST_VIRTUAL_THRESHOLD")]
        self.assertEqual(note_row.count("note-item-tags"), 0)
        self.assertEqual(note_row.count("noteTagChipsHtml"), 0)

    def test_expanded_tag_bar_hides_collapsed_summary(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn(
            ".tag-bar-shell:not(.is-collapsed) .tag-bar-toggle-summary { display: none; }",
            css,
        )

    def test_note_options_sheet_fits_short_ios_viewports(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        sheet = css[css.index(".note-options {"):css.index(".note-options-handle {")]
        # Landscape / in-app web views: cap the sheet and scroll inside instead of
        # pushing the header and Done button off the top of the screen.
        self.assertIn("max-height: calc(100dvh - 24px - var(--safe-top))", sheet)
        self.assertIn("max-height: calc(100vh - 24px - var(--safe-top))", sheet, "vh fallback for older WebKit")
        self.assertIn("flex-direction: column", sheet)
        body = css[css.index(".note-options .note-info {"):css.index(".note-options-handle,") + 400]
        self.assertIn("overflow-y: auto", body)
        self.assertIn("-webkit-overflow-scrolling: touch", body)
        self.assertIn("overscroll-behavior: contain", body)
        # iOS datetime-local: strip native pill chrome, keep 16px to avoid focus zoom,
        # and provide a placeholder because WebKit renders an empty field blank.
        field = css[css.index(".note-warn-field {"):css.index(".note-warn-buttons {")]
        self.assertIn("-webkit-appearance: none", field)
        self.assertIn("font-size: 16px", field)
        self.assertIn("min-height: 44px", field)
        self.assertIn("::-webkit-date-and-time-value", field)
        self.assertIn(".note-warn-field.is-empty .note-warn-placeholder { display: block; }", field)
        self.assertIn('class="note-warn-field is-empty" id="note-warn-field"', html)
        self.assertIn('class="note-warn-placeholder"', html)
        self.assertIn("function syncWarnFieldState", js)
        open_sheet = js[js.index("function openNoteOptions"):js.index("function togglePreventEdit")]
        self.assertIn("body.scrollTop = 0", open_sheet)

    def test_pdf_list_thumb_falls_back_to_document_icon(self):
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        # Thumb slots render the kind icon up front so a slow/failed preview never leaves a blank square.
        thumb_html = js[js.index("function listThumbHtml"):js.index("function paintListThumbFallback")]
        self.assertIn("listThumbPlaceholderHtml(kind)", thumb_html)
        self.assertIn(".note-list-thumb .note-list-thumb-fallback", css)
        hydrate = js[js.index("async function hydrateThumbNow"):js.index("async function hydrateInlineDoc")]
        self.assertIn("paintListThumbFallback(stage, listThumbKindMeta(note, att))", hydrate)
        self.assertEqual(hydrate.count("attachListThumbErrorHandler("), 2)
        handler = js[js.index("function attachListThumbErrorHandler"):js.index("function noteListPreview")]
        # Never revoke a blob URL the thumb cache does not own (previewCache URLs are shared with the viewer).
        self.assertIn("listThumbCache.get(attId) === img.src", handler)
        # Modified time stays note-only: no per-row attachment scan on the overview.
        edited = js[js.index("function noteEditedAtMs"):js.index("function relativeTime")]
        self.assertNotIn("listAttachments", edited)

    def test_note_editor_shows_tag_bar_on_phone(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn('id="tag-bar-shell"', html)
        self.assertLess(html.index('id="note-title"'), html.index('id="tag-bar-shell"'))
        self.assertLess(html.index('id="tag-bar-shell"'), html.index('id="editor-actions"') if 'id="editor-actions"' in html else html.index('class="editor-actions"'))
        self.assertIn('"tags tags"', mobile)
        self.assertIn(".editor-head .tag-bar-shell", mobile)
        self.assertIn("grid-area: tags", mobile)
        self.assertIn("function defaultTagBarShowAll()", js)
        self.assertIn("return isMobileLayout();", js[js.index("function defaultTagBarShowAll"):js.index("function tagBarSummaryText")])
        self.assertIn("tagBarShowAll = defaultTagBarShowAll()", js)
        self.assertNotIn("listTags().length > 8", js)
        expanded_fn = js[js.index("function defaultTagBarExpanded"):js.index("function defaultTagBarShowAll")]
        self.assertNotIn("isMobileLayout()", expanded_fn)
        self.assertNotIn("function isFreshNote(note)", js)
        self.assertIn("return false;", expanded_fn)
        toggle_click = js[js.index("document.getElementById('tag-bar-toggle')?.addEventListener('click'"):]
        toggle_click = toggle_click[:toggle_click.index("document.getElementById('doc-gallery-prev')")]
        self.assertIn("tagBarShowAll = true;", toggle_click)

    def test_phone_tag_section_shows_all_tags(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertNotIn("max-height: 16vh", mobile)
        self.assertIn("Do not flex or 16vh-cap <details> on iOS", mobile)
        self.assertIn(".tag-section[open] {\n    max-height: none;\n    display: block;", mobile)
        self.assertIn(".tag-section[open] .tag-list", mobile)
        self.assertIn("max-height: calc(100dvh - 12.5rem)", mobile)
        self.assertIn("overflow-y: auto", mobile)

    def test_desktop_folder_section_scrolls(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        desktop = css.split("@media (min-width: 861px)")[-1]
        self.assertIn("grid-template-rows: minmax(0, 1fr)", desktop)
        self.assertIn(".sidebar-nav {\n    grid-column: 1;", desktop)
        self.assertIn("overflow-y: auto;\n    -webkit-overflow-scrolling: touch;", desktop)
        self.assertIn(".filter-section", desktop)
        self.assertIn(".sidebar-nav .tag-section[open]", desktop)
        self.assertNotIn("max-height: 28vh", desktop)
        self.assertIn("min-height: 4.5rem", desktop)
        self.assertIn(".sn-tags { display: block; }", desktop)
        self.assertIn(".sn-folders { display: none; }", desktop)

    def test_views_section_collapses_and_tags_label(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn('id="filter-section"', html)
        self.assertIn('id="filters"', html)
        self.assertIn('class="sn-tags">Tags</span>', html)
        self.assertNotIn("Folders", html)
        self.assertIn("function applyFilterSection()", js)
        self.assertIn("viewsCollapsed: false", js)
        self.assertIn("tagsCollapsed: true", js)
        self.assertIn("prefs.listChromeDense !== 3", js)
        self.assertIn(".filter-section { display: none; }", mobile)

    def test_mobile_list_chrome_quiets_header_and_sync_banner(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertLess(html.index('id="sync-status-banner"'), html.index('id="note-list-head"'))
        self.assertIn('class="sync-status-banner list-sync-banner"', html)
        self.assertIn(".sidebar-head .app-version { display: none; }", mobile)
        self.assertIn(".sidebar-head .sync-meta { display: none; }", mobile)
        self.assertIn(".list-sync-banner { order: 8; }", mobile)
        self.assertIn("prefs.foldersCollapsed = true", (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8"))
        sn_add = mobile[mobile.index(".note-list-tools .sn-add {") : mobile.index(".note-list-tools .sn-add:hover")]
        self.assertIn("-webkit-appearance: none;", sn_add)
        self.assertIn("background: var(--bg-elevated);", sn_add)
        self.assertIn("border: 1px solid var(--border);", sn_add)

    def test_client_vaultlock(self):
        self._run_node_script("test_vaultlock.js")

    def test_client_search_filters(self):
        self._run_node_script("test_search.js")

    def test_client_note_protection_sync(self):
        self._run_node_script("test_note_protection_sync.js")

    def test_client_sanitize(self):
        self._run_node_script("test_sanitize.js")

    def test_client_markdown(self):
        self._run_node_script("test_markdown.js")

    def test_client_superscript(self):
        self._run_node_script("test_superscript.js")

    def test_client_tag_suggest(self):
        self._run_node_script("test_tagsuggest.js")

    def test_client_swipe(self):
        self._run_node_script("test_swipe.js")

    def test_client_preview(self):
        self._run_node_script("test_preview.js")

    def test_client_preview_search_paint(self):
        self._run_node_script("test_preview_paint.js")

    def test_client_remove_source(self):
        self._run_node_script("test_remove_source.js")

    def test_client_crypto_bytes(self):
        self._run_node_script("test_crypto.js")

    def test_client_attachment_encryption(self):
        self._run_node_script("test_store_attachments.js")

    def test_light_vault_settings_and_ai_chat(self):
        self._run_node_script("test_light_vault_settings.js")

    def test_virtual_note_list_repaints_on_scroll_and_clamps_tail(self):
        """Regression: >120 notes left the viewport inside an empty spacer after a deep scroll."""
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        win_fn = app_js[app_js.find("function virtualListWindow"):app_js.find("function measureNoteRowHeight")]
        self.assertIn("start = Math.min(start, Math.max(0, total - visible))", win_fn)
        self.assertIn("rowHeight = noteRowEstimate", win_fn)
        render_fn = app_js[app_js.find("function renderNotesNow"):app_js.find("function renderNotes()")]
        self.assertIn("&& !virtualWindowStale()", render_fn, "scrolling out of the rendered window must repaint")
        self.assertIn("settleVirtualList();", render_fn)
        self.assertIn("if (!virtualWindowStale()) return;", render_fn)
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertNotIn('id="btn-nav-2fa"', html)
        # Ask AI sits right next to the More/info button in the primary editor toolbar.
        more_at = html.find('id="btn-note-info"')
        ai_at = html.find('id="btn-ai-chat"')
        self.assertGreater(ai_at, more_at)
        between = html[html.find('</button>', more_at) + 9:html.rfind('<button', 0, ai_at)]
        self.assertEqual(between.strip(), '', 'no other control between More and Ask AI')
        self.assertIn('toolbar-primary', html[ai_at:html.find('>', ai_at)])

    def test_push_without_blob_keeps_server_blob(self):
        """Light-vault clients push attachment metadata only; the stored file must survive."""
        db = importlib.import_module("db")
        self._register_user("blob@home.local", "blob-secure-pass")
        uid = db.get_user_by_email("blob@home.local")["id"]
        db.upsert_item(uid, "att-1", "ct-v1", 1, "h1", False, 100.0, "BLOB-BYTES")
        db.upsert_item(uid, "att-1", "ct-v2", 1, "h2", False, 200.0, "")
        row = db.list_items_by_uuid(uid, ["att-1"])[0]
        self.assertEqual(row["ciphertext"], "ct-v2")
        self.assertEqual(row["blob_ciphertext"], "BLOB-BYTES")
        db.upsert_item(uid, "att-1", "ct-v3", 1, "h3", False, 300.0, "NEW-BLOB")
        row = db.list_items_by_uuid(uid, ["att-1"])[0]
        self.assertEqual(row["blob_ciphertext"], "NEW-BLOB")
        db.upsert_item(uid, "att-1", "ct-v4", 1, "h4", True, 400.0, "")
        row = db.list_items_by_uuid(uid, ["att-1"])[0]
        self.assertTrue(row["deleted"])
        self.assertEqual(row["blob_ciphertext"], "")

    def test_ollama_cloud_relay_forwards_key_and_sanitized_body(self):
        """ollama.com has no CORS, so the app relays chat requests for signed-in users only."""
        import ai_relay

        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertNotIn("openrouter", html.lower())
        self.assertIn('id="ai-chat-host"', html)
        self.assertIn("gpt-oss:120b", html)

        body = {"model": "gpt-oss:120b", "messages": [{"role": "user", "content": "hi"}]}
        # Anonymous callers never reach the relay.
        anon = self.client.post("/api/ai/ollama/chat", json=body, headers={"X-Ollama-Key": "k"}, environ_base={"REMOTE_ADDR": "130.0.0.1"})
        self.assertEqual(anon.status_code, 401)

        self._register_legacy_user("relay@home.local", "relay-secure-pass")
        with self.client.session_transaction() as sess:
            csrf = sess["csrf"]
        headers = {"X-Ollama-Key": "secret-key", "X-CSRF-Token": csrf}
        env = {"REMOTE_ADDR": "130.0.0.1"}

        seen = []

        def fake_forward(method, path, api_key, payload, timeout):
            seen.append((method, path, api_key, payload, timeout))
            if path == "/api/chat":
                return 200, {"message": {"role": "assistant", "content": "hello"}}
            if path == "/api/ps":
                return 200, {"models": []}
            return 200, {"models": [{"name": "gpt-oss:120b"}]}

        real_chat, real_info = ai_relay.chat, ai_relay.info
        ai_relay.chat = lambda key, raw, forward=None: real_chat(key, raw, forward=fake_forward)
        ai_relay.info = lambda key, what, forward=None: real_info(key, what, forward=fake_forward)
        try:
            res = self.client.post(
                "/api/ai/ollama/chat",
                json={**body, "stream": True, "options": {"temperature": 0.2, "nested": {"x": 1}}},
                headers=headers,
                environ_base=env,
            )
            self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
            self.assertEqual(res.get_json()["message"]["content"], "hello")
            method, path, key, payload, _timeout = seen[-1]
            self.assertEqual((method, path, key), ("POST", "/api/chat", "secret-key"))
            self.assertFalse(payload["stream"], "relay always asks for a single JSON answer")
            self.assertEqual(payload["options"], {"temperature": 0.2}, "only scalar options pass through")
            self.assertEqual(payload["messages"], [{"role": "user", "content": "hi"}])

            bad = self.client.post("/api/ai/ollama/chat", json={**body, "tools": []}, headers=headers, environ_base=env)
            self.assertEqual(bad.status_code, 400)
            no_key = self.client.post("/api/ai/ollama/chat", json=body, headers={"X-CSRF-Token": csrf}, environ_base=env)
            self.assertEqual(no_key.status_code, 401)
            no_csrf = self.client.post("/api/ai/ollama/chat", json=body, headers={"X-Ollama-Key": "secret-key"}, environ_base=env)
            self.assertEqual(no_csrf.status_code, 400)

            ps = self.client.get("/api/ai/ollama/ps", headers=headers, environ_base=env)
            self.assertEqual(ps.status_code, 200)
            self.assertEqual(seen[-1][:3], ("GET", "/api/ps", "secret-key"))
            tags = self.client.get("/api/ai/ollama/tags", headers=headers, environ_base=env)
            self.assertEqual(tags.get_json()["models"][0]["name"], "gpt-oss:120b")
            other = self.client.get("/api/ai/ollama/version", headers=headers, environ_base=env)
            self.assertEqual(other.status_code, 404, "only ps/tags are relayed")
        finally:
            ai_relay.chat, ai_relay.info = real_chat, real_info

        # Upstream key rejection is passed through and flagged so the client can tell it from a lost session.
        def rejecting(method, path, api_key, payload, timeout):
            return 401, {"error": "unauthorized", "upstream": True}

        status, payload = ai_relay.chat("dead", body, forward=rejecting)
        self.assertEqual(status, 401)
        self.assertTrue(payload["upstream"])
        with self.assertRaises(ai_relay.RelayError):
            ai_relay.chat("k", {"model": "m", "messages": [{"role": "tool", "content": "x"}]}, forward=rejecting)

    def test_client_incremental_sync_watermark(self):
        self._run_node_script("test_sync_since.js")

    def test_client_dirty_queue_survives_lock_and_synced_cursor(self):
        self._run_node_script("test_sync_dirty_queue.js")

    def test_client_lock_and_foreground_sync_do_not_stall(self):
        """Lock must not wait on a slow push; returning to the app must always
        check the server; quiet-sync throttling must use the local clock."""
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        lock_fn = app_js[app_js.find("async function lockVault("):app_js.find("function rememberOpen(")]
        self.assertIn("LOCK_FLUSH_WAIT_MS", lock_fn, "lock waits a bounded time for the pending push")
        self.assertIn("syncVaultLockUi(false)", lock_fn.split("NotesStore.flush()")[0], "lock UI flips before the push")
        self.assertIn("scheduleChangePoll({ background: true })", lock_fn)
        self.assertNotIn("stopChangePoll()", lock_fn.split("scheduleChangePoll")[0], "lock must not stop sync poll before rescheduling")
        fg_fn = app_js[app_js.find("function onAppForeground("):app_js.find("document.addEventListener('click', (event) => {\n    const el = event.target;")]
        self.assertIn("syncNow({ quiet: true, force: true })", fg_fn, "foreground sync bypasses the recent-sync throttle")
        sync_fn = app_js[app_js.find("function syncNow("):app_js.find("function requestManualSync(")]
        self.assertIn("NotesStore.state.lastSyncAt", sync_fn)
        self.assertNotIn("(Date.now() / 1000) - last < 90", sync_fn, "server cursor must not be compared with the local clock")
        self.assertIn("err?.code === 'VAULT_LOCKED'", sync_fn)
        self.assertIn("function pollRemoteChanges()", app_js)
        self.assertNotIn(
            "if (document.visibilityState !== 'visible') return;",
            app_js[app_js.find("async function pollRemoteChanges"):app_js.find("function scheduleChangePoll")],
            "change poll should run while the PWA is unfocused",
        )
        self.assertIn("function kickBackgroundSync()", app_js)
        self.assertIn("function syncWhileVaultLocked(", app_js)
        self.assertIn("scheduleChangePoll({ background: true })", app_js)
        self.assertIn("unfocusSyncBlocksLock", app_js)
        self.assertIn("unlockInFlight", app_js[app_js.find("function unfocusSyncBlocksLock"):app_js.find("function lockVaultAfterUnfocus")])
        self.assertIn("NotesSrpAuth.verifyVault", app_js)
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertIn("async function pushDirtyPersisted", store_js)
        self.assertIn("async function pullCipherWhileLocked", store_js)
        self.assertIn("async function syncWhileLocked", store_js)
        self.assertIn("NotesStore.hasRemoteChanges()", app_js)
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertIn("cursor: 'synced_at'", store_js)
        self.assertNotIn("readStoredLastSync(), localWatermark())", store_js, "local edit clock must not drive the pull cursor")

    def test_client_standard_notes_import(self):
        self._run_node_script("test_snimport.js")

    def test_client_checklist(self):
        self._run_node_script("test_checklist.js")

    def test_client_link_overlay(self):
        self._run_node_script("test_link_overlay.js")

    def test_client_note_history(self):
        self._run_node_script("test_note_history.js")

    def test_client_download_progress(self):
        self._run_node_script("test_download_progress.js")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)
        self.assertIn("download-progress-indeterminate", css)
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        file_overlay = html[html.find('id="file-download-progress"') : html.find('id="file-download-progress"') + 220]
        self.assertIn('aria-modal="true"', file_overlay)

    def test_ocr_text_file(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        self._register_user("ocr@home.local", "ocr-secure-pass")
        missing = self.client.post("/api/ocr")
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.get_json()["error"], "invalid CSRF token")
        ready = self._ocr_post(
            data={"file": (BytesIO(b"Invoice 42 due June"), "invoice.txt")},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.get_json()["text"], "Invoice 42 due June")
        self.assertEqual(ready.get_json()["method"], "text")

    def test_media_preview_endpoint(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        from PIL import Image

        self._register_user("preview@home.local", "preview-secure-pass")
        csrf = self._csrf()
        att_id = "cccccccc-dddd-4eee-8fff-000000000001"
        jpeg = BytesIO()
        Image.new("RGB", (320, 400), "green").save(jpeg, format="JPEG")
        missing = self.client.post("/api/media/preview")
        self.assertEqual(missing.status_code, 400)
        ready = self.client.post(
            "/api/media/preview",
            data={
                "file": (BytesIO(jpeg.getvalue()), "photo.jpg"),
                "att_id": att_id,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(ready.status_code, 200)
        body = ready.get_json()
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("att_id"), att_id)
        preview_b64 = body.get("preview_jpeg_b64") or ""
        self.assertTrue(len(preview_b64) > 40)
        import base64
        preview_bytes = base64.b64decode(preview_b64)
        self.assertTrue(preview_bytes.startswith(b"\xff\xd8"))
        self.assertLessEqual(len(preview_bytes), 96 * 1024)

    def test_ocr_ephemeral_does_not_persist_plaintext(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        self._register_user("index@home.local", "index-secure-pass")
        csrf = self._csrf()
        att_id = "11311311-2222-4333-9044-555555555555"
        first = self._ocr_post(
            data={"file": (BytesIO(b"Invoice 42 due June"), "invoice.txt"), "att_id": att_id},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(first.status_code, 200)
        body = first.get_json()
        self.assertEqual(body["att_id"], att_id)
        self.assertEqual(body["text"], "Invoice 42 due June")
        listed = self.client.get("/api/ocr/index")
        self.assertEqual(listed.status_code, 200)
        payload = listed.get_json()
        self.assertTrue(payload.get("ephemeral"))
        self.assertEqual(payload["count"], 0)
        self.assertEqual(payload["items"], [])
        again = self.client.post("/api/ocr/reindex", headers={"X-CSRF-Token": csrf})
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.get_json().get("ephemeral"))
        self.assertEqual(again.get_json()["count"], 0)
        import db
        from config import DATA_DIR
        user = db.get_user_by_email("index@home.local")
        doc_dir = DATA_DIR / "ocr" / str(user["id"]) / att_id
        self.assertFalse((doc_dir / "meta.json").is_file())
        self.assertFalse((doc_dir / "file").is_file())

    def test_ocr_store_keeps_file_without_plaintext_meta(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        self._register_user("store@home.local", "store-secure-pass")
        csrf = self._csrf()
        att_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        stored = self.client.post(
            "/api/ocr/store",
            data={"file": (BytesIO(b"PLAG1 server document"), "Dna.txt"), "att_id": att_id},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(stored.status_code, 200)
        stored_body = stored.get_json()
        self.assertEqual(stored_body["att_id"], att_id)
        self.assertTrue(stored_body.get("ephemeral"))
        listed = self.client.get("/api/ocr/index").get_json()
        self.assertEqual(listed["count"], 0)
        import db
        import ocr_index
        user = db.get_user_by_email("store@home.local")
        file_path = ocr_index.ocr_root(int(user["id"])) / att_id / "file"
        self.assertTrue(file_path.is_file())
        self.assertFalse((file_path.parent / "meta.json").is_file())
        deleted = self.client.delete(
            f"/api/ocr/{att_id}",
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.get_json().get("deleted"))
        self.assertFalse(file_path.is_file())

    def test_ocr_rejects_unreadable_documents(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        self._register_user("fail@home.local", "fail-secure-pass")
        csrf = self._csrf()
        att_id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
        ready = self._ocr_post(
            data={
                "file": (BytesIO(b"<!DOCTYPE html><html><body>not a pdf</body></html>"), "broken.pdf"),
                "att_id": att_id,
            },
            headers={"X-CSRF-Token": csrf},
            content_type="multipart/form-data",
        )
        self.assertEqual(ready.status_code, 400)
        self.assertIn("error", ready.get_json())

    def test_prepare_combines_photos_into_pdf(self):
        os.environ["NOTES_SERVER_OCR"] = "1"
        from PIL import Image

        self._register_user("scan@home.local", "scan-secure-pass")
        csrf = self._csrf()
        page_one = BytesIO()
        page_two = BytesIO()
        Image.new("RGB", (80, 100), "white").save(page_one, format="JPEG")
        Image.new("RGB", (80, 100), "navy").save(page_two, format="JPEG")
        missing = self.client.post("/api/media/prepare")
        self.assertEqual(missing.status_code, 400)
        ready = self.client.post(
            "/api/media/prepare",
            data={
                "file": [
                    (BytesIO(page_one.getvalue()), "page-1.jpg"),
                    (BytesIO(page_two.getvalue()), "page-2.jpg"),
                ]
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.mimetype, "application/pdf")
        self.assertEqual(ready.headers.get("X-Notes-Filename"), "scan.pdf")
        self.assertTrue(ready.data.startswith(b"%PDF"))
        single = self.client.post(
            "/api/media/prepare",
            data={"file": (BytesIO(page_one.getvalue()), "shot.jpg")},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(single.status_code, 200)
        self.assertEqual(single.mimetype, "image/jpeg")
        self.assertEqual(single.headers.get("X-Notes-Filename"), "scan.jpg")

    def test_server_ocr_disabled_by_default(self):
        self._register_user("noocr@home.local", "noocr-secure-pass")
        res = self.client.post(
            "/api/ocr",
            data={"file": (BytesIO(b"hello"), "note.txt")},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(res.status_code, 403)
        self.assertIn("disabled", res.get_json()["error"].lower())

    def test_server_ocr_helpers(self):
        import ocr as ocr_mod

        extracted = ocr_mod.extract("note.txt", "text/plain", b"Hello")
        self.assertEqual(extracted["text"], "Hello")
        self.assertEqual(extracted["boxes"], [])
        self.assertNotIn("preview_jpeg_b64", extracted)
        sniffed = ocr_mod.extract("fans 1a txt", "application/octet-stream", b"Line one\nLine two")
        self.assertEqual(sniffed["text"], "Line one\nLine two")
        self.assertEqual(sniffed["method"], "text")
        from PIL import Image as PilImage

        jpeg = BytesIO()
        PilImage.new("RGB", (180, 240), "orange").save(jpeg, format="JPEG")
        preview = ocr_mod.render_list_preview("shot.jpg", "image/jpeg", jpeg.getvalue())
        self.assertTrue(preview.startswith(b"\xff\xd8"))
        self.assertLessEqual(len(preview), 96 * 1024)
        self.assertEqual(ocr_mod.render_list_preview("readme.md", "text/plain", b"# hi"), b"")
        html = (
            '<page width="100" height="200">'
            '<word xMin="10" yMin="20" xMax="30" yMax="40">Invoice</word>'
            '<word xMin="32" yMin="20" xMax="40" yMax="40">42</word>'
            "</page>"
        )
        boxes = ocr_mod.parse_bbox_html(html)
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0]["text"], "Invoice")
        self.assertAlmostEqual(boxes[0]["l"], 0.1)
        self.assertAlmostEqual(boxes[0]["t"], 0.1)
        self.assertEqual(boxes[1]["text"], "42")
        tsv = (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t10\t20\t20\t10\t90\tHello\n"
        )
        words = ocr_mod.parse_tsv(tsv, 100, 100, 0)
        self.assertEqual(words[0]["text"], "Hello")
        self.assertAlmostEqual(words[0]["l"], 0.1)
        with self.assertRaises(ocr_mod.OcrError):
            ocr_mod.extract("virus.exe", "application/octet-stream", b"xx")
        self.assertTrue(ocr_mod.weak_ocr_result("payee PrtScn Fe t }", [{"text": "a"}] * 5))
        self.assertTrue(ocr_mod.weak_ocr_result("", []))
        self.assertFalse(ocr_mod.weak_ocr_result(
            "Hello world from invoice number forty two",
            [{"text": "Hello"}] * 10,
        ))
        lines = [
            "FACTURA SIMPLIFICADA",
            "Wasmachine Bosch WAN28",
            "Numero 2020-004183",
            "Fecha 09 12 2020",
            "TOTAL FACTURA 635 EUR",
            "Vencimiento 09 12 2020",
            "Le ha atendido Irene Rodriguez",
            "Muchas gracias por su compra",
        ]
        content = ["BT"]
        top = 760
        for text in lines:
            content.append(f"/F1 14 Tf 1 0 0 1 60 {top} Tm ({text}) Tj")
            top -= 30
        content.append("ET")
        stream = "\n".join(content).encode("latin-1")
        objects = [
            b"<</Type /Catalog /Pages 2 0 R>>",
            b"<</Type /Pages /Kids [3 0 R] /Count 1>>",
            b"<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 902] "
            b"/Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>",
            b"<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
            b"<</Length " + str(len(stream)).encode() + b">>\nstream\n" + stream + b"\nendstream",
        ]
        pdf = bytearray(b"%PDF-1.4\n")
        offsets = []
        for index, body in enumerate(objects, start=1):
            offsets.append(len(pdf))
            pdf += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
        xref_at = len(pdf)
        pdf += f"xref\n0 {len(objects) + 1}\n".encode()
        pdf += b"0000000000 65535 f \n"
        for offset in offsets:
            pdf += f"{offset:010d} 00000 n \n".encode()
        pdf += f"trailer\n<</Size {len(objects) + 1} /Root 1 0 R>>\nstartxref\n{xref_at}\n%%EOF\n".encode()
        raster_calls = []
        original = ocr_mod._pdf_raster_boxes
        ocr_mod._pdf_raster_boxes = lambda path: raster_calls.append(path) or ([], [])
        try:
            digital = ocr_mod.extract("invoice.pdf", "application/pdf", bytes(pdf))
        finally:
            ocr_mod._pdf_raster_boxes = original
        self.assertEqual(raster_calls, [], "dense digital PDFs must not run Tesseract")
        self.assertEqual(digital["method"], "pdftotext")
        self.assertGreaterEqual(len(digital["boxes"]), 5, "digital PDFs keep pdftotext boxes as a paint fallback")
        self.assertIn("Rodriguez", digital["text"])

        from PIL import Image as PilImage

        jpeg = BytesIO()
        PilImage.new("RGB", (40, 50), "red").save(jpeg, format="JPEG")
        jpeg_bytes = jpeg.getvalue()
        prepared = ocr_mod.prepare([("shot.jpg", "image/jpeg", jpeg_bytes)])
        self.assertEqual(prepared["mime"], "image/jpeg")
        self.assertTrue(prepared["data"][:2] == b"\xff\xd8")
        bundled = ocr_mod.prepare([
            ("a.jpg", "image/jpeg", jpeg_bytes),
            ("b.jpg", "image/jpeg", jpeg_bytes),
        ])
        self.assertEqual(bundled["mime"], "application/pdf")
        self.assertTrue(bundled["data"].startswith(b"%PDF"))
        try:
            from pillow_heif import register_heif_opener
            register_heif_opener()
            heic_buf = BytesIO()
            PilImage.new("RGB", (32, 32), "blue").save(heic_buf, format="HEIF")
            heic = ocr_mod.prepare([("IMG_0001.HEIC", "image/heic", heic_buf.getvalue())])
            self.assertEqual(heic["mime"], "image/jpeg")
        except Exception:
            pass

        written = []
        original_run = ocr_mod._run
        original_require = ocr_mod._require
        original_tess_boxes = ocr_mod._tesseract_boxes
        original_tess = ocr_mod._tesseract

        def fake_run(args, timeout=60):
            prefix = Path(args[-1])
            page = prefix.parent / "page-1.jpg"
            page.write_bytes(b"jpg")
            written.append(page)
            raise ocr_mod.OcrError("pdftoppm warning")

        ocr_mod._run = fake_run
        ocr_mod._require = lambda name: name
        ocr_mod._tesseract_boxes = lambda path, page=0: ("hello", [
            {"text": "hello", "l": 0.1, "t": 0.1, "w": 0.1, "h": 0.1, "page": page}
        ])
        ocr_mod._tesseract = lambda path: "hello"
        try:
            boxes, texts = ocr_mod._pdf_raster_boxes(Path(self.tmp.name) / "doc.pdf")
        finally:
            ocr_mod._run = original_run
            ocr_mod._require = original_require
            ocr_mod._tesseract_boxes = original_tess_boxes
            ocr_mod._tesseract = original_tess
        self.assertTrue(written)
        self.assertEqual(written[0].suffix, ".jpg")
        self.assertEqual(texts, ["hello"])
        self.assertEqual(len(boxes), 1)

    def _run_node_script(self, name, timeout=30):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        script = Path(__file__).resolve().parent / name
        try:
            completed = subprocess.run(
                [node, str(script)],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            self.fail(f"{name} timed out after {timeout}s")
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)

    def test_unauthenticated_app_shell_is_ok(self):
        res = self.client.get("/app", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'id="app"', res.data)
        self.assertNotIn("no-store", (res.headers.get("Cache-Control") or "").lower())
        self.assertNotIn("cookie", (res.headers.get("Vary") or "").lower())
        self.assertFalse(res.headers.get("Set-Cookie"))
        ca = self.client.get("/ca.crt")
        self.assertEqual(ca.status_code, 404)

    def test_api_app_shell_serves_current_build_uncached(self):
        # Update download path: same shell as /app, but under /api/ so the service
        # worker cannot answer it from its stale shell cache; never HTTP-cached.
        res = self.client.get("/api/app-shell?t=123", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'id="app"', res.data)
        self.assertIn(b'name="notes-build"', res.data)
        self.assertEqual(res.headers.get("X-Notes-Build"), self.app_mod.NOTES_BUILD)
        self.assertEqual((res.headers.get("Cache-Control") or "").lower(), "no-store")
        self.assertFalse(res.headers.get("Set-Cookie"))
        self.assertNotIn("cookie", (res.headers.get("Vary") or "").lower())
        import re

        shell = self.client.get("/app").data
        self.assertEqual(
            re.search(rb'name="notes-build" content="([^"]+)"', res.data).group(1),
            re.search(rb'name="notes-build" content="([^"]+)"', shell).group(1),
        )

    def test_update_flow_refreshes_every_shell_cache_entry(self):
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        keys_fn = js[js.index("function shellCacheKeys()"):js.index("async function writeShellCache(")]
        self.assertIn("'/app'", keys_fn)
        self.assertNotIn("'/app', '/'", keys_fn)
        self.assertIn('path !== \'/\'', keys_fn)
        for fn_name in ("async function seedShellHtml(", "async function persistAppShell()"):
            start = js.index(fn_name)
            body = js[start:js.index("\n  }\n", start)]
            self.assertIn("writeShellCache(", body, fn_name)
        clear_fn = js[js.index("async function clearAppCaches("):js.index("async function seedShellHtml(")]
        self.assertIn("writeShellCache(keepShellHtml", clear_fn)
        fetch_fn = js[js.index("async function fetchLatestShellHtml("):js.index("async function prefetchShellAssets(")]
        self.assertIn("/api/app-shell?t=", fetch_fn)
        self.assertNotIn("hard=1", fetch_fn)
        force_fn = js[js.index("async function forceRefreshApp()"):js.index("window.notesForceRefreshApp =")]
        self.assertIn("Update did not download the new build", force_fn)
        self.assertIn("preseedLatestShell(build)", js[js.index("function applyServerBuildStatus("):js.index("function openOfflineSecuritySettings()")])
        import auth

        self.assertTrue(auth.public_path("/api/app-shell"))
        self.assertTrue(auth.cacheable_shell("/api/app-shell"))

    def test_app_shell_is_cacheable_without_cookies(self):
        self._register_user("cache@home.local", "cache-secure-pass")
        with self.client.session_transaction() as sess:
            sess.clear()
        os.environ["NOTES_SKIP_LOGIN"] = "1"
        res = self.client.get("/app", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        cache_control = (res.headers.get("Cache-Control") or "").lower()
        self.assertIn("max-age", cache_control)
        self.assertIn("stale-if-error", cache_control)
        self.assertNotIn("no-store", cache_control)
        self.assertFalse(res.headers.get("Set-Cookie"))
        self.assertNotIn("cookie", (res.headers.get("Vary") or "").lower())
        self.assertIn(b'data-csrf=""', res.data)
        css = self.client.get("/static/css/app.css?v=71")
        self.assertEqual(css.status_code, 200)
        self.assertNotIn("no-store", (css.headers.get("Cache-Control") or "").lower())
        self.assertFalse(css.headers.get("Set-Cookie"))
        self.assertIn(b"input[type=\"file\"].sr-file", css.data)
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        save_at = app_js.find("attId = await NotesStore.addAttachment")
        ocr_at = app_js.find("enqueueOcrJob({ attId, noteId: id, file: storeFile, suggestTags: true })")
        self.assertGreater(save_at, 0)
        self.assertGreater(ocr_at, save_at)
        self.assertNotIn("toast('Processing on server…')", app_js)
        self.assertIn("ensureAttachmentOcr", app_js)
        self.assertIn("reconcileServiceWorkerBuild", app_js)
        self.assertIn("hitNoteHost", app_js)
        self.assertNotIn("force: cached.length > 0", app_js)
        self.assertIn("NotesStore.remove(id)", app_js)
        self.assertIn("attachmentOcrSettled", app_js)
        self.assertIn("reindexAllDocuments", app_js)
        self.assertIn("btn-reindex-docs", app_js)
        self.assertIn("queueLocalOcrForAttachments", app_js)
        self.assertIn("purgeServerOcr", app_js)
        self.assertIn("NotesOcr.deleteOcrData", app_js)
        self.assertIn("docSearchActive", app_js)
        self.assertIn("// PDF uses CSS transform zoom only", app_js)
        self.assertIn("NotesOcr.extractFromFile(file, null, attId)", app_js)
        self.assertIn("serverOcrKnown.add(attId)", app_js)
        self.assertNotIn("seedMissingServerDocs", app_js)
        self.assertNotIn("if (att.content.ocr_method && !attachmentNeedsBoxes(att)) continue", app_js)
        self.assertNotIn("NotesStore.staleAttachmentOcr(att.uuid)", app_js)
        self.assertIn("notes_sw_reloaded", app_js)
        self.assertIn("savedDevicePassword", app_js)
        self.assertIn("renderVaultStats", app_js)
        self.assertIn("updateNoteInfoPanel", app_js)
        self.assertIn("LAN-only Wi‑Fi may report navigator.onLine=false", app_js)
        self.assertIn("updateSecureContextHint", app_js)
        self.assertIn("renderNoteRow", app_js)
        self.assertIn("noteListPreview", app_js)
        self.assertIn("kindIconSvg", app_js)
        self.assertIn("listThumbPlaceholderHtml", app_js)
        self.assertIn("paintListThumbFallback", app_js)
        self.assertIn("updateFab", app_js)
        self.assertIn("'Pinned'", app_js)
        self.assertNotIn("notes_sw_claimed", app_js)
        self.assertIn("['wheel', 'touchstart', 'pointerdown', 'keydown']", app_js)
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertIn("discardItem(id)", store_js)
        self.assertIn("NotesIDB.deleteItem(id)", store_js)
        self.assertIn("const OCR_INDEX = 59", store_js)
        self.assertIn("staleAttachmentOcr", store_js)
        self.assertIn("if (unchanged) return false", store_js)
        preview_js = (APP_DIR / "static" / "js" / "preview.js").read_text(encoding="utf-8")
        self.assertIn("if (!painted) painted = paintOcrBoxesDom(layer, boxes, query, page)", preview_js)
        self.assertNotIn("inkPageCanvas(pageCanvas, rects)", preview_js)
        self.assertNotIn("drawHitRects(overlay, rects)", preview_js)
        self.assertIn("notesNetworkReachable", preview_js)
        ocr_js = (APP_DIR / "static" / "js" / "ocr.js").read_text(encoding="utf-8")
        client_ocr_js = (APP_DIR / "static" / "js" / "client-ocr-engine.js").read_text(encoding="utf-8")
        self.assertIn("prepareImages", ocr_js)
        self.assertIn("NotesClientOcr", ocr_js)
        self.assertIn("extractFromFile", client_ocr_js)
        self.assertIn("createWorker", client_ocr_js)
        self.assertIn("renderListPreview", client_ocr_js)
        self.assertNotIn("/api/ocr", ocr_js)
        self.assertNotIn("/api/media/preview", ocr_js)
        self.assertIn("NotesSuperscript.convertTo", app_js)
        self.assertIn("NotesSuperscript.convertFrom", app_js)
        self.assertIn("isRichTextEditor", app_js)
        self.assertIn("renderNoteBodyPreview", app_js)
        self.assertIn("openExternalLink", app_js)
        self.assertIn("bindPreviewExternalLinks", app_js)
        self.assertIn("editor === 'markdown' || editor === 'plain'", app_js)
        self.assertIn("window.open(url, '_blank', 'noopener,noreferrer')", app_js)
        self.assertIn("serverReachable", ocr_js)
        self.assertIn("deleteOcrData", ocr_js)
        self.assertIn("fetchListPreview", ocr_js)
        self.assertIn("decodePreviewB64", ocr_js)
        self.assertIn("Reading text on this device", app_js)
        self.assertIn("setAttachmentPreview", store_js)
        self.assertIn("getAttachmentPreviewBytes", store_js)
        self.assertIn("preview_enc", store_js)
        self.assertIn("paintListThumbFromPreviewEnc", app_js)
        self.assertIn("queueListPreviewBackfill", app_js)
        self.assertIn("resumePendingListPreviews", app_js)
        self.assertIn("previewDiagnostics", app_js)
        self.assertIn("refreshIosPdfPlaceholders", app_js)
        self.assertIn("iosDeferPdfPreview(att, { forList }) && !att?.content?.preview_enc", app_js)
        self.assertIn("isScanImage(localFile) && NotesOcr.needsPrepare", app_js)
        self.assertIn("ensureServerSession", app_js)
        self.assertIn("attachmentOcrStatus", app_js)
        self.assertIn("attachmentOcrRetryable", app_js)
        self.assertIn("attachmentOcrBusy", app_js)
        self.assertIn("attachmentOcrSpinnerHtml", app_js)
        self.assertIn("startOcrUiWatch", app_js)
        self.assertIn("buildNoteListSectionsHtml", app_js)
        self.assertIn("retryAttachmentOcr", app_js)
        self.assertIn("refreshSettingsDiagnostics", app_js)
        self.assertIn("repairDocumentSearch", app_js)
        self.assertIn("countStaleNoteSearchIndexes", app_js)
        self.assertIn("privacy-status", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('id="list-plan-badge"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("brand-mark-monogram-sm", (APP_DIR / "templates" / "partials" / "brand-mark.html").read_text(encoding="utf-8"))
        self.assertIn("renderPlanUi", app_js)
        self.assertIn("updatePlanBadge", app_js)
        self.assertIn("copyDiagnostics", app_js)
        self.assertIn("uploadDeviceReport", app_js)
        self.assertRegex(app_js, r"async function uploadDeviceReport[\s\S]{0,1210}deviceReportNeedsSessionRetry")
        self.assertIn("sendChecklistToServer", app_js)
        self.assertIn("loadPersistedSelfTestResults", app_js)
        self.assertIn("lastDeviceReportUploadResult", app_js)
        self.assertIn("buildDiagnosticsText", app_js)
        self.assertIn("applyTagSection", app_js)
        self.assertIn('id="tag-section"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("btn-copy-diagnostics", app_js)
        self.assertIn("runPhotoSearchSelfTest", app_js)
        self.assertIn("notesRunPhotoSearchSelfTest", app_js)
        self.assertIn("buildIphoneChecklistReport", app_js)
        self.assertIn("runUiRegressionSelfTest", app_js)
        self.assertIn("runAllDeviceTests", app_js)
        self.assertIn("btn-refresh-app", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("forceRefreshApp", app_js)
        self.assertIn("Checking notes server", app_js)
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("__notesShowUpdateProgress", html)
        self.assertIn("app-update-progress", html)
        self.assertIn("app-update-spinner", html)
        self.assertIn("btn-app-update-cancel", html)
        self.assertIn("seedShellHtml", app_js)
        self.assertIn("Keep the service worker registered", app_js)
        self.assertIn("location.replace(`${appPath}?t=${Date.now()}&nosync=1`)", app_js)
        self.assertNotIn("&hard=1", app_js)
        self.assertIn("Could not download the update — your current app was kept", app_js)
        self.assertIn("OFFLINE_LAN_HINT", app_js)
        self.assertIn("Update needs a live connection", app_js)
        self.assertIn("notesMarkNetworkReachable", app_js)
        self.assertIn("Join home Wi‑Fi or WireGuard", app_js)
        self.assertIn("touchUpdatedAt: false", store_js)
        # iOS OOM fix: attachment bytes never live in state.items
        self.assertIn("file_enc_stored", store_js)
        self.assertIn("strippedAttachmentContent", store_js)
        self.assertIn("storedAttachmentFileEnc", store_js)
        self.assertIn("getItem", (APP_DIR / "static" / "js" / "idb.js").read_text(encoding="utf-8"))
        self.assertIn("noteEditedAtMs", app_js)
        self.assertIn("Sync ${pct}%", app_js)
        self.assertIn("phase === 'syncing'", app_js)
        self.assertIn("notesView", app_js)
        self.assertIn("e.key === 'Backspace'", app_js)
        self.assertIn("isContentEditable", app_js)
        self.assertIn("Never history.back()", app_js)
        self.assertIn("keyboard opens for Search", app_js)
        self.assertIn("notes_require_unlock_after_update", app_js)
        self.assertIn("Always re-lock after Update", app_js)
        self.assertIn("requireUnlockAfterUpdate", app_js)
        self.assertIn("markUnlockAfterUpdate", app_js)
        self.assertIn("Update / leave-app lock must stay on the vault lock screen", app_js)
        self.assertIn("forceLockAfterUpdate", app_js)
        self.assertIn("Vault password stays in memory only", app_js)
        self.assertIn("updateViaCache", app_js)
        self.assertIn("Never reload here", app_js)
        self.assertIn("SKIP_WAITING", app_js)
        self.assertNotIn("location.reload();", app_js)
        self.assertIn("notes_allow_boot_unlock", app_js)
        self.assertIn("notes_boot_password_ready", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("beginVaultPull", app_js)
        self.assertIn("Full vault pulls must always receive ciphertext", store_js)
        self.assertIn("unchanged-miss", store_js)
        self.assertIn("refetchSyncItems", store_js)
        self.assertIn("needsFullVault", store_js)
        self.assertIn("unchanged-refetch", store_js)
        self.assertIn("isVaultReadyForSync", app_js)
        self.assertIn("markVaultShellLocked", app_js)
        self.assertIn("isEditorOpen", app_js)
        self.assertIn("unlockErrorShouldRelock", app_js)
        self.assertIn("repairUnlockWithPassword", app_js)
        self.assertIn("clearUnreadableLocalCache", app_js)
        self.assertIn("canProveViaSync", app_js)
        self.assertIn("deferSearchIndex", store_js)
        self.assertIn("vault-pulling", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        self.assertIn("Same-tab Safari refetches keep sessionStorage", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        html_src = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("Apply theme before first paint", html_src)
        self.assertIn('type="text" placeholder="Search', html_src)
        self.assertIn('class="search-leading"', html_src)
        self.assertIn('id="fab-add"', html_src)
        self.assertIn('type="button" id="btn-back"', html_src)
        self.assertIn('type="button" id="btn-star"', html_src)
        self.assertIn("simulatePinchZoom", app_js)
        self.assertIn("notesClearAppCaches", app_js)
        self.assertIn("PREVIEW_CACHE_MAX", app_js)
        self.assertIn("shrinkPreviewCacheForBackground", app_js)
        self.assertIn("makeListThumbUrl", app_js)
        self.assertIn("clearListThumbCache", app_js)
        self.assertIn("One decode at a time", app_js)
        self.assertIn("IS_IOS", app_js)
        self.assertIn("pdf.js loads lazily", app_js)
        self.assertIn("notes_open_id", app_js)
        self.assertIn("consumeNoteDeepLink", app_js)
        self.assertIn("openRememberedNote", app_js)
        self.assertIn("offlineUnlockVerified", app_js)
        self.assertIn("pwaStandaloneVerified", app_js)
        self.assertIn("isStandalonePwa", app_js)
        self.assertIn("markOfflineUnlockVerified", app_js)
        self.assertIn("Probe /api/health", app_js)
        self.assertIn("uploadPendingDeviceReport", app_js)
        self.assertIn("updateOfflineSetupBanner", app_js)
        self.assertIn("enableRememberDevice", app_js)
        self.assertIn("maybeAutoEnableRememberDevice", app_js)
        self.assertIn("maybePromptOfflineSetup", app_js)
        self.assertIn("notes_remember_device_declined", app_js)
        self.assertIn("offline-setup-banner", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("notes_pending_device_report", app_js)
        self.assertIn("notesRunAllDeviceTests", app_js)
        self.assertIn("refreshAllNoteSearchIndexes", app_js)
        self.assertIn("pullNoteOcrFromServer", app_js)
        self.assertIn("noteSearchStale", app_js)
        self.assertIn("repairSearchIndexesForQuery", app_js)
        self.assertIn("deferOcrJob", app_js)
        self.assertIn("paintFindOnInlineDocument", app_js)
        self.assertIn("refresh app cache on Wi", app_js)
        self.assertIn("openNoteDiagnostics", app_js)
        self.assertIn("Searchable ·", app_js)
        self.assertIn("ocr-quality.js", html)
        self.assertIn("method === 'none'", app_js)
        self.assertIn("normalizeOcrStorage", app_js)
        self.assertIn("No text found in this document", app_js)
        self.assertIn("openScanComposer", app_js)
        self.assertIn("scan-camera", app_js)
        self.assertNotIn("offerRemoveUploadedSource", app_js)
        self.assertNotIn("Remove from device?", app_js)
        self.assertIn("ingestDocumentBatch", app_js)
        self.assertIn("pickDeviceFiles", app_js)
        self.assertIn("UPLOAD_PICKER_ID", app_js)
        self.assertIn("rememberUploadPickerDirectory", app_js)
        self.assertIn("loadUploadPickerStartIn", app_js)
        self.assertIn("primeUploadPickerStartIn", app_js)
        self.assertIn("openDeviceFilePickerSync", app_js)
        self.assertIn("uploadPickerStartInCache = undefined", app_js)
        self.assertIn("dir.queryPermission", app_js)
        self.assertIn("File too large to upload", (APP_DIR / "app.py").read_text(encoding="utf-8"))
        self.assertIn("80 * 1024 * 1024", (APP_DIR / "app.py").read_text(encoding="utf-8"))
        self.assertIn("drops user activation", app_js)
        self.assertIn("describeDuplicateAttachment", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("Open note", app_js)
        self.assertIn("Save them on one new note, or in a new folder with one note per file.", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('id="folder-section"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('name="scan-save-as"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        batch_fn = app_js[app_js.find("async function ingestDocumentBatch"):app_js.find("function canOcrAttachment")]
        self.assertEqual(batch_fn.count("createNote({ silent: true, title })"), 1)
        self.assertIn("createIfNeeded: false", batch_fn)
        self.assertIn("ocrPending", app_js)
        self.assertIn("ocr_method === 'pending'", app_js)
        self.assertIn("searchIndexCovers", app_js)
        self.assertIn("ocr_owner", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("type: 'search_index'", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("memoryConstrained", (APP_DIR / "static" / "js" / "client-ocr-engine.js").read_text(encoding="utf-8"))
        self.assertNotIn('"-l", str(MAX_PDF_PAGES)', (APP_DIR / "ocr.py").read_text(encoding="utf-8"))
        self.assertIn("Number.POSITIVE_INFINITY", (APP_DIR / "static" / "js" / "client-ocr-engine.js").read_text(encoding="utf-8"))
        self.assertIn("Number(item.content.ocr_index) !== current", app_js)
        self.assertIn("lockedShellHtml", app_js)
        self.assertIn("highlightFindPreview", app_js)
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertNotIn("navigator.onLine === false && !options.allowOffline", store_js)
        self.assertIn("notesNetworkReachable", store_js)
        self.assertIn("function emitSync(phase, message)", store_js)
        self.assertIn("DECRYPT_PARTIAL", store_js)
        self.assertIn("bootstrapServerSession", app_js)
        self.assertIn("NotesVaultSecrets", (APP_DIR / "static" / "js" / "vault-secrets.js").read_text(encoding="utf-8"))
        self.assertIn("consumeBootPassword", (APP_DIR / "static" / "js" / "vault-secrets.js").read_text(encoding="utf-8"))
        self.assertIn("NotesSrpAuth", (APP_DIR / "static" / "js" / "srp-auth.js").read_text(encoding="utf-8"))
        self.assertIn("NotesPasskeys", (APP_DIR / "static" / "js" / "passkeys.js").read_text(encoding="utf-8"))
        self.assertIn("privacy-status", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn('id="list-plan-badge"', (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        self.assertIn("brand-mark-monogram-sm", (APP_DIR / "templates" / "partials" / "brand-mark.html").read_text(encoding="utf-8"))
        self.assertIn("renderPlanUi", app_js)
        self.assertIn("updatePlanBadge", app_js)
        self.assertIn("handleVaultDecryptFailure", app_js)
        self.assertIn("Already signed in with the login password", app_js)
        self.assertIn("align_after_vault_rekey", store_js)
        self.assertIn("account_password", store_js)
        self.assertIn("NotesVaultSecrets.getAccountPassword", store_js)
        self.assertIn("repairUnlockWithPassword", app_js)
        self.assertIn("checkVaultPasswordOnline", app_js)
        self.assertIn("verifyOnly", app_js)
        self.assertIn("hadStaleLocalCipher", app_js)
        self.assertIn("verifyVaultPassword", store_js)
        self.assertIn("fetchAttachmentBlobFromServer", store_js)
        self.assertIn("NOTES_STRICT_ZK", (APP_DIR / ".." / "deploy" / "deeperguard.env.example").read_text(encoding="utf-8"))
        self.assertIn("Wrong vault password. Use the same password that unlocks Notes on your phone.", app_js)
        self.assertIn("total_undeleted", store_js)
        self.assertIn("Downloading full vault", store_js)
        self.assertNotIn("noteCount === 0 && Number.isFinite(serverTotal)", store_js)
        self.assertIn("clearUnreadableLocal", store_js)
        self.assertIn("onlyIfMemoryEmpty", store_js)
        self.assertIn("sync-notes-lost", store_js)
        self.assertIn("sync-recovered-local", store_js)
        self.assertIn("localCipherCount", store_js)
        self.assertNotIn("full && NotesStore.clearUnreadableLocal", app_js)
        self.assertIn("localCipher === 0", app_js)
        self.assertIn("Downloading…", store_js)
        self.assertIn("expectedTotal", store_js)
        self.assertIn("LOCAL_DECRYPT_FAILED", store_js)
        self.assertIn("Byte-budget pages can be shorter", store_js)
        self.assertIn("sync({ full: true })", app_js)
        self.assertNotIn("if (!vaultReady || !NotesStore.isUnlocked())", app_js)
        self.assertIn("UNLOCK_DOWNLOAD_TIMEOUT_MS = 20000", app_js)
        self.assertIn("sync-status-banner", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        self.assertIn("btn-empty-dismiss", html)
        self.assertIn("btn-sync-now", html)
        self.assertIn("brand-sync-row", html)
        self.assertIn("unlock-progress", html)
        self.assertIn("login-progress-overlay", html)
        self.assertIn("btn-empty-sync", html)
        self.assertIn("requestManualSync", app_js)
        self.assertIn("force: true", app_js)
        self.assertIn("btn-empty-relock", html)
        self.assertIn("btn-change-password", html)
        self.assertIn("password-toggle", html)
        self.assertIn("setPasswordChangeButtonState", app_js)
        self.assertIn("btn.primary.success", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        self.assertIn("changePassword", store_js)
        self.assertIn("password_changed_at", store_js)
        self.assertIn("remotePasswordChanged", store_js)
        self.assertIn("prepareForRemotePasswordRotation", store_js)
        self.assertIn("checkRemoteVaultPasswordChange", app_js)
        self.assertIn("repairAttachmentsWithPreviousPassword", store_js)
        self.assertIn("btn-repair-attachments", html)
        self.assertIn("openSettingsShell", html)
        self.assertIn("__notesHardRefresh", html)
        self.assertIn("sessionStorage.setItem('notes_update_dismissed_build'", html)
        self.assertIn("btn-settings-head", html)
        self.assertIn("btn-account-info-head", html)
        self.assertIn("account-info-dialog", html)
        self.assertIn("showAccountInfo", app_js)
        self.assertIn("hero-guide-dialog", html)
        self.assertIn("fab-scan", html)
        self.assertIn("showHeroGuideIfNeeded", app_js)
        self.assertIn("offerDocumentSearch", app_js)
        self.assertIn("btn-open-admin", html)
        self.assertIn("account-info-email", html)
        self.assertNotIn("server-info-dialog", html)
        self.assertNotIn("/api/server/info", app_js)
        self.assertIn("server_info_cache", (APP_DIR / "app.py").read_text(encoding="utf-8"))
        self.assertIn("btn-lock-head", html)
        self.assertIn("btn-lock-head", app_js)
        self.assertIn("btn-reload-notes", html)
        import subprocess
        syntax = subprocess.run(
            ["node", "--check", str(APP_DIR / "static" / "js" / "app.js")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr or syntax.stdout)
        self.assertIn("Empty IndexedDB must not reuse a stale watermark", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("notesShowSettings", html)
        self.assertIn("settingsEventNode", html)
        self.assertIn("__notesSettingsOpenedAt", app_js)
        self.assertIn("__notesOpenSettings", html)
        self.assertIn("notesSendChecklist", app_js)
        self.assertIn("notesSendChecklist", html)
        self.assertIn("tagsCollapsed: true", app_js)
        self.assertIn("viewsCollapsed: false", app_js)
        self.assertIn('id="filter-section"', html)
        self.assertIn("update-available", app_js)
        self.assertIn("Never auto-reload", app_js)
        self.assertIn("showAppUpdateModal", app_js)
        self.assertIn("flushPendingUpdatePrompt", app_js)
        self.assertIn("notes_user_requested_update", app_js)
        self.assertIn("filter-select", html)
        self.assertIn('id="sort-select"', html)
        self.assertIn('id="sort-select-sidebar"', html)
        self.assertNotIn('id="pref-sort"', html)
        self.assertIn("NOTE_SORT_ORDER", app_js)
        self.assertIn("setNoteSort", app_js)
        self.assertIn("listUsesDateSections", (APP_DIR / "static" / "js" / "search.js").read_text(encoding="utf-8"))
        self.assertIn("list-toolbar", html)
        self.assertIn("listChromeDense", app_js)
        self.assertIn("jumpDocSearchHit", app_js)
        self.assertIn("scrollHitIntoView", (APP_DIR / "static" / "js" / "preview.js").read_text(encoding="utf-8"))
        self.assertIn("listSearchHits", (APP_DIR / "static" / "js" / "preview.js").read_text(encoding="utf-8"))
        self.assertIn("data-doc-hit-nav", app_js)
        self.assertIn("data-doc-hit-dismiss", app_js)
        self.assertIn("dismissDocHitNote", app_js)
        self.assertIn("docHitNoteSuppressed", app_js)
        self.assertIn(".doc-hit-note-actions", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        self.assertIn(".doc-hit-note-dismiss", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))

        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn(".doc-inline-stage:has(pre)", css)
        self.assertIn("noteReadableText", app_js)
        self.assertIn(".list-toolbar", css)
        self.assertIn(".fab", css)
        self.assertIn(".app-update-progress", css)
        self.assertIn("@keyframes app-update-spin", css)
        self.assertIn("Tabs already consume safe-area-inset-top", css)
        self.assertIn(".note-pin", css)
        self.assertIn(".note-progress", css)
        self.assertIn(".search-leading", css)
        self.assertIn(".sidebar-foot { display: none; }", css)
        self.assertIn('class="sidebar-foot"', html)
        self.assertIn("sidebar-nav", html)
        self.assertIn("list-pane", html)
        self.assertIn("--sn-nav-width", css)
        self.assertIn('html[data-theme="light"]', css)
        self.assertIn("--sn-nav-bg: #f2f2f7", css)
        self.assertIn("listStoredFiles", app_js)
        self.assertIn("stored attachments only", (APP_DIR / "static" / "js" / "search.js").read_text(encoding="utf-8"))
        self.assertIn('id="btn-settings-head"', html)
        self.assertIn('id="btn-new-list"', html)
        self.assertIn("deriveVaultKey", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("if (String(converted || '').trim()) editorMode = 'preview'", app_js)
        self.assertLess(html.index('id="settings-panel"'), html.index('id="btn-logout"'))
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        self.assertIn("--font:", css)
        self.assertIn("--note-title-size: 16px", css)
        self.assertIn("font-size: var(--note-title-size)", css)
        self.assertNotIn(".editor-pane .title-input {\n    font-size: 22px", css)
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("applyNoteTypographyVars", app_js)
        self.assertIn("--note-title-size", app_js)
        self.assertIn("--note-preview-size", css)
        self.assertIn(".note-item h3,\n.title-input", css)
        self.assertIn("--shadow-sm:", css)
        self.assertIn(".list-pane .note-row {", css)
        self.assertIn('id="signed-in-devices"', html)
        self.assertIn("function loadSignedInDevices()", app_js)
        self.assertIn("function startSignedInDevicesRefresh()", app_js)
        self.assertIn("10000", app_js[app_js.index("function startSignedInDevicesRefresh"):app_js.index("async function loadSignedInDevices")])
        self.assertIn("/api/sessions", app_js)
        self.assertIn("X-Device-Id", (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8"))
        self.assertIn("padding-bottom: calc(72px + var(--safe-bottom))", css)
        self.assertIn("padding: 8px 16px 4px", css)
        self.assertIn(".tag-section:not([open]) > :not(summary)", css)
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn(".note-list-head {\n    display: flex;", mobile)
        self.assertIn("sidebar-update", html)
        self.assertIn("body.settings-open #settings-panel", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        self.assertNotIn("body.locked #settings-panel", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        self.assertIn("SETTINGS_FLUSH_TIMEOUT_MS", app_js)
        query_pos = app_js.index("const query = activeFindNeedle();")
        show_pos = app_js.index("editorMode === 'preview' || !!query")
        self.assertLess(query_pos, show_pos)
        self.assertIn("LAN-only Wi‑Fi may report navigator.onLine=false", html)
        self.assertIn("probeHealth", html)
        self.assertIn("updateAppUpdateBanner", app_js)
        self.assertIn("updateAppVersionBadge", app_js)
        self.assertIn("applyServerBuildStatus", app_js)
        self.assertIn("maybePromptAppUpdate", app_js)
        self.assertIn("removed — banner only", app_js)
        self.assertIn("data.build && build && String(data.build) !== build", app_js)
        self.assertIn(".app-version.stale", (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8"))
        # Review fixes: lock shows unlock UI; unlockInFlight cleared; Update tap not multi-fired;
        # SW skew only advertises when SW build is newer than the page.
        self.assertIn("showUnlock(cached.email || undefined)", app_js)
        self.assertIn("unlockInFlight = null", app_js)
        self.assertRegex(
            app_js,
            r"try \{\s*await unlockInFlight;\s*\} catch \(err\) \{\s*abortUnlockAttempt\(err\);\s*\} finally \{\s*unlockInFlight = null;",
        )
        self.assertIn("notesForceRefreshApp", app_js)
        self.assertIn("notesForceRefreshApp", html)
        self.assertIn("e.stopPropagation()", html)
        self.assertIn("swNum > pageNum", app_js)
        self.assertNotIn("appUpdateBtn.addEventListener('click'", app_js)
        self.assertNotIn("updateBtn.addEventListener('click', hardRefresh)", html)
        self.assertIn("async function hydrateVaultUi", app_js)
        self.assertIn("async function finishUnlocked", app_js)
        self.assertIn("revealAppShell", app_js)
        self.assertIn("repairUnlockShellState", app_js)
        repair_fn = app_js[app_js.find("function repairUnlockShellState"):app_js.find("function abortUnlockAttempt")]
        self.assertNotIn("return false;", repair_fn)
        self.assertIn("showApp();", repair_fn)
        lock_fn = app_js[app_js.find("async function lockVault"):app_js.find("function rememberOpen")]
        self.assertTrue(
            "unlock-error" in lock_fn or "unlockError.textContent = message" in lock_fn,
            "relock must write the reason into #unlock-error",
        )
        self.assertIn("submitUnlockForm", app_js)
        self.assertIn('id="unlock-form"', html)
        self.assertIn("onsubmit=\"event.preventDefault(); return false;\"", html)
        self.assertIn("if (!vaultHydrated)", app_js)
        self.assertIn("lastNotesRenderKey = ''", app_js)

    def test_note_swipe_delete_hidden_until_open(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn(".note-swipe-delete", css)
        self.assertIn("visibility: hidden", css)
        self.assertIn(".note-row.open .note-swipe-delete", css)
        self.assertIn("noteRowDeleteBtnHtml", app_js)
        self.assertIn("note-row-delete", app_js)
        self.assertRegex(css, r"\.note-item\s*\{[^}]*background:\s*var\(--bg-elevated\)")
        self.assertIn(".note-row-delete", css)
        self.assertIn("position: absolute", css[css.find(".note-row-delete"):css.find(".note-row-delete") + 200])
        self.assertIn(".note-row-delete {\n    display: inline-flex;", css)

    def test_skip_login_defaults_off(self):
        os.environ.pop("NOTES_SKIP_LOGIN", None)
        import config
        self.assertFalse(config.skip_login())
        res = self.client.get("/app", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'data-skip-login="0"', res.data)

    def test_skip_login_opens_app_without_credentials(self):
        self._register_user("skip@home.local", "skip-secure-pass")
        with self.client.session_transaction() as sess:
            sess.clear()
        os.environ["NOTES_SKIP_LOGIN"] = "1"
        res = self.client.get("/app", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'data-skip-login="1"', res.data)
        login = self.client.get("/login", follow_redirects=False)
        self.assertEqual(login.status_code, 302)
        account = self.client.get("/api/account")
        self.assertEqual(account.status_code, 200)
        self.assertEqual(account.get_json()["email"], "skip@home.local")
        self.assertTrue(account.get_json()["csrf"])
        self.assertFalse(account.headers.get("Clear-Site-Data"))

    def test_skip_login_ignored_when_cidr_gate_disabled(self):
        self._register_user("skip-wan@home.local", "skip-secure-pass")
        with self.client.session_transaction() as sess:
            sess.clear()
        os.environ["NOTES_SKIP_LOGIN"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        import auth
        self.assertFalse(auth.ensure_skip_login_session())
        account = self.client.get("/api/account")
        self.assertEqual(account.status_code, 401)
        sw = self.client.get("/sw.js")
        self.assertEqual(sw.status_code, 200)
        self.assertIn(b"deeperguard-offline", sw.data)

    def test_login_page_does_not_redirect_when_authenticated(self):
        self._register_user("loop@home.local", "loop-secure-pass")
        res = self.client.get("/login", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Sign in", res.data)
        self.assertIn(b'class="brand-beta"', res.data)
        self.assertNotIn(b'auth-beta-banner', res.data)
        self.assertIn(b'aria-label="Public beta"', res.data)
        self.assertIn(b'brand-mark-wrap', res.data)
        self.assertIn(b'brand-mark-svg', res.data)
        self.assertIn(b">Beta<", res.data)
        self.assertIn(b"zk-plain", res.data)
        self.assertIn(b"Account password", res.data)
        auth_js = (APP_DIR / "static" / "js" / "auth-pages.js").read_text(encoding="utf-8")
        self.assertIn("location.replace(afterAuthUrl('/app'))", auth_js)
        self.assertNotIn("location.href = afterAuthUrl('/app')", auth_js)

    def test_login_post_does_not_return_method_not_allowed(self):
        res = self.client.post(
            "/login",
            data={"email": "loop@home.local", "password": "wrong"},
            follow_redirects=False,
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Sign in", res.data)
        self.assertNotIn(b"Method Not Allowed", res.data)
        self.assertIn(b"Reload this page", res.data)

    def test_register_page_shows_beta_badge(self):
        res = self.client.get("/register", follow_redirects=False)
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'class="brand-beta"', res.data)
        self.assertNotIn(b'auth-beta-banner', res.data)
        self.assertIn(b'aria-label="Public beta"', res.data)
        self.assertIn(b'brand-mark-wrap', res.data)
        self.assertIn(b'brand-mark-svg', res.data)
        self.assertIn(b">Beta<", res.data)

    def test_account_password_change(self):
        self._register_legacy_user("passchange@home.local", "old-secure-pass")
        csrf = self._csrf()
        bad = self.client.post(
            "/api/account/password",
            json={"current_password": "wrong", "new_password": "new-secure-pass"},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(bad.status_code, 401)
        good = self.client.post(
            "/api/account/password",
            json={"current_password": "old-secure-pass", "new_password": "new-secure-pass"},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(good.status_code, 200)
        self.assertIn("password_changed_at", good.get_json())
        self.assertGreater(good.get_json().get("password_changed_at", 0), 0)
        unlock = self.client.post(
            "/api/account/unlock",
            json={},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(unlock.status_code, 200)
        align = self.client.post(
            "/api/account/password",
            json={
                "current_password": "vault-only-pass",
                "new_password": "aligned-secure-pass",
                "align_after_vault_rekey": True,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(align.status_code, 401, "align without account_password must fail")
        align_bad_account = self.client.post(
            "/api/account/password",
            json={
                "current_password": "vault-only-pass",
                "new_password": "aligned-secure-pass",
                "align_after_vault_rekey": True,
                "account_password": "wrong-login",
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(align_bad_account.status_code, 401)
        align_ok = self.client.post(
            "/api/account/password",
            json={
                "current_password": "vault-only-pass",
                "new_password": "aligned-secure-pass",
                "align_after_vault_rekey": True,
                "account_password": "new-secure-pass",
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(align_ok.status_code, 200)
        unlock_aligned = self.client.post(
            "/api/account/unlock",
            json={},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(unlock_aligned.status_code, 200)
        still_bad = self.client.post(
            "/api/account/password",
            json={
                "current_password": "nope",
                "new_password": "another-secure-pass",
                "align_after_vault_rekey": False,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(still_bad.status_code, 401)

    def test_srp_account_password_change_requires_current_password(self):
        import db as notes_db

        email = "srp-passchange@home.local"
        current = "old-srp-secure-pass"
        nxt = "new-srp-secure-pass"
        stolen = "stolen-srp-secure-pass"
        self._register_user(email, current)
        csrf = self._csrf()
        user = notes_db.get_user_by_email(email)
        old_salt = str(user["srp_salt"])
        old_verifier = str(user["srp_verifier"])
        stolen_salt, stolen_verifier = self._srp_verifier(email, stolen)
        hijack = self.client.post(
            "/api/account/password",
            json={"srp_salt": stolen_salt, "srp_verifier": stolen_verifier},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(hijack.status_code, 401)
        user = notes_db.get_user_by_email(email)
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(old_verifier, 16))
        wrong = self.client.post(
            "/api/account/password",
            json={
                "current_password": "wrong-srp-pass",
                "new_password": nxt,
                "srp_salt": stolen_salt,
                "srp_verifier": stolen_verifier,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(wrong.status_code, 401)
        new_salt, new_verifier = self._srp_verifier(email, nxt)
        good = self.client.post(
            "/api/account/password",
            json={
                "current_password": current,
                "new_password": nxt,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.get_json().get("auth_method"), "srp")
        self.assertGreater(good.get_json().get("password_changed_at", 0), 0)
        old_login = self._srp_login(email, current, old_salt)
        self.assertEqual(old_login.status_code, 401)
        new_login = self._srp_login(email, nxt, new_salt)
        self.assertEqual(new_login.status_code, 200)
        csrf = self._csrf()
        align_bad = self.client.post(
            "/api/account/password",
            json={
                "current_password": "vault-only-pass",
                "new_password": "aligned-srp-secure-pass",
                "align_after_vault_rekey": True,
                "account_password": "wrong-login",
                "srp_salt": stolen_salt,
                "srp_verifier": stolen_verifier,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(align_bad.status_code, 401)
        aligned_salt, aligned_verifier = self._srp_verifier(email, "aligned-srp-secure-pass")
        align_ok = self.client.post(
            "/api/account/password",
            json={
                "current_password": "vault-only-pass",
                "new_password": "aligned-srp-secure-pass",
                "align_after_vault_rekey": True,
                "account_password": nxt,
                "srp_salt": aligned_salt,
                "srp_verifier": aligned_verifier,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(align_ok.status_code, 200)
        aligned_login = self._srp_login(email, "aligned-srp-secure-pass", aligned_salt)
        self.assertEqual(aligned_login.status_code, 200)

    def test_account_unlock_requires_session(self):
        self._register_legacy_user("unlock@home.local", "unlock-secure-pass")
        with self.client.session_transaction() as sess:
            sess.clear()
        unauth = self.client.post("/api/account/unlock", json={})
        self.assertEqual(unauth.status_code, 401)
        self.client.post(
            "/api/auth/login",
            json={"email": "unlock@home.local", "password": "unlock-secure-pass"},
        )
        csrf = self._csrf()
        good = self.client.post(
            "/api/account/unlock",
            json={},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(good.status_code, 200)
        self.assertTrue(good.get_json()["kdf_salt"])
        self.assertEqual(good.get_json()["vault_kdf_version"], 2)
        self.assertEqual(good.get_json()["auth_method"], "argon2")

    def test_legacy_password_login_rate_limited(self):
        os.environ["NOTES_AUTH_RATE_LIMIT"] = "2"
        self._register_legacy_user("legacy-rate@home.local", "legacy-secure-pass")
        import auth_rate_limit as arl

        arl._hits.clear()
        for _ in range(2):
            res = self.client.post(
                "/api/auth/login",
                json={"email": "legacy-rate@home.local", "password": "wrong"},
            )
            self.assertEqual(res.status_code, 401)
        blocked = self.client.post(
            "/api/auth/login",
            json={"email": "legacy-rate@home.local", "password": "wrong"},
        )
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.get_json()["error"], "too many attempts")

    def test_content_security_policy_headers(self):
        import re

        from config import app_entry_path

        resp = self.client.get(app_entry_path())
        self.assertEqual(resp.status_code, 200)
        csp = resp.headers.get("Content-Security-Policy") or ""
        self.assertTrue(csp)
        self.assertIn("default-src 'self'", csp)
        self.assertIn("worker-src 'self' blob:", csp)
        html = resp.get_data(as_text=True)
        nonce_match = re.search(r'nonce="([^"]+)"', html)
        self.assertTrue(nonce_match)
        self.assertIn(f"'nonce-{nonce_match.group(1)}'", csp)

    def test_kdf_session_cache_never_persists_derived_key(self):
        self._run_node_script("test_kdf_session_cache.js")

    def test_vault_kdf_upgrade(self):
        self._register_user("kdf@home.local", "kdf-secure-pass")
        csrf = self._csrf()
        account = self.client.get("/api/account", headers={"X-CSRF-Token": csrf})
        self.assertEqual(account.get_json()["vault_kdf_version"], 2)
        with self.client.application.app_context():
            import db

            user = db.get_user_by_email("kdf@home.local")
            db.update_user_vault_kdf_version(int(user["id"]), 1)
        account = self.client.get("/api/account", headers={"X-CSRF-Token": csrf})
        self.assertEqual(account.get_json()["vault_kdf_version"], 1)
        upgraded = self.client.post(
            "/api/account/vault-kdf",
            json={"vault_kdf_version": 2},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(upgraded.status_code, 200)
        self.assertEqual(upgraded.get_json()["vault_kdf_version"], 2)
        noop = self.client.post(
            "/api/account/vault-kdf",
            json={"vault_kdf_version": 2},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(noop.status_code, 200)

    def test_srp_register_and_login(self):
        import hashlib

        email = "srp@home.local"
        password = "srp-secure-pass"
        salt_hex, verifier = self._srp_verifier(email, password, hashlib.sha256(b"test-salt-seed").hexdigest())

        reg = self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )
        self.assertEqual(reg.status_code, 200)
        self.assertEqual(reg.get_json()["auth_method"], "srp")
        with self.client.session_transaction() as sess:
            sess.clear()
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        body = challenge.get_json()
        self.assertEqual(body["srp_salt"], salt_hex)
        self.assertTrue(body["B"])
        verify = self._srp_login(email, password, salt_hex)
        self.assertEqual(verify.status_code, 200)
        self.assertIn("M2", verify.get_json())

    def test_srp_verify_rejects_degenerate_client_public(self):
        import hashlib

        from srp_auth import _h, _to_hex

        email = "srp-degen@home.local"
        password = "srp-degen-pass"
        salt_hex, verifier = self._srp_verifier(email, password, hashlib.sha256(b"degen-salt").hexdigest())
        reg = self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )
        self.assertEqual(reg.status_code, 200)
        with self.client.session_transaction() as sess:
            sess.clear()
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        b_hex = str(challenge.get_json()["B"]).lower()
        m1 = _h("0" + b_hex + _to_hex(0))
        verify = self.client.post(
            "/api/auth/srp/verify",
            json={"email": email, "A": "0", "M1": m1},
        )
        self.assertEqual(verify.status_code, 401)
        self.assertEqual(verify.get_json().get("error"), "invalid credentials")
        with self.client.session_transaction() as sess:
            self.assertFalse(sess.get("authed"))

    def _degenerate_a_cases(self):
        """Client public values that violate SRP-6a (A mod N == 0), with best-effort M1."""
        from srp_auth import N, _h, _to_hex

        def forged_m1(a_hex: str, b_hex: str) -> str:
            return _h(a_hex + b_hex + _to_hex(0))

        return [_to_hex(value) for value in (0, N, 2 * N)], forged_m1

    def test_srp_verify_rejects_a_multiple_of_n(self):
        email = "srp-degen-n@home.local"
        password = "srp-degen-n-pass"
        reg = self._register_user(email, password)
        self.assertEqual(reg.status_code, 200)
        degenerate_a, forged_m1 = self._degenerate_a_cases()
        for a_hex in degenerate_a:
            with self.client.session_transaction() as sess:
                sess.clear()
            challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
            self.assertEqual(challenge.status_code, 200)
            b_hex = str(challenge.get_json()["B"]).lower()
            verify = self.client.post(
                "/api/auth/srp/verify",
                json={"email": email, "A": a_hex, "M1": forged_m1(a_hex, b_hex)},
            )
            self.assertEqual(verify.status_code, 401, f"A={a_hex[:16]}…")
            self.assertEqual(verify.get_json().get("error"), "invalid credentials")
            self.assertNotIn("M2", verify.get_json())
            with self.client.session_transaction() as sess:
                self.assertFalse(sess.get("authed"))

    def test_repair_login_rejects_a_multiple_of_n(self):
        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "repair-degen@home.local"
        password = "repair-degen-pass"
        stored_salt, stored_verifier = self._srp_verifier(email, password)
        user_id = notes_db.create_user_srp(email, new_kdf_salt(), stored_salt, stored_verifier)
        rotation_salt = new_srp_salt_hex()
        rotation_verifier = generate_verifier_hex(rotation_salt, email, password)
        degenerate_a, forged_m1 = self._degenerate_a_cases()
        for a_hex in degenerate_a:
            with self.client.session_transaction() as sess:
                sess.clear()
            challenge = self.client.post(
                "/api/auth/repair-login/challenge", json={"email": email}
            )
            self.assertEqual(challenge.status_code, 200)
            b_hex = str(challenge.get_json()["B"]).lower()
            denied = self.client.post(
                "/api/auth/repair-login",
                json={
                    "email": email,
                    "srp_salt": rotation_salt,
                    "srp_verifier": rotation_verifier,
                    "A": a_hex,
                    "M1": forged_m1(a_hex, b_hex),
                },
            )
            self.assertEqual(denied.status_code, 401, f"A={a_hex[:16]}…")
            self.assertEqual(denied.get_json().get("error"), "invalid credentials")
            with self.client.session_transaction() as sess:
                self.assertFalse(sess.get("authed"))
            user = notes_db.get_user_by_id(user_id)
            self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))
            self.assertEqual(str(user["srp_salt"]).lower(), stored_salt.lower())

    def test_vault_recovery_rejects_a_multiple_of_n(self):
        import secrets
        import time

        import db as notes_db
        from config import SESSION_SECONDS
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "vault-degen@home.local"
        password = "vault-degen-pass"
        stored_salt, stored_verifier = self._srp_verifier(email, password)
        user_id = notes_db.create_user_srp(email, new_kdf_salt(), stored_salt, stored_verifier)
        rotation_salt = new_srp_salt_hex()
        rotation_verifier = generate_verifier_hex(rotation_salt, email, password)
        sess_csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(user_id)
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["totp_ok"] = True
            sess["csrf"] = sess_csrf
        degenerate_a, forged_m1 = self._degenerate_a_cases()
        for a_hex in degenerate_a:
            challenge = self.client.post(
                "/api/auth/vault-recovery/challenge",
                json={"email": email},
                headers={"X-CSRF-Token": sess_csrf},
            )
            self.assertEqual(challenge.status_code, 200)
            b_hex = str(challenge.get_json()["B"]).lower()
            denied = self.client.post(
                "/api/auth/vault-recovery",
                json={
                    "email": email,
                    "srp_salt": rotation_salt,
                    "srp_verifier": rotation_verifier,
                    "A": a_hex,
                    "M1": forged_m1(a_hex, b_hex),
                },
                headers={"X-CSRF-Token": sess_csrf},
            )
            self.assertEqual(denied.status_code, 401, f"A={a_hex[:16]}…")
            self.assertEqual(denied.get_json().get("error"), "invalid credentials")
            self.assertFalse(denied.get_json().get("vault_recovered"))
            user = notes_db.get_user_by_id(user_id)
            self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))
            self.assertEqual(str(user["srp_salt"]).lower(), stored_salt.lower())

    def test_srp_register_notifies_admins_by_email(self):
        try:
            import admin_notify
        except ImportError:
            self.skipTest("admin_notify module not configured in this build")
        from unittest.mock import patch
    
        import hashlib
    
        email = "notify-admin@home.local"
        password = "notify-secure-pass"
        salt_hex, verifier = self._srp_verifier(email, password, hashlib.sha256(b"notify-salt").hexdigest())
        calls = []
        with patch.object(
            admin_notify,
            "send_plain_email",
            side_effect=lambda recipient, subject, body: calls.append((recipient, subject, body)),
        ):
            with patch.object(admin_notify, "admin_notification_recipients", return_value=["admin@home.local"]):
                reg = self.client.post(
                    "/api/auth/srp/register",
                    json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
                )
        self.assertEqual(reg.status_code, 200)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "admin@home.local")
        self.assertIn(email, calls[0][1])
        self.assertIn(email, calls[0][2])
        self.assertIn("new user subscribed", calls[0][2].lower())

    def test_srp_register_survives_signup_notify_failure(self):
        import admin_notify
        from unittest.mock import patch

        email = "fail-notify@home.local"
        password = "fail-notify-secure-pass"
        with patch.object(admin_notify, "send_plain_email", side_effect=RuntimeError("smtp down")):
            with patch.object(admin_notify, "admin_notification_recipients", return_value=["admin@home.local"]):
                reg = self._register_user(email, password)
        self.assertEqual(reg.status_code, 200)
        import db as notes_db

        self.assertIsNotNone(notes_db.get_user_by_email(email))

    def test_legacy_register_disabled(self):
        res = self.client.post(
            "/api/auth/register",
            json={"email": "new@home.local", "password": "new-secure-pass"},
        )
        self.assertEqual(res.status_code, 410)
        self.assertIn("zero-knowledge", res.get_json().get("error", ""))

    def test_srp_upgrade_from_legacy_login(self):
        email = "upgrade@home.local"
        password = "upgrade-secure-pass"
        self._register_legacy_user(email, password)
        with self.client.session_transaction() as sess:
            sess.clear()
        login = self.client.post("/api/auth/login", json={"email": email, "password": password})
        self.assertEqual(login.status_code, 200)
        salt_hex, verifier = self._srp_verifier(email, password)
        upgraded = self.client.post(
            "/api/auth/srp/upgrade",
            json={"srp_salt": salt_hex, "srp_verifier": verifier},
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(upgraded.status_code, 200)
        account = self.client.get("/api/account", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(account.get_json()["auth_method"], "srp")

    def test_srp_resync_after_verifier_drift(self):
        email = "resync@home.local"
        password = "resync-secure-pass"
        self._register_legacy_user(email, password)
        good_salt, good_verifier = self._srp_verifier(email, password)
        import db as notes_db

        user = notes_db.get_user_by_email(email)
        notes_db.upgrade_user_to_srp(int(user["id"]), good_salt, good_verifier)
        bad_salt, bad_verifier = self._srp_verifier(email, "wrong-password")
        notes_db.update_user_srp_verifier(int(user["id"]), bad_salt, bad_verifier)
        with self.client.session_transaction() as sess:
            sess.clear()
        challenge = self.client.post("/api/auth/srp/challenge", json={"email": email})
        self.assertEqual(challenge.status_code, 200)
        verify = self._srp_login(email, password, bad_salt)
        self.assertEqual(verify.status_code, 401)
        new_salt, new_verifier = self._srp_verifier(email, password)
        resync = self.client.post(
            "/api/auth/srp/resync",
            json={
                "email": email,
                "password": password,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
            },
        )
        self.assertEqual(resync.status_code, 200)
        body = resync.get_json()
        self.assertTrue(body.get("srp_resynced"))
        self.assertEqual(body.get("email"), email)
        login = self._srp_login(email, password, new_salt)
        self.assertEqual(login.status_code, 200)

    def test_vault_recovery_realigns_login(self):
        import db as notes_db
        from passwords import new_kdf_salt
        from vault_crypto import encrypt_object

        email = "vault-recover@home.local"
        password = "vault-recover-pass"
        # Stored verifier matches the account's current password; recovery proves against it
        # (SRP step2 bound to the *stored* verifier) before rotating to a fresh salt/verifier.
        stored_salt, stored_verifier = self._srp_verifier(email, password)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, stored_salt, stored_verifier)
        notes_db.update_user_vault_kdf_version(user_id, 1)
        ciphertext = encrypt_object(
            password,
            kdf_salt,
            1,
            {"type": "note", "title": "Recovery check", "content": "secret"},
        )
        notes_db.upsert_item(
            user_id,
            "recovery-note-uuid",
            ciphertext,
            1,
            "recovery-hash",
            False,
            notes_db.now(),
        )
        with self.client.session_transaction() as sess:
            sess.clear()
        new_salt, _ = self._srp_verifier(email, password)
        import secrets
        import time

        from config import SESSION_SECONDS

        sess_csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(user_id)
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["totp_ok"] = True
            sess["csrf"] = sess_csrf
        a_hex, m1, new_verifier = self._srp_credential_proof(
            email,
            password,
            new_salt,
            "/api/auth/vault-recovery/challenge",
            headers={"X-CSRF-Token": sess_csrf},
        )
        recovered = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "A": a_hex,
                "M1": m1,
            },
            headers={"X-CSRF-Token": sess_csrf},
        )
        self.assertEqual(recovered.status_code, 200, recovered.get_json())
        self.assertTrue(recovered.get_json().get("vault_recovered"))
        login = self._srp_login(email, password, new_salt)
        self.assertEqual(login.status_code, 200)

        session_only = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
            },
            headers={"X-CSRF-Token": sess_csrf},
        )
        self.assertEqual(session_only.status_code, 400)

        denied = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": new_salt,
                "srp_verifier": new_verifier,
                "A": a_hex,
                "M1": m1,
            },
        )
        self.assertEqual(denied.status_code, 400)
        self.assertEqual(denied.get_json()["error"], "invalid CSRF token")

    def test_vault_recovery_rejects_self_made_verifier(self):
        """A session + CSRF holder cannot rotate SRP without proving the *stored* password.

        Guards M-1: the recovery proof must authenticate against the verifier on file, so a
        self-generated salt/verifier/proof (the old self-referential path) is rejected.
        """
        import db as notes_db
        from passwords import new_kdf_salt

        email = "vault-recover-attack@home.local"
        password = "vault-recover-real-pass"
        attacker_pw = "attacker-chosen-pass"
        stored_salt, stored_verifier = self._srp_verifier(email, password)
        user_id = notes_db.create_user_srp(email, new_kdf_salt(), stored_salt, stored_verifier)

        import secrets
        import time

        from config import SESSION_SECONDS

        sess_csrf = secrets.token_urlsafe(32)
        with self.client.session_transaction() as sess:
            sess["uid"] = int(user_id)
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["totp_ok"] = True
            sess["csrf"] = sess_csrf

        # Attacker completes an SRP exchange, but the server's challenge is bound to the
        # stored verifier, so a proof computed from the attacker's chosen password fails.
        evil_salt, evil_verifier = self._srp_verifier(email, attacker_pw)
        a_hex, m1, _ = self._srp_credential_proof(
            email,
            attacker_pw,
            evil_salt,
            "/api/auth/vault-recovery/challenge",
            headers={"X-CSRF-Token": sess_csrf},
        )
        denied = self.client.post(
            "/api/auth/vault-recovery",
            json={
                "email": email,
                "srp_salt": evil_salt,
                "srp_verifier": evil_verifier,
                "A": a_hex,
                "M1": m1,
            },
            headers={"X-CSRF-Token": sess_csrf},
        )
        self.assertEqual(denied.status_code, 401)
        user = notes_db.get_user_by_id(user_id)
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))

    def test_verify_vault_disabled_in_strict_zk(self):
        res = self.client.post(
            "/api/auth/verify-vault",
            json={"email": "any@home.local", "password": "any-password-here"},
        )
        self.assertEqual(res.status_code, 410)
        self.assertTrue(res.get_json().get("strict_zk"))

    def test_verify_vault_checks_password_without_session(self):
        os.environ["NOTES_STRICT_ZK"] = "0"
        for name in list(sys.modules):
            if name in {"app", "config", "auth"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import db as notes_db
        from passwords import new_kdf_salt
        from vault_crypto import encrypt_object

        email = "verify-vault@home.local"
        password = "verify-vault-pass"
        salt_hex, verifier = self._srp_verifier(email, password)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, salt_hex, verifier)
        notes_db.update_user_vault_kdf_version(user_id, 1)
        corrupt_cipher = '{"v":1,"iv":"AAAA","data":"BBBB"}'
        good_cipher = encrypt_object(
            password,
            kdf_salt,
            1,
            {"type": "note", "title": "Recovery check", "content": "secret"},
        )
        notes_db.upsert_item(user_id, "bad-tag", corrupt_cipher, 1, "bad-hash", False, notes_db.now())
        notes_db.upsert_item(user_id, "good-note", good_cipher, 1, "good-hash", False, notes_db.now())
        with self.client.session_transaction() as sess:
            sess.clear()
        ok = self.client.post(
            "/api/auth/verify-vault",
            json={"email": email, "password": password},
        )
        self.assertEqual(ok.status_code, 200, ok.get_json())
        wrong = self.client.post(
            "/api/auth/verify-vault",
            json={"email": email, "password": "not-the-vault-pass"},
        )
        self.assertEqual(wrong.status_code, 401)

    def test_verify_vault_empty_vault_returns_400(self):
        os.environ["NOTES_STRICT_ZK"] = "0"
        for name in list(sys.modules):
            if name in {"app", "config", "auth"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import db as notes_db
        from passwords import new_kdf_salt

        email = "empty-vault@home.local"
        password = "empty-vault-pass"
        salt_hex, verifier = self._srp_verifier(email, password)
        kdf_salt = new_kdf_salt()
        notes_db.create_user_srp(email, kdf_salt, salt_hex, verifier)
        with self.client.session_transaction() as sess:
            sess.clear()
        res = self.client.post(
            "/api/auth/verify-vault",
            json={"email": email, "password": password},
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("no encrypted notes", res.get_json().get("error", ""))

    def test_repair_login_rejects_plaintext_password_by_default(self):
        import db as notes_db
        from passwords import new_kdf_salt

        email = "no-plain-repair@home.local"
        password = "no-plain-repair-pass"
        salt_hex, verifier = self._srp_verifier(email, password)
        notes_db.create_user_srp(email, new_kdf_salt(), salt_hex, verifier)
        with self.client.session_transaction() as sess:
            sess.clear()
        denied = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "password": password},
        )
        self.assertEqual(denied.status_code, 400)

    def test_repair_login_wrong_password_does_not_500(self):
        import db as notes_db
        from passwords import new_kdf_salt
        from vault_crypto import encrypt_object

        email = "srp-only@home.local"
        password = "srp-only-pass"
        salt_hex, verifier = self._srp_verifier(email, password)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, salt_hex, verifier)
        notes_db.update_user_vault_kdf_version(user_id, 1)
        ciphertext = encrypt_object(
            password,
            kdf_salt,
            1,
            {"type": "note", "title": "Only", "content": "note"},
        )
        notes_db.upsert_item(user_id, "only-note", ciphertext, 1, "only-hash", False, notes_db.now())
        with self.client.session_transaction() as sess:
            sess.clear()
        wrong = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier, "A": "1", "M1": "2"},
        )
        self.assertEqual(wrong.status_code, 401, wrong.get_data(as_text=True))
        self.assertTrue(wrong.get_json().get("repair_exhausted"))

    def test_repair_login_skips_client_srp(self):
        os.environ["NOTES_REPAIR_LOGIN_PASSWORD"] = "1"
        for name in list(sys.modules):
            if name in {"app", "config", "auth"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        import db as notes_db
        from passwords import hash_password, new_kdf_salt

        email = "repair-login@home.local"
        password = "repair-login-pass"
        wrong = "wrong-repair-pass"
        salt_hex, bad_verifier = self._srp_verifier(email, wrong)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, salt_hex, bad_verifier)
        notes_db.update_user_password(user_id, hash_password(password))
        with self.client.session_transaction() as sess:
            sess.clear()
        repaired = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "password": password},
        )
        self.assertEqual(repaired.status_code, 200, repaired.get_json())
        self.assertTrue(repaired.get_json().get("login_repaired"))
        wrong = self.client.post(
            "/api/auth/repair-login",
            json={"email": email, "password": "nope-not-it-xx"},
        )
        self.assertEqual(wrong.status_code, 401)
        self.assertTrue(wrong.get_json().get("repair_exhausted"))

    def test_login_page_falls_back_to_repair_login_after_srp_failure(self):
        auth_js = (APP_DIR / "static" / "js" / "auth-pages.js").read_text(encoding="utf-8")
        srp_js = (APP_DIR / "static" / "js" / "srp-auth.js").read_text(encoding="utf-8")
        self.assertIn("NotesSrpAuth.passwordSignIn", auth_js)
        self.assertIn("function passwordSignIn", srp_js)
        self.assertIn("/api/auth/repair-login", srp_js)
        self.assertIn("shouldRetryWithRepairAfterSrp", srp_js)
        self.assertNotIn("if (!srpErr?.repairExhausted)", auth_js)

    def test_repair_login_rejects_self_made_verifier(self):
        """Unauthenticated repair-login must not accept a client-made salt/verifier/proof.

        Guards H-1: the challenge/proof is bound to the account's *stored* verifier, so a
        caller who only knows a self-chosen password (not the stored one) cannot overwrite
        another account's SRP verifier or obtain a session. An honest SRP-only drift that no
        longer matches the stored verifier simply fails closed.
        """
        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "srp-drift@home.local"
        password = "srp-drift-password"
        stored_pw = "stored-srp-drift-pass"
        stored_salt, stored_verifier = self._srp_verifier(email, stored_pw)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, stored_salt, stored_verifier)
        attacker_salt = new_srp_salt_hex()
        attacker_verifier = generate_verifier_hex(attacker_salt, email, password)
        with self.client.session_transaction() as sess:
            sess.clear()
        # Proof derived from the attacker-chosen password cannot complete the exchange the
        # server seeds from the stored verifier.
        a_hex, m1, _ = self._srp_credential_proof(
            email,
            password,
            attacker_salt,
            "/api/auth/repair-login/challenge",
        )
        denied = self.client.post(
            "/api/auth/repair-login",
            json={
                "email": email,
                "srp_salt": attacker_salt,
                "srp_verifier": attacker_verifier,
                "A": a_hex,
                "M1": m1,
            },
        )
        self.assertEqual(denied.status_code, 401, denied.get_json())
        user = notes_db.get_user_by_id(user_id)
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(stored_verifier, 16))

    def test_repair_login_accepts_proof_against_stored_verifier(self):
        """Honest repair-login: a proof against the stored verifier rotates to a fresh salt."""
        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        email = "srp-repair-ok@home.local"
        password = "srp-repair-ok-pass"
        stored_salt, stored_verifier = self._srp_verifier(email, password)
        kdf_salt = new_kdf_salt()
        user_id = notes_db.create_user_srp(email, kdf_salt, stored_salt, stored_verifier)
        rotated_salt = new_srp_salt_hex()
        rotated_verifier = generate_verifier_hex(rotated_salt, email, password)
        with self.client.session_transaction() as sess:
            sess.clear()
        a_hex, m1, _ = self._srp_credential_proof(
            email,
            password,
            rotated_salt,
            "/api/auth/repair-login/challenge",
        )
        repaired = self.client.post(
            "/api/auth/repair-login",
            json={
                "email": email,
                "srp_salt": rotated_salt,
                "srp_verifier": rotated_verifier,
                "A": a_hex,
                "M1": m1,
            },
        )
        self.assertEqual(repaired.status_code, 200, repaired.get_json())
        self.assertTrue(repaired.get_json().get("login_repaired"))
        user = notes_db.get_user_by_id(user_id)
        self.assertEqual(int(str(user["srp_verifier"]), 16), int(rotated_verifier, 16))
        login = self._srp_login(email, password, rotated_salt)
        self.assertEqual(login.status_code, 200)

    def test_app_repair_unlock_uses_password_sign_in(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        start = app_js.find("async function repairUnlockWithPassword")
        end = app_js.find("async function establishServerSessionAfterVaultUnlock", start)
        fn = app_js[start:end]
        self.assertIn("NotesSrpAuth.passwordSignIn", fn)
        self.assertNotIn("NotesSrpAuth.login(normalized, password)", fn)

    def test_finish_unlock_does_not_prompt_session_modal_immediately(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("ensureServerSession({ prompt: false })", app_js)
        self.assertIn("markJustUnlocked()", app_js)

    def test_account_unlock_allowed_when_totp_pending(self):
        import db as notes_db

        email = "totp-pending@home.local"
        password = "totp-pending-pass"
        self._register_user(email, password)
        user = notes_db.get_user_by_email(email)
        notes_db.update_user_totp(int(user["id"]), "BASE32SECRETBASE32SECRETBASE", True)
        with self.client.session_transaction() as sess:
            sess.clear()
            sess["uid"] = int(user["id"])
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = False
            sess["csrf"] = "totp-pending-csrf"
        blocked = self.client.get("/api/account")
        self.assertEqual(blocked.status_code, 403)
        unlock = self.client.post("/api/account/unlock", json={})
        self.assertEqual(unlock.status_code, 200, unlock.get_json())
        self.assertEqual(unlock.get_json().get("email"), email)

    def test_webauthn_credentials_list_requires_auth(self):
        res = self.client.get("/api/auth/webauthn/credentials")
        self.assertEqual(res.status_code, 404)

    def test_webauthn_register_options_rejects_ip_host(self):
        import config
        from unittest.mock import patch

        from webauthn_helper import passkey_host_error

        self._register_user("passkey@home.local", "passkey-secure-pass")
        with self.client.application.test_request_context("/", base_url="https://192.168.178.143/"):
            err = passkey_host_error()
        self.assertIn("hostname", err or "")
        self.assertEqual(config.webauthn_preferred_host(), "www.deeperguard.com")
        with patch("webauthn_helper._request_host", return_value="192.168.178.143"):
            res = self.client.post(
                "/api/auth/webauthn/register/options",
                json={},
                headers={"X-CSRF-Token": self._csrf()},
            )
        self.assertEqual(res.status_code, 400)
        self.assertIn("hostname", res.get_json().get("error", ""))

    def test_account_includes_passkey_host_fields(self):
        self._register_user("pkmeta@home.local", "pkmeta-secure-pass")
        res = self.client.get("/api/account")
        body = res.get_json()
        self.assertIn("passkey_url", body)
        self.assertIn("www.deeperguard.com", body["passkey_url"])
        self.assertFalse(body["passkey_host_ok"])  # test client host is localhost
        with self.client.application.test_request_context(
            "/api/account", base_url="https://www.deeperguard.com/"
        ):
            from webauthn_helper import passkey_host_error

            self.assertIsNone(passkey_host_error())

    def test_totp_disable_srp_without_password(self):
        import hashlib
        from unittest.mock import patch

        from srp_auth import G, N

        email = "totp-srp@home.local"
        password = "totp-srp-secure-pass"
        salt_hex = hashlib.sha256(b"totp-salt").hexdigest()
        hash1 = hashlib.sha256(f"{email}:{password}".encode()).hexdigest()
        while hash1.startswith("0"):
            hash1 = hash1[1:]
        x_hash = hashlib.sha256(f"{salt_hex}{hash1}".upper().encode()).hexdigest()
        while x_hash.startswith("0"):
            x_hash = x_hash[1:]
        x = int(x_hash, 16) % N
        verifier = format(pow(G, x, N), "x")
        self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )
        csrf = self._csrf()
        self.client.post("/api/totp/setup", headers={"X-CSRF-Token": csrf})
        with patch("app.totp_mod.verify", return_value=True):
            self.client.post(
                "/api/totp/enable",
                json={"code": "123456"},
                headers={"X-CSRF-Token": csrf},
            )
            csrf = self._csrf()
            disabled = self.client.post(
                "/api/totp/disable",
                json={"code": "123456"},
                headers={"X-CSRF-Token": csrf},
            )
        self.assertEqual(disabled.status_code, 200)

    def test_totp_setup(self):
        self._register_user("2fa@home.local", "another-secure-pass")
        setup = self.client.post("/api/totp/setup", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(setup.status_code, 200)
        self.assertIn("secret", setup.get_json())

    def test_pcloud_settings_and_sync(self):
        from unittest.mock import patch

        self._register_user("pcloud@home.local", "pcloud-secure-pass")
        csrf = {"X-CSRF-Token": self._csrf()}
        account = self.client.get("/api/account", headers=csrf)
        self.assertEqual(account.status_code, 200)
        data = account.get_json()
        self.assertFalse(data["pcloud_enabled"])
        self.assertFalse(data["pcloud_password_set"])
        self.assertEqual(data["pcloud_remote_path"], "Deeperguard/backups")

        missing = self.client.post(
            "/api/backup/pcloud/settings",
            headers=csrf,
            json={"username": "user@pcloud.test", "enabled": True},
        )
        self.assertEqual(missing.status_code, 400)

        saved = self.client.post(
            "/api/backup/pcloud/settings",
            headers=csrf,
            json={
                "username": "user@pcloud.test",
                "password": "pcloud-secret",
                "remote_path": "Backups/notes",
                "region": "eu",
                "enabled": True,
            },
        )
        self.assertEqual(saved.status_code, 200)
        self.assertTrue(saved.get_json()["password_set"])

        account2 = self.client.get("/api/account", headers=csrf)
        self.assertTrue(account2.get_json()["pcloud_enabled"])
        self.assertEqual(account2.get_json()["pcloud_username"], "user@pcloud.test")
        self.assertEqual(account2.get_json()["pcloud_remote_path"], "Backups/notes")
        self.assertTrue(account2.get_json()["pcloud_password_set"])

        with patch("backup_pcloud.subprocess.run") as run_mock, patch(
            "backup_pcloud.rclone_bin", return_value="/usr/bin/rclone"
        ):
            run_mock.return_value = type("Proc", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            sync = self.client.post("/api/backup/pcloud/sync", headers=csrf, json={})
        self.assertEqual(sync.status_code, 200)
        self.assertTrue(sync.get_json()["ok"])
        self.assertEqual(sync.get_json()["remote_path"], "Backups/notes")
        copy_calls = [c for c in run_mock.call_args_list if c.args and "copy" in c.args[0]]
        delete_calls = [c for c in run_mock.call_args_list if c.args and "delete" in c.args[0]]
        self.assertEqual(len(copy_calls), 1)
        self.assertEqual(len(delete_calls), 1)

        account3 = self.client.get("/api/account", headers=csrf)
        self.assertEqual(account3.get_json()["pcloud_last_sync_status"], "ok")

    def test_email_backup_streams_instead_of_loading_vault(self):
        mail = (APP_DIR / "backup_mail.py").read_text(encoding="utf-8")
        cron = (APP_DIR / "backup_cron.py").read_text(encoding="utf-8")
        self.assertIn("def compact_payload_streaming", mail)
        self.assertIn("def ensure_local_full_backup", mail)
        self.assertNotIn("db.export_backup_payload(user_id)", mail)
        self.assertLess(cron.index("run_pcloud_backups()"), cron.index("users_with_backup_enabled()"))

    def test_new_user_gets_default_storage_quota(self):
        import db as notes_db

        os.environ["NOTES_DEFAULT_PLAN"] = "basic"
        os.environ["NOTES_DEFAULT_USER_QUOTA_MB"] = "100"
        self._register_user("quota@home.local", "quota-secure-pass")
        user = notes_db.get_user_by_email("quota@home.local")
        self.assertIsNotNone(user)
        self.assertEqual(notes_db.user_plan(user), "basic")
        self.assertEqual(int(user["storage_quota_bytes"]), 100 * 1024 * 1024)

    def test_new_user_defaults_to_pro_plan(self):
        import db as notes_db
        from plans import plan_storage_quota_bytes

        os.environ["NOTES_DEFAULT_PLAN"] = "pro"
        self._register_user("pro@home.local", "pro-secure-pass")
        user = notes_db.get_user_by_email("pro@home.local")
        self.assertIsNotNone(user)
        self.assertEqual(notes_db.user_plan(user), "pro")
        self.assertEqual(int(user["storage_quota_bytes"]), plan_storage_quota_bytes("pro"))

    def test_account_includes_subscription_plan(self):
        self._register_user("plan@home.local", "plan-secure-pass")
        res = self.client.get("/api/account", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["plan"], "pro")
        self.assertIn("plan_features", data)
        self.assertTrue(data["plan_features"]["passkeys"])
        self.assertIn("plan_pricing", data)
        self.assertFalse(data["plan_pricing"]["billing_active"])

    def test_basic_plan_blocks_passkey_registration(self):
        import db as notes_db

        self._register_user("basic@home.local", "basic-secure-pass")
        user = notes_db.get_user_by_email("basic@home.local")
        notes_db.update_user_plan(int(user["id"]), "basic")
        csrf = self._csrf()
        res = self.client.post(
            "/api/auth/webauthn/register/options",
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(res.status_code, 403)
        body = res.get_json()
        self.assertEqual(body["code"], "plan_required")
        self.assertEqual(body["required_plan"], "pro")

    def test_admin_can_change_user_plan(self):
        import db as notes_db
        from passwords import new_kdf_salt

        member_salt, member_ver = self._srp_verifier("member@home.local", "member-secure-pass")
        notes_db.create_user_srp("member@home.local", new_kdf_salt(), member_salt, member_ver)
        self._register_user("admin@home.local", "admin-secure-pass")
        admin = notes_db.get_user_by_email("admin@home.local")
        member = notes_db.get_user_by_email("member@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        csrf = self._csrf()
        patch = self.client.patch(
            f"/api/admin/users/{int(member['id'])}",
            headers={"X-CSRF-Token": csrf},
            json={"plan": "basic"},
        )
        self.assertEqual(patch.status_code, 200)
        updated = patch.get_json()["user"]
        self.assertEqual(updated["plan"], "basic")
        member = notes_db.get_user_by_email("member@home.local")
        self.assertEqual(notes_db.user_plan(member), "basic")

    def test_sync_push_rejects_over_quota(self):
        import db as notes_db

        self._register_user("full@home.local", "full-secure-pass")
        user = notes_db.get_user_by_email("full@home.local")
        notes_db.update_user_storage_quota(int(user["id"]), 64)
        csrf = self._csrf()
        big = "x" * 128
        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "q-1",
                    "content_version": 1,
                    "ciphertext": big,
                    "content_hash": "q-hash",
                    "deleted": False,
                    "updated_at": 1.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(push.status_code, 413)
        body = push.get_json()
        self.assertEqual(body["error"], "storage quota exceeded")
        self.assertEqual(body["quota_bytes"], 64)
        self.assertEqual(body["results"][0]["status"], "quota_exceeded")

    def test_admin_overview_and_update_quota(self):
        import db as notes_db
        from passwords import new_kdf_salt

        member_salt, member_ver = self._srp_verifier("member@home.local", "member-secure-pass")
        notes_db.create_user_srp("member@home.local", new_kdf_salt(), member_salt, member_ver)
        self._register_user("admin@home.local", "admin-secure-pass")
        admin = notes_db.get_user_by_email("admin@home.local")
        member = notes_db.get_user_by_email("member@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        self.assertIsNotNone(admin)
        self.assertIsNotNone(member)
        csrf = self._csrf()
        overview = self.client.get("/api/admin/overview", headers={"X-CSRF-Token": csrf})
        self.assertEqual(overview.status_code, 200)
        data = overview.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["user_count"], 2)
        emails = {u["email"] for u in data["users"]}
        self.assertEqual(emails, {"admin@home.local", "member@home.local"})
        self.assertIn("server", data)
        self.assertGreater(data["server"]["disk_total_bytes"], 0)
        self.assertIn("db_bytes", data["server"])
        self.assertIn("ops", data)
        self.assertIn("registration_open", data["ops"])
        patch = self.client.patch(
            f"/api/admin/users/{int(member['id'])}",
            headers={"X-CSRF-Token": csrf},
            json={"storage_quota_mb": 50},
        )
        self.assertEqual(patch.status_code, 200)
        updated = patch.get_json()["user"]
        self.assertEqual(updated["storage_quota_bytes"], 50 * 1024 * 1024)

    def test_admin_overview_forbidden_for_non_admin(self):
        self._register_user("plain@home.local", "plain-secure-pass")
        res = self.client.get("/api/admin/overview", headers={"X-CSRF-Token": self._csrf()})
        self.assertEqual(res.status_code, 403)

    def test_legal_pages_are_public(self):
        privacy = self.client.get("/privacy")
        terms = self.client.get("/terms")
        self.assertEqual(privacy.status_code, 200)
        self.assertEqual(terms.status_code, 200)
        self.assertIn("beta", privacy.get_data(as_text=True).lower())
        self.assertIn("beta", terms.get_data(as_text=True).lower())
        self.assertIn("zero-knowledge", privacy.get_data(as_text=True).lower())
        self.assertIn("zero-knowledge", terms.get_data(as_text=True).lower())

    def test_sync_push_quota_batch_is_atomic(self):
        import db as notes_db

        self._register_user("batch@home.local", "batch-secure-pass")
        user = notes_db.get_user_by_email("batch@home.local")
        notes_db.update_user_storage_quota(int(user["id"]), 128)
        csrf = self._csrf()
        seed = self.client.post(
            "/api/sync/items",
            json={
                "items": [{
                    "item_uuid": "b-seed",
                    "content_version": 1,
                    "ciphertext": "x" * 32,
                    "content_hash": "b-seed-hash",
                    "deleted": False,
                    "updated_at": 1.0,
                }]
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(seed.status_code, 200)
        push = self.client.post(
            "/api/sync/items",
            json={
                "items": [
                    {
                        "item_uuid": "b-seed",
                        "content_version": 2,
                        "ciphertext": "y" * 48,
                        "content_hash": "b-seed-hash-2",
                        "deleted": False,
                        "updated_at": 2.0,
                    },
                    {
                        "item_uuid": "b-big",
                        "content_version": 1,
                        "ciphertext": "z" * 200,
                        "content_hash": "b-big-hash",
                        "deleted": False,
                        "updated_at": 2.0,
                    },
                ]
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(push.status_code, 413)
        row = notes_db.connection().execute(
            "SELECT LENGTH(ciphertext) AS n FROM items WHERE user_id = ? AND item_uuid = ?",
            (int(user["id"]), "b-seed"),
        ).fetchone()
        self.assertEqual(int(row["n"]), 32)

    def test_admin_delete_user(self):
        import db as notes_db
        from passwords import new_kdf_salt

        member_salt, member_ver = self._srp_verifier("gone@home.local", "gone-secure-pass")
        member_id = notes_db.create_user_srp("gone@home.local", new_kdf_salt(), member_salt, member_ver)
        notes_db.upsert_item(int(member_id), "del-1", "cipher", 1, "h1", False, 1.0)
        self._register_user("admin@home.local", "admin-secure-pass")
        admin = notes_db.get_user_by_email("admin@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        csrf = self._csrf()
        deleted = self.client.delete(
            f"/api/admin/users/{int(member_id)}",
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertIsNone(notes_db.get_user_by_email("gone@home.local"))

    def test_admin_patch_requires_csrf(self):
        import db as notes_db
        from passwords import new_kdf_salt

        member_salt, member_ver = self._srp_verifier("csrf@home.local", "csrf-secure-pass")
        notes_db.create_user_srp("csrf@home.local", new_kdf_salt(), member_salt, member_ver)
        self._register_user("admin@home.local", "admin-secure-pass")
        admin = notes_db.get_user_by_email("admin@home.local")
        member = notes_db.get_user_by_email("csrf@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        res = self.client.patch(
            f"/api/admin/users/{int(member['id'])}",
            json={"storage_quota_mb": 25},
        )
        self.assertEqual(res.status_code, 400)

    def test_admin_page_forbidden_for_non_admin(self):
        self._register_user("plain@home.local", "plain-secure-pass")
        res = self.client.get("/admin")
        self.assertEqual(res.status_code, 403)

    def test_deleted_user_session_is_cleared(self):
        import db as notes_db
        from passwords import new_kdf_salt

        member_salt, member_ver = self._srp_verifier("zombie@home.local", "zombie-secure-pass")
        member_id = notes_db.create_user_srp("zombie@home.local", new_kdf_salt(), member_salt, member_ver)
        self._register_user("admin@home.local", "admin-secure-pass")
        admin = notes_db.get_user_by_email("admin@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        csrf = self._csrf()
        self.client.delete(
            f"/api/admin/users/{int(member_id)}",
            headers={"X-CSRF-Token": csrf},
        )
        with self.client.session_transaction() as sess:
            sess["uid"] = int(member_id)
            sess["authed"] = True
            sess["exp"] = time.time() + 3600
            sess["totp_ok"] = True
        account = self.client.get("/api/account")
        self.assertEqual(account.status_code, 401)

    def test_srp_register_rejects_html_in_email(self):
        res = self._register_user('"><img@x.y', "html-secure-pass")
        self.assertEqual(res.status_code, 400)

    def test_env_admin_cannot_be_demoted_via_api(self):
        import db as notes_db

        os.environ["NOTES_ADMIN_EMAILS"] = "envadmin@home.local"
        self._register_user("envadmin@home.local", "envadmin-secure-pass")
        admin = notes_db.get_user_by_email("envadmin@home.local")
        notes_db.update_user_admin_flag(int(admin["id"]), True)
        csrf = self._csrf()
        patch = self.client.patch(
            f"/api/admin/users/{int(admin['id'])}",
            headers={"X-CSRF-Token": csrf},
            json={"is_admin": False},
        )
        self.assertEqual(patch.status_code, 400)
        overview = self.client.get("/api/admin/overview", headers={"X-CSRF-Token": csrf})
        user = next(u for u in overview.get_json()["users"] if u["email"] == "envadmin@home.local")
        self.assertTrue(user["is_admin"])
        self.assertTrue(user["admin_env_locked"])

    def test_sidebar_sync_and_stats_layout(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")

        self.assertIn('id="vault-stats"', html)
        self.assertIn('id="btn-sync-now"', html)
        self.assertIn('.sync-progress', css)
        self.assertIn('position: absolute;', css)
        self.assertIn('btn-sync-now[data-state="syncing"]', css)
        self.assertIn('btn-sync-now[data-state="ok"]', css)
        self.assertIn('.vault-stats', css)
        self.assertIn('white-space: normal;', css)
        self.assertIn('syncBtn.dataset.state = phase;', app_js)
        self.assertIn('el.title = statsText;', app_js)

    def test_tablet_desktop_tabs_safe_area_and_sidebar_foot_sync(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        desktop = css.split("@media (min-width: 861px)")[-1]
        tabs_block = desktop[desktop.index("  .app-tabs {") : desktop.index("  .app-tab {", desktop.index("  .app-tabs {"))]
        self.assertIn("padding-top: calc(6px + var(--safe-top))", tabs_block)
        self.assertIn("padding-left: calc(12px + var(--safe-left))", tabs_block)
        foot_block = desktop[desktop.index("  .sidebar-foot {") : desktop.index("  .sidebar-foot-actions {")]
        self.assertIn("flex-direction: column", foot_block)
        self.assertIn("padding-bottom: calc(8px + var(--safe-bottom))", foot_block)
        sync_btn = desktop[desktop.index("  .sidebar-foot .btn-sync-now {") : desktop.index("  .sidebar-foot .btn-sync-now:hover")]
        self.assertIn("max-width: none", sync_btn)
        self.assertIn("width: 100%", sync_btn)
        self.assertIn("overflow-wrap: anywhere", css)

    def test_protected_note_cannot_be_deleted(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        search_js = (APP_DIR / "static" / "js" / "search.js").read_text(encoding="utf-8")

        self.assertIn("function isNoteProtected(note)", app_js)
        self.assertIn("toast('This note is protected', true)", app_js)
        self.assertIn("noteIsProtected", search_js)

        trash_fn = app_js[app_js.find("function trashNote(id)"):app_js.find("function restoreNote(id)")]
        self.assertIn("isNoteProtected(note)", trash_fn)
        self.assertIn("toast('This note is protected', true)", trash_fn)

        del_list_fn = app_js[app_js.find("function deleteFromList(id)"):app_js.find("function bindNoteList()")]
        self.assertIn("isNoteProtected(note)", del_list_fn)
        self.assertIn("toast('This note is protected', true)", del_list_fn)

        del_forever_fn = app_js[app_js.find("async function deleteNoteForever(id)"):app_js.find("function deleteFromList(id)")]
        self.assertIn("isNoteProtected(note)", del_forever_fn)
        self.assertIn("toast('This note is protected', true)", del_forever_fn)

        self.assertIn("item.content.locked || item.content.prevent_edit", store_js)
        self.assertIn("protected note was trashed", app_js)

    def test_cross_device_protected_notes(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        search_js = (APP_DIR / "static" / "js" / "search.js").read_text(encoding="utf-8")
        app_css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")

        # 1. CSS styling for lock badge and protected note preview
        self.assertIn(".note-lock-badge", app_css)
        self.assertIn(".note-preview-locked", app_css)

        # 2. Equality check includes locked state so sync triggers
        self.assertIn("!!prev.locked === !!next.locked", search_js)

        # 3. Crypto key verification extracts raw key bytes correctly
        self.assertIn("extractBytes", store_js)
        self.assertIn("k.raw instanceof Uint8Array", store_js)

        # 4. List rows mask protected note snippets
        self.assertIn("Protected note", app_js)
        self.assertIn("note-lock-badge", app_js)
        self.assertIn("note-item-lock-row", app_js)
        self.assertIn(".note-item-lock-row", app_css)

        # 5. Editor chrome hides actions when gated
        self.assertIn("if (actions) actions.hidden = !!gated;", app_js)
        self.assertIn("ui.body.value = '';", app_js)
        self.assertIn("closeNoteOptions();", app_js)

        # 6. Re-locking when closing note
        self.assertIn("unlockedNotes.delete(closingId);", app_js)

        # 7. Dynamic sync gating for open note after remote protection changes
        self.assertIn("if (currentId === uuid)", app_js)

        # 8. Protection toggle & options sheet require unlock
        self.assertIn("Unlock this protected note first", app_js)

        # 9. Cross-device lock merges even when local copy is newer/dirty
        self.assertIn("function mergeCrossDeviceProtection", store_js)
        self.assertIn("mergeCrossDeviceProtection(local.content, remote.content)", store_js)
        self.assertNotIn("if (state.dirty.has(row.item_uuid)) {\n        watermark", store_js)

        # 10. Notes list re-renders when only protection flags change
        self.assertIn("${n.content.locked ? 1 : 0}:${n.content.prevent_edit ? 1 : 0}", app_js)
        self.assertIn("if (!uuid || vaultPullActive || !meta?.protectionMerged) return;", app_js)
        self.assertIn("if (note.content?.locked) unlockedNotes.delete(uuid);", app_js)
        self.assertIn("function syncVaultLockUi", app_js)
        self.assertIn("syncVaultLockUi(true)", app_js)
        self.assertIn("sync-empty-refill", store_js)
        self.assertIn("missingTotpAfterSync", store_js)
        self.assertIn("countTotpItems", store_js)
        self.assertIn("ensureTotpAccountsFromServer", app_js)
        self.assertIn("if (remoteContent.locked && !merged.locked)", store_js)
        self.assertIn("if (remoteContent.prevent_edit && !merged.prevent_edit)", store_js)

    def test_checklist_entry_note_type_menu_and_collapsed_tags(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")

        checklist_fn = app_js[
            app_js.find("function renderChecklist(note)"):
            app_js.find("function writeChecklist(")
        ]
        self.assertIn("const addItem = (afterId", checklist_fn)
        self.assertIn("commit(next, { keepFocus: added?.id, focusIndex: insertIndex });", checklist_fn)
        self.assertIn("addItem(input.dataset.checkText", checklist_fn)
        self.assertIn("addItem(rows[rows.length - 1]?.id);", checklist_fn)
        self.assertIn("syncClearCheckedButton(note)", checklist_fn)
        self.assertIn('id="btn-clear-checked"', html)
        self.assertIn("btn-clear-checked", app_js)
        self.assertIn("NotesChecklist.removeDone(rows)", app_js)

        write_fn = app_js[
            app_js.find("function writeChecklist("):
            app_js.find("function setEditorChrome(")
        ]
        self.assertIn("focusIndex", write_fn)
        self.assertIn("target.focus();", write_fn)

        self.assertEqual(html.count('id="note-editor-type"'), 1)
        self.assertNotIn('id="note-info-editor-type"', html)
        editor_header = html[
            html.find('<header class="editor-head">'):
            html.find('<div id="tag-suggest"')
        ]
        self.assertIn('id="note-editor-type"', editor_header)
        # Positioned right next to More button
        self.assertIn(
            '<select id="note-editor-type"',
            editor_header,
        )
        self.assertIn(
            '<button type="button" id="btn-note-info"',
            editor_header,
        )

        default_tags_fn = app_js[
            app_js.find("function defaultTagBarExpanded()"):
            app_js.find("function defaultTagBarShowAll()")
        ]
        self.assertIn("return false;", default_tags_fn)
        open_note_fn = app_js[
            app_js.find("function openNote(id, { skipGate = false, skipFlush = false } = {})"):
            app_js.find("function updateActionButtons(note)")
        ]
        self.assertIn("if (tagBarNoteId !== id || !alreadyEditing)", open_note_fn)
        self.assertIn("tagBarExpanded = defaultTagBarExpanded();", open_note_fn)

        # Clear indication in notes list and More menu
        self.assertIn("note-lock-badge-vault", app_js)
        self.assertIn('note-lock-text">Protected<', app_js)
        self.assertIn('id="note-info-locked"', html)
        self.assertIn("Password locked", app_js)
        self.assertIn("note-info-protect-btn", html)

    def test_sign_out_warns_and_clears_device_data(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        store_js = (APP_DIR / "static" / "js" / "store.js").read_text(encoding="utf-8")
        idb_js = (APP_DIR / "static" / "js" / "idb.js").read_text(encoding="utf-8")

        self.assertIn("SIGN_OUT_WARNING", app_js)
        self.assertIn("encrypted data stays on the DeeperGuard server", app_js)
        self.assertIn("async function requestSignOut()", app_js)
        self.assertIn("await NotesStore.clearDeviceData()", app_js)
        logout_handler = app_js[
            app_js.find("document.getElementById('btn-logout')?.addEventListener"):
            app_js.find("document.getElementById('btn-setup-totp').addEventListener")
        ]
        self.assertIn("requestSignOut()", logout_handler)
        unlock_handler = app_js[
            app_js.find("document.getElementById('unlock-signout')"):
            app_js.find("document.getElementById('unlock-clear-saved')")
        ]
        self.assertIn("requestSignOut()", unlock_handler)

        sign_out_fn = app_js[
            app_js.find("async function signOutCompletely()"):
            app_js.find("async function requestSignOut()")
        ]
        self.assertNotIn("NotesIDB.putMeta('lastSync', 0)", sign_out_fn)

        self.assertIn("async function clearDeviceData()", store_js)
        self.assertIn("NotesIDB.clearAll", store_js)
        self.assertIn("async function clearAll()", idb_js)
        self.assertIn("async function wipeAfterRemoteSignOut()", app_js)
        self.assertIn("session_revoked", app_js)
        self.assertIn("delete its local vault copy", app_js)
        self.assertIn("startRemoteRevokeWatch()", app_js)
        self.assertIn("setSessionRevokedHandler", store_js)
        self.assertIn("err.code = data.code", store_js)

    def test_expired_account_session_prompts_sign_in_without_clearing_notes(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")

        alert_fn = app_js[
            app_js.find("function showSessionExpiredAlert()"):
            app_js.find("async function ensureServerSession(options = {})")
        ]
        self.assertIn("Your encrypted notes are safe", alert_fn)
        self.assertIn("synchronization is paused", alert_fn)
        self.assertIn("title: 'Sign in required'", alert_fn)
        self.assertIn("confirmLabel: 'Sign in'", alert_fn)
        self.assertIn("location.assign('/login?reason=session-expired')", alert_fn)
        self.assertNotIn("signOutCompletely", alert_fn)
        self.assertNotIn("NotesIDB", alert_fn)

        session_fn = app_js[
            app_js.find("async function ensureServerSession(options = {})"):
            app_js.find("window.notesEnsureServerSession")
        ]
        self.assertIn("[401, 403, 404].includes(err.status)", session_fn)
        self.assertIn("NotesStore.setCsrf('')", session_fn)
        self.assertIn("NotesStore.emitSync('pending', 'Sign in to sync')", session_fn)
        self.assertIn("showSessionExpiredAlert();", session_fn)
        self.assertIn("isSessionRevokedError(err)", session_fn)
        self.assertIn("wipeAfterRemoteSignOut()", session_fn)
        self.assertNotIn("signOutCompletely", session_fn)

        finish_fn = app_js[
            app_js.find("async function finishUnlocked"):
            app_js.find("function unlockErrorShouldRelock")
        ]
        self.assertIn("ensureServerSession({ prompt: false })", finish_fn)
        self.assertIn("establishServerSessionAfterVaultUnlock", app_js)

        locked_sync_fn = app_js[
            app_js.find("async function handleLockedManualSync()"):
            app_js.find("function syncNow(")
        ]
        self.assertIn("NotesStore.api('/api/account'", locked_sync_fn)
        self.assertIn("[401, 403, 404].includes(err.status)", locked_sync_fn)
        self.assertIn("promptVaultUnlock(", locked_sync_fn)
        self.assertIn("session expired", locked_sync_fn.lower())
        self.assertIn("wipeAfterRemoteSignOut()", locked_sync_fn)
        self.assertNotIn("showSessionExpiredAlert();", locked_sync_fn)
        self.assertIn("isUnlockScreenVisible()", alert_fn)
        self.assertIn("unlock-session-hint", (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8"))

        locked_bg_fn = app_js[
            app_js.find("async function syncWhileVaultLocked("):
            app_js.find("function runBackgroundSync()")
        ]
        self.assertIn("ensureServerSession({ prompt: false })", locked_bg_fn)

        ensure_unlock_fn = app_js[
            app_js.find("async function ensureUnlocked()"):
            app_js.find("async function boot()")
        ]
        self.assertIn("ensureServerSession({ prompt: false })", ensure_unlock_fn)

        sync_fn = app_js[
            app_js.find("function syncNow("):
            app_js.find("function requestManualSync(")
        ]
        self.assertIn("if (!quiet) return handleLockedManualSync();", sync_fn)
        self.assertIn("syncWhileVaultLocked({ quiet: true, force })", sync_fn)
        self.assertIn("function runBackgroundSync()", app_js)

        empty_sync_start = app_js.find(
            "document.getElementById('btn-empty-sync')?.addEventListener('click'"
        )
        self.assertGreaterEqual(empty_sync_start, 0)
        empty_sync_fn = app_js[empty_sync_start:empty_sync_start + 800]
        self.assertIn("syncNow({ full: true })", empty_sync_fn)
        self.assertNotIn("toast('Unlock the vault first'", empty_sync_fn)

    def _csrf(self):
        with self.client.session_transaction() as sess:
            return sess.get("csrf", "")

    def _ocr_post(self, **kwargs):
        res = self.client.post("/api/ocr", **kwargs)
        if res.status_code != 202:
            return res
        job_id = res.get_json().get("job_id")
        self.assertTrue(job_id)
        for _ in range(100):
            poll = self.client.get(f"/api/ocr/jobs/{job_id}", headers=kwargs.get("headers"))
            if poll.status_code in (200, 400):
                return poll
            self.assertEqual(poll.status_code, 202)
            time.sleep(0.05)
        self.fail("OCR job did not finish in time")

    def test_locked_note_content_is_gated(self):
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        search_js = (APP_DIR / "static" / "js" / "search.js").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")

        self.assertIn("function noteLockBadgeHtml(note)", app_js)
        self.assertIn("Protected note", app_js)
        self.assertIn("Protected document", app_js)
        self.assertIn("Unlock this protected note first", app_js)
        self.assertIn(".note-lock-badge", css)
        self.assertIn(".note-preview-locked", css)
        preview_link = css[css.find(".preview a {"):css.find(".preview a {") + 420]
        self.assertIn("box-decoration-break: clone", preview_link)
        self.assertIn("background-size: 100% 1.5px", preview_link)
        history_css = css[css.find(".history {"):css.find(".history {") + 280]
        self.assertIn("max-height: min(32vh, 15rem)", history_css)
        self.assertIn("overflow-y: auto", css[css.find(".history-list {"):css.find(".history-list {") + 220])
        self.assertNotIn("z-index: 2", css[css.find("A read-only preview stays as tall"):css.find("A read-only preview stays as tall") + 1200])

        open_fn = app_js[app_js.find("function openNote(id, { skipGate = false, skipFlush = false } = {})"):app_js.find("function updateActionButtons(note)")]
        self.assertIn("listSelectionId = id", open_fn)
        self.assertLess(open_fn.find("markActiveNoteRow()"), open_fn.find("classList.add('editor-open')"))
        self.assertIn("ui.body.value = gated ? '' : body", open_fn)
        self.assertIn("if (!gated && NotesStore.lightVaultEnabled", open_fn)
        self.assertIn("if (!gated) pullNoteOcrFromServer(id)", open_fn)
        self.assertIn("if (!gated && (note.content.editor || '') === 'superscript'", open_fn)

        flush_fn = app_js[app_js.find("function flushSave()"):app_js.find("function scheduleSave()")]
        self.assertIn("if (note.content?.locked && !unlockedNotes.has(currentId)) return;", flush_fn)

        close_fn = app_js[app_js.find("function closeEditor({ fromPopstate = false } = {})"):app_js.find("window.addEventListener('popstate'")]
        flush_at = close_fn.find("flushSave()")
        forget_at = close_fn.find("unlockedNotes.delete(closingId)")
        self.assertGreaterEqual(flush_at, 0)
        self.assertGreater(forget_at, flush_at)
        self.assertNotIn("listSelectionId = null", close_fn)
        self.assertIn("function activeListNoteId()", app_js)

        chrome_fn = app_js[app_js.find("function setEditorChrome(gated)"):app_js.find("function highlightPreview()")]
        self.assertIn("ui.body.value = ''", chrome_fn)
        self.assertIn("ui.attachmentList.innerHTML = ''", chrome_fn)

        self.assertIn("if (note.content.locked) return normalize(note.content.title || '')", search_js)
        self.assertIn("if (titlesOnly || note.content?.locked) return null;", search_js)
        self.assertTrue(
            ("if (note.content?.locked) {\n      return !!describeMatch(note, query, tagMap, { titlesOnly: true });" in search_js)
            or ("if (note.content?.locked) {\n      return matchesNoteOrFileName(note, query, { includeFileNames: false });" in search_js)
        )

        deferred_fn = app_js[app_js.find("function runDeferredOpenNoteHeavyWork()"):app_js.find("function updateVaultPullHead()")]
        self.assertIn("if (note?.content?.locked && !unlockedNotes.has(id)) return;", deferred_fn)
        info_fn = app_js[app_js.find("function updateNoteInfoPanel(note)"):app_js.find("function renderVaultStats()")]
        if "function updateNoteInfoPanel(note)" in app_js:
            start = app_js.find("function updateNoteInfoPanel(note)")
            self.assertIn("if (note.content?.locked && !unlockedNotes.has(note.uuid)) return;", app_js[start:start + 800])

    def test_share_option_present_and_ocr_search_popup_disabled(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")

        # Share button is present in the editor toolbar and note info sheet
        self.assertIn('id="btn-share"', html)
        self.assertIn('aria-label="Copy note"', html)
        self.assertIn('id="note-info-share"', html)
        self.assertIn(">Copy<", html)
        self.assertIn(">Download<", html)
        self.assertIn("Sharing unavailable", app_js)
        self.assertNotIn("The file was downloaded instead", app_js)
        self.assertIn("function resetNoteTransientChrome(", app_js)
        self.assertIn("docShare.hidden = !noteShare", app_js)
        self.assertIn("<textarea class=\"check-text\"", app_js)
        self.assertIn("touchUpdatedAt: false", app_js[app_js.find("function togglePreventEdit"):app_js.find("function togglePreventEdit") + 900])
        self.assertIn('id="doc-immersive-share"', html)
        self.assertIn('function shareNote(', app_js)
        self.assertIn('document.getElementById(\'btn-share\')', app_js)
        self.assertIn('document.getElementById(\'note-info-share\')', app_js)

        # OCR popup "Document is searchable" is disabled after upload/indexing
        run_ocr_fn = app_js[app_js.find("async function runOcrQueue()"):app_js.find("function canOcrAttachment(")]
        self.assertNotIn("offerDocumentSearch(", run_ocr_fn, "OCR queue should not offer search prompt after finishing OCR")

    def test_doc_immersive_toolbar_respects_safe_area(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn(
            "body.doc-preview-open.doc-immersive.doc-chrome-reveal .doc-viewer,\n"
            "body.doc-preview-open.doc-immersive .doc-viewer:has(.doc-enhance-panel:not([hidden]))",
            css,
        )
        self.assertIn("padding-top: var(--safe-top);", css[css.find("doc-chrome-reveal .doc-viewer"):css.find("doc-chrome-reveal .doc-viewer") + 400])
        self.assertIn(
            "body.doc-preview-open.doc-immersive.doc-chrome-reveal .doc-stage,\n"
            "  body.doc-preview-open.doc-immersive .doc-viewer:has(.doc-enhance-panel:not([hidden])) .doc-stage",
            mobile,
        )
        self.assertIn("padding-top: calc(52px + var(--safe-top));", mobile)

    def test_mobile_open_note_progressive_toolbar(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn('id="editor-actions-overflow-panel"', html)
        self.assertIn('class="editor-actions-mobile-bar"', html)
        self.assertIn('class="editor-actions-overflow-panel editor-phone-toolbar"', html)
        self.assertIn('id="btn-note-type-menu"', html)
        self.assertIn('id="note-type-menu"', html)
        self.assertNotIn('id="btn-editor-overflow"', html)
        self.assertIn('id="btn-clear-checked-list"', js)
        self.assertIn('function syncEditorMobileProxies()', js)
        self.assertIn('function syncNoteTypeMenuSelection()', js)
        self.assertIn('function setNoteTypeMenuOpen(', js)
        self.assertIn(".editor-actions-overflow-panel {", mobile)
        self.assertIn("display: flex !important", mobile)
        self.assertIn(".editor-actions-overflow-panel [hidden]", mobile)
        self.assertIn(".editor-phone-toolbar-hide", mobile)
        self.assertNotIn(
            "editor-phone-toolbar-hide",
            html[html.find('id="btn-mobile-doc-attachment-share"') - 80:html.find('id="btn-mobile-doc-attachment-share"') + 120],
        )
        self.assertIn(".note-type-menu", mobile)
        self.assertIn('id="btn-mobile-doc-fullscreen"', html)
        self.assertIn("#btn-clear-checked {", mobile)
        self.assertIn('id="btn-editor-overflow-mobile"', html)
        mobile_bar = html[
            html.find('class="editor-actions-mobile-bar"'):
            html.find('id="btn-editor-overflow-mobile"') + 80
        ]
        self.assertIn('data-editor-proxy="btn-pin"', mobile_bar)
        self.assertIn('id="btn-mobile-doc-fullscreen"', mobile_bar)

    def test_mobile_doc_inline_preview_layout(self):
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        mobile = css.split("@media (max-width: 860px)")[1].split("@media (min-width: 861px)")[0]
        self.assertIn(".doc-inline-tools {\n  display: none !important;\n}", css)
        self.assertIn(".doc-inline-tools {\n    display: none !important;\n  }", mobile)
        self.assertIn("min-height: min(52vh, 50dvh);", mobile)
        self.assertIn("overflow-y: auto;", mobile[mobile.find(".editor.doc-preview-active .editor-scroll"):mobile.find(".editor.doc-preview-active .editor-scroll") + 280])
        self.assertIn("body.editor-mobile-doc-preview", mobile)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", mobile)
        inline_fn = js[js.find("function renderDocInline("):js.find("function scheduleSearchHitRepaint(")]
        self.assertNotIn("doc-inline-tools", inline_fn)
        self.assertNotIn("doc-inline-share", inline_fn)
        render_att = js[js.find("function renderAttachments("):js.find("function attachmentOcrStatus(")]
        self.assertIn("hideAttShare", render_att)
        self.assertIn("mobileDocToolbarActive()", render_att)
        self.assertIn("function markDocStagePainted(", js)
        self.assertIn("editor-mobile-doc-preview", js)
        self.assertIn('id="btn-mobile-doc-fullscreen"', html[html.find('class="editor-actions-mobile-bar"'):html.find('</div>\n            <div id="editor-actions-overflow-panel"')])

    def test_desktop_doc_note_toolbar_single_row(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")
        js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        primary_actions = html[
            html.find('<div class="editor-actions-group editor-actions-primary">'):
            html.find('</div>\n            <span class="editor-tools-divider toolbar-secondary editor-toolbar-menu-item"')
        ]
        self.assertIn('id="btn-prevent-edit"', primary_actions)
        self.assertIn('id="btn-find-desktop"', primary_actions)
        self.assertIn('id="btn-ai-chat"', primary_actions)
        self.assertIn('id="btn-editor-overflow-desktop"', primary_actions)
        self.assertNotIn('id="btn-share"', primary_actions)
        menu_panel = html[html.find('editor-toolbar-menu-panel'):html.find('id="btn-editor-settings"')]
        self.assertIn('id="btn-share"', menu_panel)
        self.assertIn('id="btn-trash"', menu_panel)
        self.assertEqual(menu_panel.count('id="btn-trash"'), 1)
        self.assertIn('id="btn-desktop-doc-fullscreen"', html)
        self.assertIn("@media (min-width: 861px)", css)
        self.assertIn(".btn.icon.find-btn {", css)
        self.assertRegex(css, r"@media \(min-width: 861px\)[\s\S]*\.doc-inline-tools \{\s*display: none !important;")
        self.assertIn("function inlineDocPreviewAttId()", js)
        self.assertIn("function setEditorToolbarMenuOpen(", js)
        inline_fn = js[js.find("function renderDocInline("):js.find("function scheduleSearchHitRepaint(")]
        self.assertNotIn("doc-inline-tools", inline_fn)
        self.assertIn("doc-inline-main-scroll", inline_fn)
        self.assertNotIn('<button type="button" class="doc-inline-main"', inline_fn)
        hydrate_inline = js[js.find("async function hydrateInlineDoc("):js.find("let inlineDocLayoutWatch")]
        self.assertIn("await waitForStageLayout(stage)", hydrate_inline)

    def test_note_type_next_to_more_checklist_and_protection_symbols(self):
        html = (APP_DIR / "templates" / "app.html").read_text(encoding="utf-8")
        app_js = (APP_DIR / "static" / "js" / "app.js").read_text(encoding="utf-8")
        css = (APP_DIR / "static" / "css" / "app.css").read_text(encoding="utf-8")

        # 1. Note type in primary toolbar; note info lives in overflow menu
        primary_actions = html[
            html.find('<div class="editor-actions-group editor-actions-primary">'):
            html.find('</div>\n            <span class="editor-tools-divider toolbar-secondary editor-toolbar-menu-item"')
        ]
        type_pos = primary_actions.find('id="note-editor-type"')
        ai_pos = primary_actions.find('id="btn-ai-chat"')
        self.assertGreaterEqual(type_pos, 0)
        self.assertGreaterEqual(ai_pos, 0)
        self.assertLess(type_pos, ai_pos)
        menu_panel = html[html.find('editor-toolbar-menu-panel'):html.find('id="btn-editor-settings"')]
        self.assertIn('id="btn-note-info"', menu_panel)
        self.assertIn("toolbar-primary", primary_actions[type_pos:type_pos + 60])
        self.assertIn(".editor-actions .toolbar-primary.editor-select", css)

        # 2. Checklist Enter creates new item and focuses cursor into new input
        checklist_fn = app_js[
            app_js.find("function renderChecklist(note)"):
            app_js.find("function writeChecklist(")
        ]
        self.assertIn("addItem(input.dataset.checkText", checklist_fn)
        self.assertIn("target.focus();", app_js)
        self.assertIn("target.setSelectionRange(0, 0);", app_js)

        # 3. Clearly show in notes list if note is protected
        self.assertIn(".note-lock-badge.note-lock-badge-vault", css)
        self.assertIn(".note-row.is-protected", css)
        self.assertIn('note-lock-text">Protected<', app_js)
        self.assertIn('preview-lock-glyph', app_js)
        self.assertIn('Protected note', app_js)

        # 4. Clear symbol in note and More menu for locked vs unlocked
        self.assertIn('edit-lock-open', html)
        self.assertIn('edit-lock-closed', html)
        self.assertIn('id="note-info-locked"', html)
        self.assertIn('Password locked', app_js)
        self.assertIn('.note-info-protect-btn', css)
        self.assertIn('.note-info-status.is-locked', css)
        self.assertIn('.note-info-status.is-unlocked', css)


    def test_request_is_same_origin(self):
        import auth
        # Same-origin via Sec-Fetch-Site
        with self.app_mod.app.test_request_context("/", headers={"Sec-Fetch-Site": "same-origin"}):
            self.assertTrue(auth.request_is_same_origin())

        # Cross-site via Sec-Fetch-Site
        with self.app_mod.app.test_request_context("/", headers={"Sec-Fetch-Site": "cross-site"}):
            self.assertFalse(auth.request_is_same_origin())

        # Origin header matching request host
        with self.app_mod.app.test_request_context("/", headers={"Host": "notes.deeperguard.com", "Origin": "https://notes.deeperguard.com"}):
            self.assertTrue(auth.request_is_same_origin())

        # www and apex of the public host are the same site
        with self.app_mod.app.test_request_context("/", headers={"Host": "www.deeperguard.com", "Origin": "https://deeperguard.com"}):
            self.assertTrue(auth.request_is_same_origin())

        # Sibling subdomains (pool, arbitrary CF host) are not the notes origin
        with self.app_mod.app.test_request_context("/", headers={"Host": "www.deeperguard.com", "Origin": "https://notes.deeperguard.com"}):
            self.assertFalse(auth.request_is_same_origin())
        with self.app_mod.app.test_request_context("/", headers={"Host": "www.deeperguard.com", "Origin": "https://pool.deeperguard.com"}):
            self.assertFalse(auth.request_is_same_origin())

        # Malicious cross-origin
        with self.app_mod.app.test_request_context("/", headers={"Host": "notes.deeperguard.com", "Origin": "https://evil.com"}):
            self.assertFalse(auth.request_is_same_origin())

        # Null origin (sandboxed iframe / data: URI)
        with self.app_mod.app.test_request_context("/", headers={"Host": "notes.deeperguard.com", "Origin": "null"}):
            self.assertFalse(auth.request_is_same_origin())

    def test_slide_session_renews_active_session(self):
        import auth
        from config import SESSION_SECONDS
        with self.app_mod.app.test_request_context("/"):
            from flask import session
            session[auth.SESSION_AUTH] = True
            session[auth.SESSION_USER] = 1
            session[auth.SESSION_EXP] = time.time() + (SESSION_SECONDS - 7200)  # 2 hours old
            auth.slide_session()
            exp = float(session.get(auth.SESSION_EXP) or 0)
            self.assertGreater(exp, time.time() + SESSION_SECONDS - 10)
            self.assertTrue(session.permanent)

    def test_register_sets_persistent_session_cookie(self):
        res = self._register_user("persist-cookie@home.local", "persist-cookie-pass")
        self.assertEqual(res.status_code, 200)
        cookie = res.headers.get("Set-Cookie") or ""
        self.assertTrue("Expires=" in cookie or "Max-Age=" in cookie, cookie)

    def test_ensure_flask_secret_persists_new_key(self):
        import importlib

        root = Path(self.tmp.name) / "secret-gen"
        keys = root / "keys"
        keys.mkdir(parents=True)
        os.environ["NOTES_KEYS"] = str(keys)
        os.environ["NOTES_DATA"] = str(root / "data")
        for name in list(sys.modules):
            if name in {"app", "config"} or name.startswith("app."):
                sys.modules.pop(name, None)
        cfg = importlib.import_module("config")
        secret = cfg.ensure_flask_secret()
        self.assertTrue(len(secret) >= 32)
        self.assertTrue(cfg.flask_secret_path().is_file())
        self.assertEqual(cfg.read_secret(cfg.flask_secret_path()), secret)

    def test_authenticated_root_still_serves_marketing(self):
        import auth
        with self.client.session_transaction() as sess:
            sess[auth.SESSION_AUTH] = True
            sess[auth.SESSION_USER] = 1
            sess[auth.SESSION_EXP] = time.time() + 3600
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"marketing.css", res.data)
        self.assertIn(b"Sign in", res.data)
        self.assertIn(b'href="https://www.deeperguard.com/login"', res.data)
        self.assertIn(b'href="https://www.deeperguard.com/app"', res.data)
        self.assertNotIn(b'id="editor"', res.data)

    def test_deep_link_args_includes_root(self):
        from app import _deep_link_args
        with self.app_mod.app.test_request_context("/?note=12345678-1234-1234-1234-123456789abc"):
            self.assertEqual(_deep_link_args(), {"note": "12345678-1234-1234-1234-123456789abc"})

    def test_session_cookie_domain_configuration(self):
        from config import session_cookie_domain
        domain = session_cookie_domain()
        self.assertEqual(domain, ".deeperguard.com")

    def test_marketing_page_contains_notes_build_meta(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'<meta name="notes-build"', res.data)

    def test_app_page_contains_notes_build_meta(self):
        res = self.client.get("/app")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'<meta name="notes-build"', res.data)

    def test_https_setup_page_contains_notes_build_meta(self):
        res = self.client.get("/app", headers={"Host": "192.168.1.50"})
        self.assertEqual(res.status_code, 200)
        self.assertIn(b'<meta name="notes-build"', res.data)

    def test_root_and_app_strip_cookies_in_cacheable_shell(self):
        import auth
        self.assertTrue(auth.cacheable_shell("/"))
        self.assertTrue(auth.cacheable_shell("/app"))
        self.assertTrue(auth.cacheable_shell("/sw.js"))




if __name__ == "__main__":
    unittest.main()
