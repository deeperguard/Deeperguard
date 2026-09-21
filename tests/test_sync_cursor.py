"""Regression tests: synced_at cursor must not strand rows stored with synced_at = 0.

Legacy rows (writes from before the cursor existed, stale workers, bulk
restores) sit at synced_at = 0. list_items_since() must fall back to
updated_at for those rows — the same rule the web client's rowCursor() uses.

The missing-Neoxa incident: the row existed server-side, but incremental
pulls (WHERE synced_at > since) never returned it, and a byte-budget cut on
a full sync parked the client cursor past it, so no later pull ever
revisited it.
"""
import importlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))


def _fresh_db(modules=("config", "db")):
    for name in list(sys.modules):
        if name in modules:
            sys.modules.pop(name, None)
    return importlib.import_module("db")


class SyncCursorDbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        self.db = _fresh_db()
        now = time.time()
        conn = self.db.connection()
        conn.execute(
            """
            INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at)
            VALUES ('owner@home.local', 'x', 'salt', ?, ?)
            """,
            (now, now),
        )
        conn.commit()
        self.uid = 1
        # Legacy row with a NEW updated_at but synced_at = 0 sorts after the
        # normally-synced row only when the fallback is in place.
        self.db.upsert_item(self.uid, "x", "ct-x", 1, "h-x", False, 5000.0, synced_at=0.0)
        self.db.upsert_item(self.uid, "a", "ct-a", 1, "h-a", False, 100.0, synced_at=100.0)

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS"):
            os.environ.pop(key, None)

    def uuids(self, rows):
        return [row["item_uuid"] for row in rows]

    def test_synced_at_cursor_orders_zero_rows_by_updated_at(self):
        rows = self.db.list_items_since(self.uid, 0, cursor="synced_at")
        self.assertEqual(self.uuids(rows), ["a", "x"])

    def test_synced_at_cursor_respects_since_for_zero_rows(self):
        self.assertEqual(
            self.uuids(self.db.list_items_since(self.uid, 200, cursor="synced_at")),
            ["x"],
        )
        self.assertEqual(
            self.uuids(self.db.list_items_since(self.uid, 6000, cursor="synced_at")),
            [],
        )

    def test_updated_at_cursor_unchanged(self):
        rows = self.db.list_items_since(self.uid, 0, cursor="updated_at")
        self.assertEqual(self.uuids(rows), ["a", "x"])

    def test_synced_at_pagination_terminates_and_covers_all_rows(self):
        seen = []
        since = 0.0
        after = ""
        for _ in range(10):
            page = self.db.list_items_since(
                self.uid, since, after_uuid=after, limit=1, cursor="synced_at"
            )
            if not page:
                break
            seen.append(page[0]["item_uuid"])
            row = page[0]
            synced = float(row.get("synced_at") or 0)
            since = synced if synced > 0 else float(row.get("updated_at") or 0)
            after = page[0]["item_uuid"]
        self.assertEqual(seen, ["a", "x"])


class SyncCursorPageTests(unittest.TestCase):
    """End-to-end through _sync_pull_response with a tiny byte budget.

    Reproduces the production stall: a byte-budget cut ends page 1 on a
    zero-synced_at row; the next page must continue by that row's updated_at
    instead of dropping every remaining legacy row.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_SKIP_LOGIN"] = "0"
        os.environ["NOTES_BUILD"] = "192"
        os.environ["NOTES_SERVER_INFO_REFRESH"] = "0"
        os.environ["NOTES_STRICT_ZK"] = "1"
        os.environ["NOTES_SYNC_PAGE_BYTES"] = "100"
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        (root / "data").mkdir(parents=True)
        for name in list(sys.modules):
            if name in {"app", "auth", "db", "config", "passwords", "totp", "ocr",
                        "ocr_index", "ocr_jobs", "server_info_cache", "backup_pcloud",
                        "backup_mail", "srp_auth", "webauthn_helper", "admin_api",
                        "auth_rate_limit", "plans", "ai_relay"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.db = sys.modules["db"]
        now = time.time()
        conn = self.db.connection()
        conn.execute(
            """
            INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at)
            VALUES ('owner@home.local', 'x', 'salt', ?, ?)
            """,
            (now, now),
        )
        conn.commit()
        self.uid = 1
        blob = "B" * 60
        self.db.upsert_item(self.uid, "b1", "ct-b1", 1, "h-b1", False, 100.0,
                            blob_ciphertext=blob, synced_at=0.0)
        self.db.upsert_item(self.uid, "b2", "ct-b2", 1, "h-b2", False, 200.0,
                            blob_ciphertext=blob, synced_at=0.0)
        self.db.upsert_item(self.uid, "b3", "ct-b3", 1, "h-b3", False, 300.0,
                            blob_ciphertext=blob, synced_at=0.0)
        self.db.upsert_item(self.uid, "a", "ct-a", 1, "h-a", False, 400.0,
                            synced_at=4000.0)

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_SKIP_LOGIN",
                    "NOTES_BUILD", "NOTES_SERVER_INFO_REFRESH", "NOTES_STRICT_ZK",
                    "NOTES_SYNC_PAGE_BYTES"):
            os.environ.pop(key, None)

    @staticmethod
    def _row_cursor(row):
        synced = float(row.get("synced_at") or 0)
        if synced > 0:
            return synced
        return float(row.get("updated_at") or 0)

    def test_byte_cut_page_recovers_remaining_zero_rows(self):
        # Faithful to the PWA pull loop: advance by the last row's effective
        # cursor (the client's rowCursor fallback) plus its uuid.
        seen = []
        since = 0.0
        after = ""
        for _ in range(10):
            # include_blobs=True like a real full-vault pull (cursorSince == 0).
            page = self.app_mod._sync_pull_response(
                self.uid, since, after, True, {}, 50, cursor_kind="synced_at"
            )
            for row in page["items"]:
                seen.append(row["item_uuid"])
            if not page["has_more"]:
                break
            last = page["items"][-1]
            since = self._row_cursor(last)
            after = last["item_uuid"]
        self.assertEqual(seen, ["b1", "b2", "b3", "a"])


if __name__ == "__main__":
    unittest.main()
