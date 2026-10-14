"""Server-side sync push regressions.

- One over-quota or oversized item must not block the other items in the
  batch (per-item quota/size statuses; legacy clients still get a 413).
- Every accepted write bumps a server-assigned per-item revision. Clients
  that send base_rev get "conflict" (with the server copy) instead of a
  silent clock-based last-writer-wins; clients that do not send it keep the
  old stale/ok behaviour.
- A client clock far in the future is clamped for ordering; a non-numeric
  updated_at is rejected per item instead of failing the request.
"""
import importlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

MODULES = {
    "app", "auth", "db", "config", "passwords", "totp", "ocr", "ocr_index", "ocr_jobs",
    "server_info_cache", "backup_pcloud", "backup_mail", "srp_auth", "webauthn_helper",
    "admin_api", "admin_notify", "auth_rate_limit", "plans", "ai_relay", "uploads",
}


class SyncPushPartialTests(unittest.TestCase):
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
        os.environ["NOTES_SYNC_MAX_ITEM_BYTES"] = "400"
        os.environ.pop("NOTES_DEFAULT_USER_QUOTA_MB", None)
        (root / "keys").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("test-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in MODULES or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.db = importlib.import_module("db")
        self.client = self.app_mod.app.test_client()
        import auth_rate_limit as arl

        arl._hits.clear()
        self._login("owner@home.local")

    def tearDown(self):
        self.tmp.cleanup()
        for key in (
            "NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_SKIP_LOGIN", "NOTES_BUILD",
            "NOTES_SERVER_INFO_REFRESH", "NOTES_STRICT_ZK", "NOTES_SYNC_MAX_ITEM_BYTES",
        ):
            os.environ.pop(key, None)

    def _login(self, email):
        import secrets

        from config import SESSION_SECONDS
        from passwords import hash_password, new_kdf_salt

        self.uid = int(self.db.create_user(email, hash_password("pw-secure-123"), new_kdf_salt()))
        with self.client.session_transaction() as sess:
            sess["uid"] = self.uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
        with self.client.session_transaction() as sess:
            self.csrf = sess.get("csrf", "")

    def _item(self, uuid, updated_at, content_hash, data="BB", **extra):
        row = {
            "item_uuid": uuid,
            "content_version": 1,
            "ciphertext": f'{{"v":1,"iv":"AA","data":"{data}"}}',
            "content_hash": content_hash,
            "deleted": False,
            "updated_at": updated_at,
        }
        row.update(extra)
        return row

    def _push(self, items, partial=True):
        body = {"items": items}
        if partial:
            body["partial"] = 1
        return self.client.post("/api/sync/items", json=body, headers={"X-CSRF-Token": self.csrf})

    def _stored(self, uuid):
        return self.db.connection().execute(
            "SELECT content_hash, rev, updated_at, deleted, LENGTH(ciphertext) AS n FROM items WHERE user_id = ? AND item_uuid = ?",
            (self.uid, uuid),
        ).fetchone()

    # --- per-item quota and size --------------------------------------------

    def test_quota_hit_does_not_block_other_items(self):
        self.db.update_user_storage_quota(self.uid, 160)
        res = self._push([
            self._item("note", 1.0, "h-note", data="n" * 10),
            self._item("big", 1.0, "h-big", data="z" * 300),
        ])
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        statuses = {row["item_uuid"]: row["status"] for row in body["results"]}
        self.assertEqual(statuses, {"note": "ok", "big": "quota_exceeded"})
        self.assertEqual(body["quota_exceeded"], 1)
        self.assertEqual(body["quota_bytes"], 160)
        self.assertIsNotNone(self._stored("note"), "the small note was written")
        self.assertIsNone(self._stored("big"))

    def test_legacy_client_without_partial_flag_still_gets_413_but_other_items_land(self):
        self.db.update_user_storage_quota(self.uid, 160)
        res = self._push([
            self._item("note", 1.0, "h-note", data="n" * 10),
            self._item("big", 1.0, "h-big", data="z" * 300),
        ], partial=False)
        self.assertEqual(res.status_code, 413)
        body = res.get_json()
        self.assertEqual(body["error"], "storage quota exceeded")
        statuses = {row["item_uuid"]: row["status"] for row in body["results"]}
        self.assertEqual(statuses, {"note": "ok", "big": "quota_exceeded"})
        self.assertIsNotNone(self._stored("note"))

    def test_oversized_item_is_refused_per_item(self):
        res = self._push([
            self._item("note", 1.0, "h-note"),
            self._item("huge", 1.0, "h-huge", data="z" * 1000),
        ])
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        statuses = {row["item_uuid"]: row for row in body["results"]}
        self.assertEqual(statuses["note"]["status"], "ok")
        self.assertEqual(statuses["huge"]["status"], "too_large")
        self.assertEqual(statuses["huge"]["max_item_bytes"], 400)
        self.assertEqual(body["too_large"], 1)
        self.assertIsNone(self._stored("huge"))

    def test_malformed_updated_at_is_rejected_per_item(self):
        res = self._push([
            self._item("ok", 1.0, "h-ok"),
            self._item("bad", "yesterday", "h-bad"),
        ])
        self.assertEqual(res.status_code, 200)
        statuses = {row["item_uuid"]: row for row in res.get_json()["results"]}
        self.assertEqual(statuses["ok"]["status"], "ok")
        self.assertEqual(statuses["bad"]["status"], "rejected")
        self.assertEqual(statuses["bad"]["reason"], "bad_updated_at")

    # --- revisions and conflicts ---------------------------------------------

    def test_accepted_writes_bump_rev_and_pull_reports_it(self):
        first = self._push([self._item("n1", 10.0, "h1")]).get_json()["results"][0]
        self.assertEqual((first["status"], first["rev"]), ("ok", 1))
        second = self._push([self._item("n1", 11.0, "h2", base_rev=1)]).get_json()["results"][0]
        self.assertEqual((second["status"], second["rev"]), ("ok", 2))
        same = self._push([self._item("n1", 11.0, "h2", base_rev=2)]).get_json()["results"][0]
        self.assertEqual((same["status"], same["rev"]), ("unchanged", 2))
        pulled = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 50, "cursor": "synced_at"},
            headers={"X-CSRF-Token": self.csrf},
        ).get_json()
        self.assertEqual(pulled["items"][0]["rev"], 2)
        unchanged = self.client.post(
            "/api/sync/pull",
            json={"since": 0, "limit": 50, "cursor": "synced_at", "known_hashes": {"n1": "h2"}},
            headers={"X-CSRF-Token": self.csrf},
        ).get_json()
        self.assertTrue(unchanged["items"][0]["unchanged"])
        self.assertEqual(unchanged["items"][0]["rev"], 2)

    def test_stale_base_rev_returns_conflict_with_server_copy_and_writes_nothing(self):
        # Device A and B both start from rev 1.
        self._push([self._item("n1", 10.0, "h1", data="BASE")])
        # B writes first (rev 2) ...
        self._push([self._item("n1", 20.0, "h-b", data="FROM-B", base_rev=1)])
        # ... A pushes its offline edit with a *newer* clock but an old base_rev.
        res = self._push([self._item("n1", 30.0, "h-a", data="FROM-A", base_rev=1)]).get_json()
        row = res["results"][0]
        self.assertEqual(row["status"], "conflict")
        self.assertEqual(row["rev"], 2)
        self.assertEqual(res["conflicts"], 1)
        self.assertEqual(row["server_item"]["content_hash"], "h-b")
        self.assertIn("FROM-B", row["server_item"]["ciphertext"])
        self.assertEqual(row["server_item"]["rev"], 2)
        stored = self._stored("n1")
        self.assertEqual(stored["content_hash"], "h-b", "a conflicting write never replaces the server copy")
        # After the client resolved it, a push with the current base_rev wins
        # even with an older clock.
        res = self._push([self._item("n1", 5.0, "h-merged", data="MERGED", base_rev=2)]).get_json()
        self.assertEqual(res["results"][0]["status"], "ok")
        self.assertEqual(res["results"][0]["rev"], 3)
        stored = self._stored("n1")
        self.assertEqual(stored["content_hash"], "h-merged")
        self.assertEqual(stored["rev"], 3)
        self.assertGreaterEqual(stored["updated_at"], 20.0, "ordering clock never moves backwards for legacy readers")

    def test_matching_base_rev_beats_a_slow_client_clock(self):
        self._push([self._item("n1", 1000.0, "h1")])
        res = self._push([self._item("n1", 900.0, "h2", base_rev=1)]).get_json()
        self.assertEqual(res["results"][0]["status"], "ok")
        self.assertEqual(self._stored("n1")["content_hash"], "h2")

    def test_legacy_client_without_base_rev_keeps_last_writer_wins(self):
        self._push([self._item("n1", 200.0, "new")])
        res = self._push([self._item("n1", 100.0, "old")]).get_json()
        self.assertEqual(res["results"][0]["status"], "stale")
        self.assertEqual(res["results"][0]["rev"], 1)
        self.assertEqual(self._stored("n1")["content_hash"], "new")
        res = self._push([self._item("n1", 300.0, "newer")]).get_json()
        self.assertEqual(res["results"][0]["status"], "ok")
        self.assertEqual(res["results"][0]["rev"], 2)

    def test_future_client_clock_is_clamped(self):
        far = time.time() + 365 * 86400
        res = self._push([self._item("n1", far, "h1")]).get_json()["results"][0]
        self.assertLess(res["updated_at"], time.time() + 600)
        self.assertLess(self._stored("n1")["updated_at"], time.time() + 600)

    def test_existing_rows_start_at_rev_one_after_migration(self):
        conn = self.db.connection()
        # Rebuild the pre-upgrade shape: no rev column, one existing row.
        conn.execute("ALTER TABLE items DROP COLUMN rev")
        conn.execute(
            """
            INSERT INTO items (user_id, item_uuid, content_version, ciphertext, content_hash,
                               deleted, updated_at, synced_at)
            VALUES (?, 'legacy', 1, 'ct', 'h', 0, 1.0, 1.0)
            """,
            (self.uid,),
        )
        conn.commit()
        self.db.init_schema(conn)
        conn.commit()
        self.assertEqual(self._stored("legacy")["rev"], 1)
        res = self._push([self._item("legacy", 2.0, "h2", base_rev=1)]).get_json()["results"][0]
        self.assertEqual((res["status"], res["rev"]), ("ok", 2))


if __name__ == "__main__":
    unittest.main()
