"""Round 74: memorable device_phrase from device_id on /api/sessions."""
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


class Round74DevicePhraseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round74"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round74-secret", encoding="utf-8")

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
                "device_phrase",
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
        from device_phrase import device_phrase
        from passwords import new_kdf_salt
        from srp_auth import generate_verifier_hex, new_srp_salt_hex

        self.notes_db = notes_db
        self.device_phrase = device_phrase
        salt = new_srp_salt_hex()
        email = "r74-phrase@home.local"
        password = "round74-secure-pass-ok"
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        self.uid = notes_db.create_user_srp(
            email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )
        self.client = self.app_mod.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_phrase_stable_two_words(self):
        a = self.device_phrase("f61e9a2b-1111-2222-3333-444455556666")
        b = self.device_phrase("f61e9a2b-1111-2222-3333-444455556666")
        self.assertEqual(a, b)
        parts = a.split()
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(p.isalpha() and p.islower() for p in parts))
        self.assertEqual(self.device_phrase(""), "")

    def test_sessions_api_returns_device_phrase(self):
        from config import SESSION_SECONDS

        device_id = "f61e9a2b-1111-2222-3333-444455556666"
        token = self.notes_db.create_user_session(
            self.uid,
            device_label="Linux · Chrome",
            ip="127.0.0.1",
            device_id=device_id,
        )
        with self.client.session_transaction() as sess:
            sess["uid"] = self.uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            sess["sid"] = token
        self.client.environ_base["HTTP_X_DEVICE_ID"] = device_id
        self.client.environ_base["REMOTE_ADDR"] = "127.0.0.1"

        resp = self.client.get("/api/sessions")
        self.assertEqual(resp.status_code, 200)
        rows = resp.get_json().get("sessions") or []
        self.assertEqual(len(rows), 1)
        expected = self.device_phrase(device_id)
        self.assertEqual(rows[0]["device_phrase"], expected)
        self.assertEqual(
            rows[0]["device_id_suffix"],
            self.app_mod._device_id_suffix(device_id),
        )


if __name__ == "__main__":
    unittest.main()
