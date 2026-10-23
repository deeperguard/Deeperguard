"""Round 71 Part A: narrow duplicate revoke/collapse; device list fields."""
from __future__ import annotations

import importlib
import os
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


class Round71SigninDeviceIdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_ALLOWED_CIDRS"] = "127.0.0.1/32"
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "round71"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_DISABLE_CIDR_GATE"] = "1"
        os.environ["NOTES_ALLOW_REGISTER"] = "1"
        os.environ["NOTES_SECURE_COOKIES"] = "1"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("round71-secret", encoding="utf-8")

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
            } or name.startswith("app."):
                sys.modules.pop(name, None)
        # Load app/app.py explicitly — with repo root on sys.path, bare
        # importlib.import_module("app") can bind the empty package __init__.
        import importlib.util

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
        email = "r71-device@home.local"
        password = "round71-secure-pass-ok"
        verifier = generate_verifier_hex(salt, email, password, kdf_version=2)
        self.uid = notes_db.create_user_srp(
            email, new_kdf_salt(), salt, verifier, srp_kdf_version=2,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_real_device_id_does_not_revoke_empty_peer_same_ip_ua(self):
        notes_db = self.notes_db
        uid = self.uid
        empty_tok = notes_db.create_user_session(
            uid,
            device_label="Linux · Chrome",
            ip="9.246.77.167",
            device_id="",
        )
        empty = notes_db.get_session_by_token(empty_tok)
        self.assertEqual(float(empty["revoked_at"] or 0), 0)

        real_tok = notes_db.create_user_session(
            uid,
            device_label="Linux · Chrome",
            ip="9.246.77.167",
            device_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        )
        empty_after = notes_db.get_user_session(int(empty["id"]), uid)
        real = notes_db.get_session_by_token(real_tok)
        self.assertEqual(float(empty_after["revoked_at"] or 0), 0, "empty peer must survive")
        self.assertEqual(float(real["revoked_at"] or 0), 0)

        notes_db.collapse_duplicate_sessions(uid)
        empty_after = notes_db.get_user_session(int(empty["id"]), uid)
        real_after = notes_db.get_user_session(int(real["id"]), uid)
        self.assertEqual(float(empty_after["revoked_at"] or 0), 0)
        self.assertEqual(float(real_after["revoked_at"] or 0), 0)

    def test_same_device_id_and_empty_pairs_still_collapse(self):
        notes_db = self.notes_db
        uid = self.uid
        did = "11111111-2222-3333-4444-555555555555"
        t1 = notes_db.create_user_session(
            uid, device_label="Mac · Chrome", ip="198.51.100.1", device_id=did,
        )
        with notes_db.tx() as conn:
            conn.execute(
                """
                INSERT INTO user_sessions (
                    user_id, token_hash, device_id, device_label, user_agent, ip, ip_location,
                    created_at, last_seen_at, last_login_at, revoked_at
                ) VALUES (?, ?, ?, ?, '', ?, '', ?, ?, ?, 0)
                """,
                (
                    uid,
                    notes_db._session_token_hash("dup-token-r71-a"),
                    did,
                    "Mac · Chrome",
                    "198.51.100.1",
                    time.time(),
                    time.time(),
                    time.time(),
                ),
            )
            dup_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        notes_db.collapse_duplicate_sessions(uid)
        first = notes_db.get_session_by_token(t1)
        dup = notes_db.get_user_session(dup_id, uid)
        revoked = [row for row in (first, dup) if float(row["revoked_at"] or 0) > 0]
        live = [row for row in (first, dup) if float(row["revoked_at"] or 0) == 0]
        self.assertEqual(len(revoked), 1)
        self.assertEqual(len(live), 1)
        self.assertEqual(str(revoked[0]["revoke_reason"] or ""), "duplicate")

        e1 = notes_db.create_user_session(
            uid, device_label="Windows · Edge", ip="203.0.113.9", device_id="",
        )
        with notes_db.tx() as conn:
            conn.execute(
                """
                INSERT INTO user_sessions (
                    user_id, token_hash, device_id, device_label, user_agent, ip, ip_location,
                    created_at, last_seen_at, last_login_at, revoked_at
                ) VALUES (?, ?, '', ?, '', ?, '', ?, ?, ?, 0)
                """,
                (
                    uid,
                    notes_db._session_token_hash("dup-empty-r71-b"),
                    "Windows · Edge",
                    "203.0.113.9",
                    time.time(),
                    time.time(),
                    time.time(),
                ),
            )
            empty_dup_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        notes_db.collapse_duplicate_sessions(uid)
        e1_row = notes_db.get_session_by_token(e1)
        e2_row = notes_db.get_user_session(empty_dup_id, uid)
        empty_revoked = [row for row in (e1_row, e2_row) if float(row["revoked_at"] or 0) > 0]
        empty_live = [row for row in (e1_row, e2_row) if float(row["revoked_at"] or 0) == 0]
        self.assertEqual(len(empty_revoked), 1)
        self.assertEqual(len(empty_live), 1)

    def test_public_session_suffix_and_inactive(self):
        inactive_s = self.app_mod._SESSION_INACTIVE_SECONDS
        suffix = self.app_mod._device_id_suffix
        public = self.app_mod._public_session

        self.assertEqual(suffix("0ae415bd-8782-413f-90a4-db81716fa11d"), "0ae4")
        self.assertEqual(suffix(""), "")
        now = time.time()
        active = {
            "id": 1,
            "device_label": "Linux · Chrome",
            "device_id": "abcd1234-0000-0000-0000-000000000001",
            "ip": "1.2.3.4",
            "ip_location": "Test",
            "last_login_at": now - 10,
            "last_seen_at": now - 10,
        }
        pub = public(active, current_token="", now=now)
        self.assertEqual(pub["device_id_suffix"], "abcd")
        self.assertFalse(pub["inactive"])
        self.assertEqual(pub["last_seen_at"], now - 10)

        stale = dict(active)
        stale["last_seen_at"] = now - inactive_s - 1
        pub_stale = public(stale, current_token="", now=now)
        self.assertTrue(pub_stale["inactive"])


if __name__ == "__main__":
    unittest.main()
