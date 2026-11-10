"""Sync push retry idempotency (sync_retry_key + sync_request_hash)."""
import importlib
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"


class SyncRetryIdempotencyTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(APP_DIR))
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("sync-retry-test", encoding="utf-8")
        import config

        importlib.reload(config)
        if "db" in sys.modules:
            importlib.reload(sys.modules["db"])
        import db

        db.reset_connection()
        db.init_schema()
        self.db = db
        self.user_id = db.create_user_srp(
            f"sync-retry-{uuid.uuid4().hex[:8]}@home.local",
            "kdf-salt",
            "srp-salt",
            "srp-verifier",
            srp_kdf_version=2,
        )
        self.item_uuid = "11111111-1111-1111-1111-111111111111"
        self.cipher_a = json.dumps({"v": 1, "a": "one"})
        self.cipher_b = json.dumps({"v": 1, "a": "two"})
        self.hash_a = "sha-a"
        self.hash_b = "sha-b"
        self.retry_key = "client-retry-key-1"

    def tearDown(self):
        self.tmp.cleanup()

    def _item(self, ciphertext, content_hash, retry_key=None):
        row = {
            "item_uuid": self.item_uuid,
            "ciphertext": ciphertext,
            "content_hash": content_hash,
            "content_version": 1,
            "deleted": False,
            "updated_at": time.time(),
            "base_rev": 0,
        }
        if retry_key:
            row["sync_retry_key"] = retry_key
            row["sync_request_hash"] = content_hash
        return row

    def test_identical_retry_is_unchanged(self):
        first = self.db.upsert_items_batch(self.user_id, [self._item(self.cipher_a, self.hash_a, self.retry_key)])
        self.assertEqual(first[0]["status"], "ok")
        second = self.db.upsert_items_batch(self.user_id, [self._item(self.cipher_a, self.hash_a, self.retry_key)])
        self.assertEqual(second[0]["status"], "unchanged")
        self.assertTrue(second[0].get("idempotent"))

    def test_retry_hash_mismatch_does_not_overwrite(self):
        self.db.upsert_items_batch(self.user_id, [self._item(self.cipher_a, self.hash_a, self.retry_key)])
        conflict = self.db.upsert_items_batch(self.user_id, [self._item(self.cipher_b, self.hash_b, self.retry_key)])
        self.assertEqual(conflict[0]["status"], "retry_conflict")
        row = self.db.connection().execute(
            "SELECT ciphertext, content_hash FROM items WHERE user_id = ? AND item_uuid = ?",
            (self.user_id, self.item_uuid),
        ).fetchone()
        self.assertEqual(row["ciphertext"], self.cipher_a)
        self.assertEqual(row["content_hash"], self.hash_a)
        self.assertIn("error", conflict[0])

    def test_later_edit_uses_new_retry_key(self):
        first = self.db.upsert_items_batch(self.user_id, [self._item(self.cipher_a, self.hash_a, self.retry_key)])
        base_rev = int(first[0].get("rev") or 1)
        row = self._item(self.cipher_b, self.hash_b, "client-retry-key-2")
        row["base_rev"] = base_rev
        later = self.db.upsert_items_batch(self.user_id, [row])
        self.assertEqual(later[0]["status"], "ok")
        row = self.db.connection().execute(
            "SELECT content_hash FROM items WHERE user_id = ? AND item_uuid = ?",
            (self.user_id, self.item_uuid),
        ).fetchone()
        self.assertEqual(row["content_hash"], self.hash_b)


if __name__ == "__main__":
    unittest.main()
