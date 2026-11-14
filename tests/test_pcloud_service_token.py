"""Encrypted pCloud service token storage."""
import importlib
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

TOKEN = "ZZ-secret-access-token-9f8e7d"
BLOB = '{"access_token":"%s","token_type":"bearer","expiry":"2030-01-01T00:00:00Z"}' % TOKEN


class ServiceTokenTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS")}
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ.update(NOTES_ROOT=str(root), NOTES_DATA=str(root / "data"), NOTES_KEYS=str(root / "keys"))
        for name in ("config", "db", "pcloud_service_token"):
            sys.modules.pop(name, None)
        self.db = importlib.import_module("db")
        self.t = importlib.import_module("pcloud_service_token")
        self.root = root

    def tearDown(self):
        self.db.reset_connection()
        self.tmp.cleanup()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_round_trip_and_status(self):
        self.assertFalse(self.t.status()["configured"])
        self.t.set_token(BLOB, "eu", "admin@x")
        st = self.t.status()
        self.assertEqual((st["configured"], st["region"], st["set_by"]), (True, "eu", "admin@x"))
        self.assertNotIn(TOKEN, repr(st))
        tok, region = self.t.decrypt_for_use()
        self.assertIn(TOKEN, tok)
        self.assertEqual(region, "eu")

    def test_bare_token(self):
        self.t.set_token(TOKEN, "us", "a")
        self.assertIn(TOKEN, self.t.decrypt_for_use()[0])

    def test_key_file_mode_and_no_plaintext_in_db(self):
        self.t.set_token(BLOB, "eu", "a")
        self.assertEqual(stat.S_IMODE(os.stat(self.t.key_path()).st_mode), 0o600)
        dump = "\n".join(sqlite3.connect(str(self.db.db_path())).iterdump())
        self.assertNotIn(TOKEN, dump)
        for f in (self.root / "data").iterdir():
            self.assertNotIn(TOKEN.encode(), f.read_bytes())

    def test_wrong_key_and_tampering(self):
        self.t.set_token(BLOB, "eu", "a")
        self.t.key_path().write_bytes(os.urandom(32))
        with self.assertRaises(self.t.TokenError) as ctx:
            self.t.decrypt_for_use()
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.t.key_path().unlink()
        self.t.set_token(BLOB, "eu", "a")
        conn = self.db.connection()
        ct = bytearray(conn.execute("SELECT ciphertext FROM pcloud_service_token").fetchone()[0])
        ct[0] ^= 1
        conn.execute("UPDATE pcloud_service_token SET ciphertext = ?", (bytes(ct),))
        conn.commit()
        with self.assertRaises(self.t.TokenError):
            self.t.decrypt_for_use()

    def test_aad_binds_row(self):
        self.t.set_token(BLOB, "eu", "a")
        key = self.t.key_path().read_bytes()
        row = self.db.connection().execute("SELECT ciphertext, nonce FROM pcloud_service_token").fetchone()
        with self.assertRaises(InvalidTag):
            AESGCM(key).decrypt(row["nonce"], row["ciphertext"], b"other:1")

    def test_invalid_input_rejected_without_echo(self):
        bad = [
            ("A" * 5000, "eu"), ('{"access_token": "' + TOKEN, "eu"), ('{"x":1}', "eu"),
            ("tok\x00en", "eu"), ("", "eu"), (TOKEN, "asia"), (TOKEN, None), (123, "eu"),
        ]
        for raw, region in bad:
            with self.assertRaises(self.t.TokenError) as ctx:
                self.t.set_token(raw, region, "a")
            self.assertNotIn(TOKEN, str(ctx.exception))
            self.assertNotIn("AAAA", str(ctx.exception))
        self.assertFalse(self.t.status()["configured"])
        self.assertFalse(self.t.key_path().exists())

    def test_remove(self):
        self.t.set_token(BLOB, "eu", "a")
        self.t.remove()
        self.assertFalse(self.t.status()["configured"])
        n = self.db.connection().execute("SELECT COUNT(*) FROM pcloud_service_token").fetchone()[0]
        self.assertEqual(n, 0)
        with self.assertRaises(self.t.TokenError):
            self.t.decrypt_for_use()


if __name__ == "__main__":
    unittest.main()
