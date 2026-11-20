"""The pCloud password column is wiped and dropped; connections that used it must reconnect."""
import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

SECRET = "old-pcloud-password-xyz"


class PcloudPasswordMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["NOTES_DATA"] = str(Path(self.tmp.name) / "data")
        os.environ["NOTES_KEYS"] = str(Path(self.tmp.name) / "keys")
        for name in list(sys.modules):
            if name in {"config", "db"}:
                sys.modules.pop(name, None)
        self.db = importlib.import_module("db")
        self.db.reset_connection()

    def tearDown(self):
        self.db.reset_connection()
        self.tmp.cleanup()
        os.environ.pop("NOTES_DATA", None)
        os.environ.pop("NOTES_KEYS", None)

    def _legacy_db(self):
        conn = self.db.connection()
        conn.execute("ALTER TABLE users ADD COLUMN pcloud_password TEXT NOT NULL DEFAULT ''")
        rows = [("a", SECRET), ("b", ""), ("", "")]
        for i, (name, pw) in enumerate(rows, start=1):
            conn.execute(
                "INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at, "
                "pcloud_enabled, pcloud_username, pcloud_password, pcloud_last_sync_status) "
                "VALUES (?, 'h', 's', 1, 1, 1, ?, ?, 'ok')",
                (f"u{i}@x.test", name, pw),
            )
        conn.commit()
        self.db.reset_connection()

    def test_password_wiped_column_dropped_connections_flagged(self):
        self._legacy_db()
        conn = self.db.connection()  # runs init_schema, which migrates
        cols = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
        self.assertNotIn("pcloud_password", cols)
        status = {
            r["email"]: r["pcloud_last_sync_status"]
            for r in conn.execute("SELECT email, pcloud_last_sync_status FROM users")
        }
        self.assertEqual(status["u1@x.test"], "reconnect_needed")
        self.assertEqual(status["u2@x.test"], "reconnect_needed")
        self.assertEqual(status["u3@x.test"], "ok")
        conn.commit()
        self.db.reset_connection()
        raw = Path(self.db.db_path()).read_bytes()
        wal = Path(str(self.db.db_path()) + "-wal")
        if wal.is_file():
            raw += wal.read_bytes()
        self.assertNotIn(SECRET.encode(), raw)

    def test_second_start_changes_nothing(self):
        self._legacy_db()
        self.db.connection()
        self.db.reset_connection()
        check = self.db.connection()
        check.execute("UPDATE users SET pcloud_last_sync_status = 'ok'")
        check.commit()
        self.db.reset_connection()
        again = sqlite3.connect(str(self.db.db_path()))
        self.db.connection()
        self.assertEqual(
            again.execute("SELECT DISTINCT pcloud_last_sync_status FROM users").fetchall(), [("ok",)]
        )
        again.close()


if __name__ == "__main__":
    unittest.main()
