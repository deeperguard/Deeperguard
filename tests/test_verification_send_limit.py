"""Tests for verification-email rate limits and HMAC verification codes."""
import hashlib
import hmac
import importlib
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))


class VerificationSendLimitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_VERIFY_SEND_COOLDOWN"] = "60"
        os.environ["NOTES_VERIFY_SEND_DAILY_CAP"] = "5"
        os.environ["NOTES_BACKUP_EMAIL_DAILY_CAP"] = "3"
        os.environ["NOTES_ALLOWED_CIDRS"] = "130.0.0.1/32"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("unit-test-pepper", encoding="utf-8")
        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "email_verify",
                "verification_send_limit",
                "mailer",
                "auth_rate_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        import auth_rate_limit as arl

        arl._hits.clear()
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        self.db = importlib.import_module("db")
        self.email_verify = importlib.import_module("email_verify")
        self.vsl = importlib.import_module("verification_send_limit")

    def tearDown(self):
        try:
            self.db.reset_connection()
        except Exception:
            pass
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT",
            "NOTES_DATA",
            "NOTES_KEYS",
            "NOTES_VERIFY_SEND_COOLDOWN",
            "NOTES_VERIFY_SEND_DAILY_CAP",
            "NOTES_BACKUP_EMAIL_DAILY_CAP",
            "NOTES_ALLOWED_CIDRS",
        ):
            os.environ.pop(key, None)

    def _srp_verifier(self, email: str, password: str) -> tuple[str, str]:
        import hashlib

        from srp_auth import G, N

        def strip_hex(value: str) -> str:
            out = value.lower()
            while out.startswith("0"):
                out = out[1:]
            return out

        def sha_hex(text: str) -> str:
            return strip_hex(hashlib.sha256(text.encode("utf-8")).hexdigest())

        salt_hex = sha_hex(f"test-salt::{email}")
        hash1 = sha_hex(f"{email}:{password}")
        x_hash = sha_hex(f"{salt_hex}{hash1}".upper())
        x = int(x_hash, 16) % N
        return salt_hex, format(pow(G, x, N), "x")

    def _register(self, email: str, password: str = "secure-pass-12"):
        salt_hex, verifier = self._srp_verifier(email, password)
        return self.client.post(
            "/api/auth/srp/register",
            json={"email": email, "srp_salt": salt_hex, "srp_verifier": verifier},
        )

    def _csrf(self) -> str:
        with self.client.session_transaction() as sess:
            return sess.get("csrf", "")

    def test_verification_hash_uses_hmac_not_plain_sha256(self):
        user_id = 7
        code = "123456"
        recipient = "a@example.com"
        digest = self.email_verify._hash(user_id, "account", code, recipient)
        plain = hashlib.sha256(f"{user_id}:account:{code}".encode("utf-8")).hexdigest()
        self.assertNotEqual(digest, plain)
        expected = hmac.new(
            b"unit-test-pepper",
            f"{user_id}:account:{recipient}:{code}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(digest, expected)

    def test_settings_skips_resend_within_cooldown(self):
        sent = []
        with patch("mailer.send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self._register("owner@home.local")
            sent.clear()
            csrf = self._csrf()
            body = {"email": "backup@home.local", "enabled": True}
            first = self.client.post(
                "/api/backup/settings",
                json=body,
                headers={"X-CSRF-Token": csrf},
            )
            self.assertEqual(first.status_code, 200)
            self.assertEqual(len(sent), 1)
            second = self.client.post(
                "/api/backup/settings",
                json=body,
                headers={"X-CSRF-Token": csrf},
            )
            self.assertEqual(second.status_code, 200)
            self.assertEqual(len(sent), 1)

    def test_daily_cap_returns_429_on_settings(self):
        uid = None
        with patch("mailer.send_plain_email"):
            self._register("cap@home.local")
            user = self.db.get_user_by_email("cap@home.local")
            uid = int(user["id"])
            since = time.time() - 100
            for i in range(5):
                self.db.log_email_send(uid, f"target{i}@home.local", self.vsl.KIND_VERIFY)
            csrf = self._csrf()
            res = self.client.post(
                "/api/backup/settings",
                json={"email": "newtarget@home.local", "enabled": True},
                headers={"X-CSRF-Token": csrf},
            )
        self.assertEqual(res.status_code, 429)
        self.assertIn("Too many verification emails", res.get_json().get("error", ""))

    def test_backup_resend_skips_when_already_verified(self):
        sent = []
        with patch("mailer.send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            self._register("verified@home.local")
            sent.clear()
            user = self.db.get_user_by_email("verified@home.local")
            self.db.mark_email_verified(int(user["id"]))
            csrf = self._csrf()
            res = self.client.post(
                "/api/backup/email/resend",
                method="POST",
                headers={"X-CSRF-Token": csrf},
                json={},
            )
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json().get("verified"))
        self.assertEqual(sent, [])

    def test_backup_attachment_daily_cap(self):
        with patch("mailer.send_plain_email"), patch(
            "app.send_user_backup",
            return_value={"bytes_size": 1, "item_count": 0, "compact": True},
        ):
            self._register("attach@home.local")
            user = self.db.get_user_by_email("attach@home.local")
            uid = int(user["id"])
            self.db.mark_email_verified(uid)
            csrf = self._csrf()
            for _ in range(3):
                ok = self.client.post(
                    "/api/backup/email",
                    json={"email": "attach@home.local"},
                    headers={"X-CSRF-Token": csrf},
                )
                self.assertEqual(ok.status_code, 200)
            blocked = self.client.post(
                "/api/backup/email",
                json={"email": "attach@home.local"},
                headers={"X-CSRF-Token": csrf},
            )
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Too many encrypted backup emails", blocked.get_json().get("error", ""))


if __name__ == "__main__":
    unittest.main()
