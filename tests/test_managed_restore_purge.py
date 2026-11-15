"""Managed pCloud: own-directory list/restore, purge on switch-off/delete, retry queue."""
import gzip
import importlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

ENV_KEYS = (
    "NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_PCLOUD_CREDENTIALS_KEY",
    "NOTES_PCLOUD_SERVICE_REMOTE", "NOTES_PCLOUD_SERVICE_ROOT",
    "NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", "PATH", "FAKE_STORE", "FAKE_ARGV_LOG", "FAKE_DOWN",
)

FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_ARGV_LOG"
if [ -n "$FAKE_DOWN" ]; then echo "boom 401 token" >&2; exit 1; fi
cmd="$1"
strip() { echo "$1" | sed 's/^svc://'; }
case "$cmd" in
  lsjson)
    d="$FAKE_STORE/$(strip "$2")"
    [ -d "$d" ] || { echo "directory not found" >&2; exit 3; }
    printf '['; first=1
    for f in "$d"/*; do [ -f "$f" ] || continue
      [ $first = 1 ] || printf ','; first=0
      printf '{"Name":"%s","Size":%s}' "$(basename "$f")" "$(wc -c < "$f")"
    done
    printf ']' ;;
  copyto) mkdir -p "$(dirname "$FAKE_STORE/$(strip "$3")")"
    case "$2" in svc:*) cp "$FAKE_STORE/$(strip "$2")" "$3";; *) cp "$2" "$FAKE_STORE/$(strip "$3")";; esac ;;
  purge) d="$FAKE_STORE/$(strip "$2")"
    [ -d "$d" ] || { echo "directory not found" >&2; exit 3; }
    rm -rf "$d" ;;
  lsf|delete|mkdir|lsd) : ;;
esac
exit 0
"""


class RestorePurgeTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ.update(
            NOTES_ROOT=str(root), NOTES_DATA=str(root / "data"), NOTES_KEYS=str(root / "keys"),
            NOTES_PCLOUD_CREDENTIALS_KEY="cc" * 32, NOTES_PCLOUD_SERVICE_REMOTE="svc",
        )
        os.environ.pop("NOTES_PCLOUD_SERVICE_ROOT", None)
        os.environ.pop("NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", None)
        os.environ.pop("FAKE_DOWN", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        self.store = root / "store"
        self.store.mkdir()
        self.log = root / "argv.log"
        os.environ["FAKE_STORE"] = str(self.store)
        os.environ["FAKE_ARGV_LOG"] = str(self.log)
        binp = root / "bin"
        binp.mkdir()
        r = binp / "rclone"
        r.write_text(FAKE)
        r.chmod(r.stat().st_mode | stat.S_IEXEC)
        os.environ["PATH"] = f"{binp}:{self.saved['PATH']}"
        for name in list(sys.modules):
            if name in {"config", "db", "backup_mail", "backup_cron", "backup_pcloud", "mailer", "plans"}:
                sys.modules.pop(name, None)
        self.bp = importlib.import_module("backup_pcloud")
        self.db = importlib.import_module("db")
        self.db.init_schema()
        self.a = self._user("a@example.test")
        self.b = self._user("b@example.test")

    def tearDown(self):
        self.tmp.cleanup()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _user(self, email):
        conn = self.db.connection()
        conn.execute(
            "INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at) VALUES (?,?,?,?,?)",
            (email, "x", "salt-" + email, 1.0, 1.0),
        )
        conn.commit()
        uid = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()[0]
        self.db.enable_managed_backup(uid)
        return uid

    def _row(self, uid):
        return self.db.get_user_by_id(uid)

    def _put_backup(self, uid, stamp, items=None, salt=None):
        user = self._row(uid)
        d = self.store / self.bp.user_backup_path(user)
        d.mkdir(parents=True, exist_ok=True)
        doc = {
            "format": "deeperguard-backup-v1", "kdf_salt": salt or user["kdf_salt"],
            "exported_at": "x", "item_count": len(items or []), "items": items or [],
        }
        with gzip.open(d / f"backup-{stamp}.enc.json.gz", "wt") as fh:
            json.dump(doc, fh)

    def _item(self, uuid, ct="ct"):
        return {"item_uuid": uuid, "ciphertext": ct, "content_version": 1, "content_hash": "h",
                "deleted": False, "updated_at": 5.0, "blob_ciphertext": ""}

    # --- listing / restore isolation ---

    def test_list_only_own_directory(self):
        self._put_backup(self.a, "20261101-010101")
        self._put_backup(self.b, "20261102-020202")
        got = self.bp.list_managed_backups(self._row(self.a))
        self.assertEqual([e["id"] for e in got], ["20261101-010101"])
        self.assertEqual(set(got[0]), {"id", "at", "size"})

    def test_restore_other_users_backup_id_refused(self):
        self._put_backup(self.b, "20261102-020202", [self._item("u1")])
        with self.assertRaises(self.bp.ManagedBackupError) as ctx:
            self.bp.restore_managed_backup(self._row(self.a), "20261102-020202")
        self.assertEqual(ctx.exception.code, self.bp.ERR_BAD_ID)
        self.assertEqual(self.db.connection().execute("SELECT COUNT(*) FROM items").fetchone()[0], 0)

    def test_forged_and_traversal_ids_refused_without_rclone_copy(self):
        self._put_backup(self.a, "20261101-010101", [self._item("u1")])
        bad = ["../" + self.bp.user_backup_path(self._row(self.b)), "../../x", "20261101-010101/../..",
               "", None, 5, "20261101-010101\n", "20261101-010102", "backup-20261101-010101.enc.json.gz"]
        for bid in bad:
            with self.assertRaises(self.bp.ManagedBackupError) as ctx:
                self.bp.restore_managed_backup(self._row(self.a), bid)
            self.assertEqual(ctx.exception.code, self.bp.ERR_BAD_ID, bid)
        self.assertNotIn("copyto", self.log.read_text() if self.log.exists() else "")

    def test_restore_own_puts_ciphertext_back(self):
        self._put_backup(self.a, "20261101-010101", [self._item("u1", "CIPHER")])
        out = self.bp.restore_managed_backup(self._row(self.a), "20261101-010101")
        self.assertEqual(out["restored"], 1)
        row = self.db.connection().execute(
            "SELECT user_id, ciphertext FROM items WHERE item_uuid = 'u1'").fetchone()
        self.assertEqual((row[0], row[1]), (self.a, "CIPHER"))

    def test_restore_rejects_foreign_salt_and_extra_keys(self):
        self._put_backup(self.a, "20261101-010101", [self._item("u1")], salt="other")
        with self.assertRaises(self.bp.ManagedBackupError):
            self.bp.restore_managed_backup(self._row(self.a), "20261101-010101")
        bad = self._item("u2")
        bad["plaintext"] = "secret"
        self._put_backup(self.a, "20261101-010102", [bad])
        with self.assertRaises(self.bp.ManagedBackupError):
            self.bp.restore_managed_backup(self._row(self.a), "20261101-010102")

    def test_path_comes_only_from_stored_id(self):
        user = dict(self._row(self.a))
        for evil in ("../" + "a" * 29, "", "A" * 32, "a" * 31, "a/" + "b" * 30):
            user["pcloud_dir_id"] = evil
            with self.assertRaises(self.bp.ManagedBackupError):
                self.bp.list_managed_backups(user)

    # --- purge safety ---

    def test_purge_never_root_or_empty(self):
        for bad in ("", None, ".", "..", "/", "Deeperguard/users", "x" * 32, "../" + "a" * 29):
            with self.assertRaises(self.bp.ManagedBackupError, msg=repr(bad)):
                self.bp.purge_remote_dir(bad)
        txt = self.log.read_text() if self.log.exists() else ""
        self.assertNotIn("purge", txt)

    def test_purge_targets_only_users_dir(self):
        did = self._row(self.a)["pcloud_dir_id"]
        self._put_backup(self.a, "20261101-010101")
        self._put_backup(self.b, "20261101-010101")
        self.bp.purge_remote_dir(did)
        lines = [ln for ln in self.log.read_text().splitlines() if ln.startswith("purge")]
        self.assertEqual(lines, [f"purge svc:Deeperguard/users/{did}"])
        self.assertFalse((self.store / "Deeperguard/users" / did).exists())
        self.assertTrue((self.store / self.bp.user_backup_path(self._row(self.b))).exists())

    # --- switch off / account delete ---

    def test_switch_off_purges_then_clears_id(self):
        did = self._row(self.a)["pcloud_dir_id"]
        self._put_backup(self.a, "20261101-010101")
        self.assertEqual(self.bp.disable_managed_and_cleanup(self.a), "purged")
        row = self._row(self.a)
        self.assertEqual((row["managed_backup_enabled"], row["pcloud_dir_id"]), (0, ""))
        self.assertFalse(self.db.pcloud_cleanup_is_pending(did))

    def test_switch_off_unreachable_queues_and_keeps_id_until_retry(self):
        did = self._row(self.a)["pcloud_dir_id"]
        os.environ["FAKE_DOWN"] = "1"
        self.assertEqual(self.bp.disable_managed_and_cleanup(self.a), "pending")
        self.assertEqual(self._row(self.a)["pcloud_dir_id"], did)  # not wiped yet
        self.assertTrue(self.db.pcloud_cleanup_is_pending(did))
        os.environ.pop("FAKE_DOWN")
        self.assertEqual(self.bp.run_pending_cleanups(), 1)
        self.assertEqual(self._row(self.a)["pcloud_dir_id"], "")
        self.assertFalse(self.db.pcloud_cleanup_is_pending(did))

    def test_reenable_cancels_pending_removal(self):
        did = self._row(self.a)["pcloud_dir_id"]
        os.environ["FAKE_DOWN"] = "1"
        self.bp.disable_managed_and_cleanup(self.a)
        self.db.enable_managed_backup(self.a)
        self.assertFalse(self.db.pcloud_cleanup_is_pending(did))
        self.assertEqual(self._row(self.a)["pcloud_dir_id"], did)

    def test_account_delete_queues_and_purges_without_blocking(self):
        did = self._row(self.a)["pcloud_dir_id"]
        self._put_backup(self.a, "20261101-010101")
        os.environ["FAKE_DOWN"] = "1"
        self.assertTrue(self.db.purge_user_data(self.a))  # remote down: delete still succeeds
        self.assertIsNone(self.db.get_user_by_id(self.a))
        self.assertTrue(self.db.pcloud_cleanup_is_pending(did))
        os.environ.pop("FAKE_DOWN")
        self.assertEqual(self.bp.run_pending_cleanups(), 1)
        self.assertFalse((self.store / "Deeperguard/users" / did).exists())
        self.assertTrue((self.store / self.bp.user_backup_path(self._row(self.b)).rsplit("/", 1)[0]).exists())

    def test_account_delete_without_dir_queues_nothing(self):
        conn = self.db.connection()
        conn.execute("UPDATE users SET pcloud_dir_id = '' WHERE id = ?", (self.a,))
        conn.commit()
        self.assertTrue(self.db.purge_user_data(self.a))
        self.assertEqual(self.db.pending_pcloud_cleanups(99), [])
        self.assertNotIn("purge", self.log.read_text() if self.log.exists() else "")


if __name__ == "__main__":
    unittest.main()
