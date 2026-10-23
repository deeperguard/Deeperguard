"""Round 72 Part C: freeze device_label; DevTools UA must not rename the row."""
from __future__ import annotations

import importlib.util
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
TESTS_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


LINUX_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
ANDROID_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)


class Round72DeviceLabelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round72"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round72-secret", encoding="utf-8")

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
                "deeperguard_app",
            } or name.startswith("app."):
                sys.modules.pop(name, None)

        spec = importlib.util.spec_from_file_location(
            "deeperguard_app", APP_DIR / "app.py",
        )
        self.app_mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["deeperguard_app"] = self.app_mod
        spec.loader.exec_module(self.app_mod)
        import db as notes_db
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.notes_db = notes_db
        salt = new_srp_salt_hex()
        email = "r72-label@home.local"
        password = "round72-secure-pass-ok"
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        self.uid = notes_db.create_user_srp(
            email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def _bind_session(self, token: str, *, ua: str, device_id: str):
        from config import SESSION_SECONDS

        with self.client.session_transaction() as sess:
            sess["uid"] = self.uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            sess["sid"] = token
        self.client.environ_base["HTTP_USER_AGENT"] = ua
        self.client.environ_base["HTTP_X_DEVICE_ID"] = device_id
        self.client.environ_base["REMOTE_ADDR"] = "127.0.0.1"

    def test_linux_label_frozen_when_ua_becomes_android(self):
        device_id = "f61e9a2b-1111-2222-3333-444455556666"
        token = self.notes_db.create_user_session(
            self.uid,
            device_label="Linux · Chrome",
            user_agent=LINUX_UA,
            device_id=device_id,
            ip="127.0.0.1",
        )
        self.assertTrue(token)
        self._bind_session(token, ua=LINUX_UA, device_id=device_id)

        listed = self.client.get("/api/sessions")
        self.assertEqual(listed.status_code, 200)
        current = next(item for item in listed.get_json()["sessions"] if item["current"])
        self.assertEqual(current["device"], "Linux · Chrome")
        suffix = current.get("device_id_suffix") or ""
        self.assertEqual(suffix, self.app_mod._device_id_suffix(device_id))

        # DevTools device emulation swaps in an Android UA on a later request.
        self.client.environ_base["HTTP_USER_AGENT"] = ANDROID_UA
        aligned = self.client.get("/api/sessions")
        self.assertEqual(aligned.status_code, 200)

        refreshed = aligned.get_json()["sessions"]
        current2 = next(item for item in refreshed if item["current"])
        self.assertEqual(current2["device"], "Linux · Chrome")
        self.assertEqual(current2.get("device_id_suffix"), suffix)

        row = self.notes_db.get_session_by_token(token)
        self.assertIsNotNone(row)
        self.assertEqual(row["device_label"], "Linux · Chrome")
        self.assertIn("Android", str(row["user_agent"] or ""))

    def test_empty_label_filled_once_then_frozen(self):
        device_id = "bbbbbbbb-1111-2222-3333-444455556666"
        token = self.notes_db.create_user_session(
            self.uid,
            device_label="",
            user_agent="",
            device_id=device_id,
            ip="127.0.0.1",
        )
        self._bind_session(token, ua=LINUX_UA, device_id=device_id)

        self.client.get("/api/sessions")
        row = self.notes_db.get_session_by_token(token)
        self.assertEqual(row["device_label"], "Linux · Chrome")

        self.client.environ_base["HTTP_USER_AGENT"] = ANDROID_UA
        self.client.get("/api/sessions")
        row2 = self.notes_db.get_session_by_token(token)
        self.assertEqual(row2["device_label"], "Linux · Chrome")
        self.assertIn("Android", str(row2["user_agent"] or ""))


if __name__ == "__main__":
    unittest.main()
