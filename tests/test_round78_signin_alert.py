"""Round 78: new-device sign-in email alert."""
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
    """Run Thread targets synchronously so tests can assert on send."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target = target
        self._args = args or ()
        self._kwargs = kwargs or {}

    def start(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def join(self, timeout=None):
        return None


class Round78SigninAlertTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round78"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round78-secret", encoding="utf-8")

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

        import auth
        import db as notes_db
        import signin_alert
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.auth = auth
        self.notes_db = notes_db
        self.signin_alert = signin_alert
        salt = new_srp_salt_hex()
        self.email = "r78-alert@home.local"
        self.password = "round78-secure-pass-ok"
        verifier = generate_verifier_hex(salt, self.email, self.password, kdf_version=2)
        self.uid = notes_db.create_user_srp(
            self.email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )
        self.client = self.app_mod.app.test_client()
        self.app = self.app_mod.app

    def tearDown(self):
        self.tmp.cleanup()

    def _login_environ(self, *, ua: str, device_id: str = "", country: str = ""):
        headers = {"User-Agent": ua}
        if device_id:
            headers["X-Device-Id"] = device_id
        if country:
            headers["CF-IPCountry"] = country
        return headers

    def test_body_has_no_links_or_http(self):
        body = self.signin_alert.build_signin_alert_body(
            when=1_700_000_000.0,
            country="NL",
            browser_os="Mac · Chrome",
        )
        lower = body.lower()
        self.assertNotIn("http", lower)
        self.assertNotIn("href", lower)
        self.assertNotIn("<a ", lower)
        self.assertNotIn("://", body)
        self.assertIn("deeperguard.com", body)
        self.assertIn("Settings > Devices", body)
        self.assertIn("UTC", body)
        self.assertIn("Europe/Amsterdam", body)
        self.assertIn("Approximate location: NL", body)
        self.assertIn("Browser / OS: Mac · Chrome", body)

    def test_request_country_from_cf_ipcountry(self):
        with self.app.test_request_context(headers={"CF-IPCountry": "DE"}):
            self.assertEqual(self.signin_alert.request_country(), "DE")
        with self.app.test_request_context(headers={"CF-IPCountry": "xx"}):
            self.assertEqual(self.signin_alert.request_country(), "Unknown")
        with self.app.test_request_context():
            self.assertEqual(self.signin_alert.request_country(), "Unknown")

    def test_alert_sent_on_new_device(self):
        sent = []
        ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        device_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        with patch.object(self.signin_alert, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers=self._login_environ(ua=ua, device_id=device_id, country="NL"),
                    environ_base={"REMOTE_ADDR": "203.0.113.10"},
                ):
                    self.auth.login_user(self.uid, totp_ok=True)
        self.assertEqual(len(sent), 1)
        recipient, subject, body = sent[0]
        self.assertEqual(recipient, self.email)
        self.assertIn("new sign-in", subject.lower())
        self.assertNotIn("http", body.lower())
        self.assertIn("Approximate location: NL", body)
        self.assertIn("Mac · Chrome", body)
        # Full IP must not appear.
        self.assertNotIn("203.0.113.10", body)

    def test_not_sent_on_known_device(self):
        ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        device_id = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
        # First login creates the session (and may alert).
        with patch.object(self.signin_alert, "send_plain_email"):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers=self._login_environ(ua=ua, device_id=device_id, country="NL"),
                    environ_base={"REMOTE_ADDR": "203.0.113.11"},
                ):
                    self.auth.login_user(self.uid, totp_ok=True)

        sent = []
        with patch.object(self.signin_alert, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers=self._login_environ(ua=ua, device_id=device_id, country="NL"),
                    environ_base={"REMOTE_ADDR": "203.0.113.11"},
                ):
                    self.auth.login_user(self.uid, totp_ok=True)
        self.assertEqual(sent, [], "known device must not re-alert")

    def test_throttled_within_24h(self):
        sent = []
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        # Two different device ids would each alert; same key twice → throttle.
        key = "d:cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee"
        with patch.object(self.signin_alert, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                ok1 = self.signin_alert.send_signin_alert(
                    self.uid,
                    device_key_value=key,
                    country="BE",
                    browser_os="Windows · Chrome",
                    async_send=True,
                )
                ok2 = self.signin_alert.send_signin_alert(
                    self.uid,
                    device_key_value=key,
                    country="BE",
                    browser_os="Windows · Chrome",
                    async_send=True,
                )
        self.assertTrue(ok1)
        self.assertFalse(ok2)
        self.assertEqual(len(sent), 1)

    def test_signin_succeeds_when_mail_raises(self):
        ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        device_id = "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee"

        def boom(*_a, **_k):
            raise RuntimeError("smtp down")

        with patch.object(self.signin_alert, "send_plain_email", side_effect=boom):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers=self._login_environ(ua=ua, device_id=device_id, country="FR"),
                    environ_base={"REMOTE_ADDR": "203.0.113.12"},
                ):
                    self.auth.login_user(self.uid, totp_ok=True)
                    # Session must be established despite mail failure.
                    self.assertTrue(self.auth.authenticated())
                    self.assertEqual(self.auth.current_user_id(), self.uid)
                    self.assertTrue(self.auth.current_session_token())

    def test_does_not_use_client_device_name(self):
        """Only server-parsed UA label — not a client-supplied device name header."""
        sent = []
        ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
        device_id = "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee"
        with patch.object(self.signin_alert, "send_plain_email", side_effect=lambda *a, **k: sent.append(a)):
            with patch.object(self.signin_alert.threading, "Thread", ImmediateThread):
                with self.app.test_request_context(
                    "/",
                    headers={
                        **self._login_environ(ua=ua, device_id=device_id, country="NL"),
                        "X-Device-Name": "Dennis iPhone Pro Max Custom",
                    },
                    environ_base={"REMOTE_ADDR": "203.0.113.13"},
                ):
                    self.auth.login_user(self.uid, totp_ok=True)
        self.assertEqual(len(sent), 1)
        body = sent[0][2]
        self.assertNotIn("Dennis iPhone Pro Max Custom", body)
        self.assertIn("iPhone · Safari", body)

    def test_claim_throttle_db(self):
        key = "d:ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.assertTrue(self.notes_db.claim_signin_alert(self.uid, key, window_seconds=86400))
        self.assertFalse(self.notes_db.claim_signin_alert(self.uid, key, window_seconds=86400))
        # Different device may claim.
        self.assertTrue(
            self.notes_db.claim_signin_alert(
                self.uid, "d:00000000-bbbb-cccc-dddd-eeeeeeeeeeee", window_seconds=86400
            )
        )


if __name__ == "__main__":
    unittest.main()
