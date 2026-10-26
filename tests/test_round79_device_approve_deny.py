"""Round 79: in-app Approve/Deny for new device sessions (post-sign-in)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


class ImmediateThread:
    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target = target
        self._args = args or ()
        self._kwargs = kwargs or {}

    def start(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def join(self, timeout=None):
        return None


class Round79DeviceApproveDenyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round79"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round79-secret", encoding="utf-8")

        for name in list(sys.modules):
            if name in {
                "app",
                "auth",
                "db",
                "config",
                "passwords",
                "totp",
                "srp_auth",
                "auth_rate_limit",
                "mailer",
                "signin_alert",
                "admin_notify",
                "email_verify",
                "verification_send_limit",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "deeperguard_app", APP_DIR / "app.py",
        )
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)

        import db as notes_db
        import signin_alert
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.notes_db = notes_db
        self.signin_alert = signin_alert
        salt = new_srp_salt_hex()
        self.email = "r79-devices@home.local"
        self.password = "round79-secure-pass-ok"
        verifier = generate_verifier_hex(salt, self.email, self.password, kdf_version=2)
        self.uid = notes_db.create_user_srp(
            self.email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )
        self.client = self.app_mod.app.test_client()
        self.app = self.app_mod.app

    def tearDown(self):
        self.tmp.cleanup()

    def _csrf(self, client=None) -> str:
        client = client or self.client
        with client.session_transaction() as sess:
            return str(sess.get("csrf") or "")

    def _bind_session(self, client, token: str) -> None:
        import secrets
        import time

        from config import SESSION_SECONDS

        with client.session_transaction() as sess:
            sess["uid"] = self.uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            sess["sid"] = token

    def _open_session(self, *, device_id: str, label: str = "Mac · Chrome") -> str:
        return self.notes_db.create_user_session(
            self.uid,
            device_label=label,
            device_id=device_id,
            ip_location="Netherlands",
        )

    def test_first_device_session_is_trusted_not_pending(self):
        token = self._open_session(device_id="first-device-r79")
        self._bind_session(self.client, token)
        listed = self.client.get("/api/sessions").get_json()["sessions"]
        self.assertEqual(len(listed), 1)
        self.assertTrue(listed[0]["trusted"])
        self.assertFalse(listed[0]["pending"])

    def test_second_device_is_pending_until_approved(self):
        trusted_tok = self._open_session(device_id="trusted-device-r79")
        self._bind_session(self.client, trusted_tok)
        pending_tok = self._open_session(device_id="new-device-pending-r79", label="iPhone · Safari")
        other = self.app.test_client()
        self._bind_session(other, pending_tok)
        listed = self.client.get("/api/sessions").get_json()["sessions"]
        self.assertEqual(len(listed), 2)
        pending = next(s for s in listed if s["device_id_suffix"] == "newd")
        trusted = next(s for s in listed if s["device_id_suffix"] == "trus")
        self.assertTrue(pending["pending"])
        self.assertFalse(trusted["pending"])

        approved = self.client.post(
            f"/api/sessions/{pending['id']}/approve",
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(approved.status_code, 200)
        self.assertFalse(approved.get_json()["pending"])
        after = self.client.get("/api/sessions").get_json()["sessions"]
        row = next(s for s in after if s["id"] == pending["id"])
        self.assertFalse(row["pending"])
        self.assertTrue(row["trusted"])

    def test_deny_revokes_pending_session(self):
        trusted_tok = self._open_session(device_id="trusted-device-r79")
        self._bind_session(self.client, trusted_tok)
        pending_tok = self._open_session(device_id="intruder-device-r79")
        other = self.app.test_client()
        self._bind_session(other, pending_tok)
        listed = self.client.get("/api/sessions").get_json()["sessions"]
        pending = next(s for s in listed if s["pending"])
        denied = self.client.delete(
            f"/api/sessions/{pending['id']}",
            headers={"X-CSRF-Token": self._csrf()},
        )
        self.assertEqual(denied.status_code, 200)
        stored = self.notes_db.get_user_session(int(pending["id"]), self.uid)
        self.assertGreater(float(stored["revoked_at"] or 0), 0)
        self.assertEqual(self.client.get("/api/account").status_code, 200)
        self.assertEqual(other.get("/api/account").status_code, 401)

    def test_sign_in_completes_without_waiting_on_approve(self):
        import auth
        from flask import session as flask_session

        trusted_tok = self._open_session(device_id="trusted-device-r79")
        self._bind_session(self.client, trusted_tok)
        with self.app.test_request_context(
            "/",
            headers={"X-Device-Id": "instant-access-r79", "User-Agent": "Mozilla/5.0 (iPhone) Safari/604.1"},
            environ_base={"REMOTE_ADDR": "203.0.113.50"},
        ):
            auth.login_user(self.uid, totp_ok=True)
            snap = dict(flask_session)
        other = self.app.test_client()
        with other.session_transaction() as sess:
            sess.update(snap)
        self.assertEqual(other.get("/api/account").status_code, 200)
        row = other.get("/api/sessions").get_json()["sessions"]
        self.assertTrue(any(s["current"] and s["pending"] for s in row))

    def test_signin_alert_email_still_has_no_approve_links(self):
        body = self.signin_alert.build_signin_alert_body(
            when=1_700_000_000.0,
            country="NL",
            browser_os="Mac · Chrome",
        )
        lower = body.lower()
        self.assertNotIn("http", lower)
        self.assertNotIn("approve", lower)
        self.assertIn("settings > devices", lower)

    def test_new_login_after_deny_sends_alert_again(self):
        import auth

        sent = []
        self._open_session(device_id="trusted-device-r79")
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        device_id = "repeat-alert-r79"
        with patch.object(self.signin_alert, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers={"X-Device-Id": device_id, "User-Agent": ua, "CF-IPCountry": "BE"},
                    environ_base={"REMOTE_ADDR": "203.0.113.60"},
                ):
                    auth.login_user(self.uid, totp_ok=True)
                row = self.notes_db.find_reusable_session(
                    self.uid, device_id=device_id, ip="203.0.113.60", device_label="Windows · Chrome",
                )
                self.assertIsNotNone(row)
                self.notes_db.revoke_user_session(int(row["id"]), self.uid, reason="denied")
                self.assertEqual(len(sent), 1)
                with self.notes_db.tx() as conn:
                    conn.execute("DELETE FROM signin_alert_log WHERE user_id = ?", (self.uid,))
                with self.app.test_request_context(
                    "/",
                    headers={"X-Device-Id": device_id, "User-Agent": ua, "CF-IPCountry": "BE"},
                    environ_base={"REMOTE_ADDR": "203.0.113.60"},
                ):
                    auth.login_user(self.uid, totp_ok=True)
        self.assertEqual(len(sent), 2)


if __name__ == "__main__":
    unittest.main()
