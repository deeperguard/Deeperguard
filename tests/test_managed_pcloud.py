"""Managed pCloud backup: service remote, health check, per-user directory."""
import importlib
import logging
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

SECRET = "FAKE-SECRET-TOKEN-xyz123"
ENV_KEYS = (
    "NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_PCLOUD_CREDENTIALS_KEY",
    "NOTES_PCLOUD_SERVICE_REMOTE", "NOTES_PCLOUD_SERVICE_ROOT",
    "NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", "PATH",
)


class ManagedPcloudTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = "cc" * 32
        for k in ("NOTES_PCLOUD_SERVICE_REMOTE", "NOTES_PCLOUD_SERVICE_ROOT",
                  "NOTES_PCLOUD_SERVICE_RCLONE_CONFIG"):
            os.environ.pop(k, None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.argv_log = root / "argv.log"
        for name in list(sys.modules):
            if name in {"config", "db", "backup_mail", "backup_cron", "backup_pcloud", "mailer"}:
                sys.modules.pop(name, None)
        self.bp = importlib.import_module("backup_pcloud")
        self.db = importlib.import_module("db")
        self.db.init_schema()

    def tearDown(self):
        self.tmp.cleanup()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _fake_rclone(self, script: str):
        path = self.bin / "rclone"
        path.write_text("#!/bin/sh\n" + script)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        os.environ["PATH"] = str(self.bin) + ":" + self.saved["PATH"]

    def _user(self, email):
        conn = self.db.connection()
        conn.execute(
            "INSERT INTO users (email, password_hash, kdf_salt, created_at, updated_at) "
            "VALUES (?, 'x', 's', 1, 1)", (email,))
        conn.commit()
        return conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()[0]

    def test_unavailable_without_remote(self):
        res = self.bp.managed_healthcheck()
        self.assertFalse(res["available"])
        self.assertEqual(res["reason_code"], "not_configured")

    def test_invalid_remote_name_is_not_set(self):
        for bad in ("a:b", "-x", "a/b", "a b", "", "a" * 40):
            os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = bad
            self.assertEqual(self.bp.config.pcloud_service_remote(), "")

    def test_root_validation(self):
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        self.assertEqual(self.bp.config.pcloud_service_root(), "Deeperguard/users")
        os.environ["NOTES_PCLOUD_SERVICE_ROOT"] = "a/../b"
        self.assertEqual(self.bp.config.pcloud_service_root(), "")

    def test_healthcheck_ok_and_argv(self):
        self._fake_rclone('echo "$@" >> "' + str(self.argv_log) + '"\nexit 0\n')
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        os.environ["NOTES_PCLOUD_SERVICE_RCLONE_CONFIG"] = "/etc/rc.conf"
        self.assertTrue(self.bp.managed_healthcheck()["available"])
        self.assertIn("--config /etc/rc.conf lsf svc:Deeperguard/users/__healthcheck",
                      self.argv_log.read_text())

    def test_no_config_flag_when_unset(self):
        self._fake_rclone('echo "$@" >> "' + str(self.argv_log) + '"\nexit 0\n')
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        self.bp.managed_healthcheck()
        self.assertNotIn("--config", self.argv_log.read_text())

    def test_missing_rclone_binary_is_unavailable(self):
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        os.environ["PATH"] = str(self.bin)  # empty dir
        res = self.bp.managed_healthcheck()
        self.assertEqual(res, {"available": False, "reason_code": "rclone_missing"})

    def test_stderr_secret_never_leaks(self):
        self._fake_rclone('echo "boom ' + SECRET + ' token" >&2\nexit 1\n')
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        with self.assertLogs("deeperguard.backup.pcloud", level=logging.DEBUG) as cm:
            res = self.bp.managed_healthcheck()
        self.assertFalse(res["available"])
        self.assertEqual(res["reason_code"], "remote_unavailable")
        self.assertNotIn(SECRET, repr(res))
        self.assertNotIn(SECRET, "\n".join(cm.output))
        with self.assertRaises(self.bp.ManagedBackupError) as ctx:
            self.bp._run_managed_rclone(["lsf", "svc:x"], timeout=10)
        self.assertNotIn(SECRET, str(ctx.exception))
        self.assertIsNone(ctx.exception.__cause__)

    def test_quota_and_timeout_codes(self):
        self._fake_rclone('echo "Over quota" >&2\nexit 1\n')
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        with self.assertRaises(self.bp.ManagedBackupError) as ctx:
            self.bp._run_managed_rclone(["copy"], timeout=10)
        self.assertEqual(ctx.exception.code, "quota")
        self._fake_rclone("sleep 5\n")
        with self.assertRaises(self.bp.ManagedBackupError) as ctx:
            self.bp._run_managed_rclone(["copy"], timeout=1)
        self.assertEqual(ctx.exception.code, "timeout")

    def test_distinct_random_dirs_per_user(self):
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        a, b = self._user("a@x.test"), self._user("b@x.test")
        ida, idb = self.db.enable_managed_backup(a), self.db.enable_managed_backup(b)
        self.assertNotEqual(ida, idb)
        self.assertRegex(ida, r"^[0-9a-f]{32}$")
        self.assertEqual(self.db.enable_managed_backup(a), ida)  # stable
        pa = self.bp.user_backup_path(self.db.get_user_by_id(a))
        pb = self.bp.user_backup_path(self.db.get_user_by_id(b))
        self.assertEqual(pa, "Deeperguard/users/" + ida)
        self.assertNotIn("a@x.test", pa)
        self.assertNotEqual(pa, pb)
        self.assertFalse(pb.startswith(pa + "/") or pa.startswith(pb + "/"))

    def test_bad_ids_refused(self):
        for bad in ("", "..", "../x", "a/b", "x\\y", "%2e%2e", "a" * 31, "a" * 33,
                    "A" * 32, "a" * 31 + "\x00", "a" * 32 + "\n", "a" * 30 + "/.", None):
            with self.assertRaises(self.bp.ManagedBackupError, msg=repr(bad)):
                self.bp.user_backup_path({"pcloud_dir_id": bad})
        with self.assertRaises(self.bp.ManagedBackupError):
            self.bp.user_backup_path({})

    def test_migration_idempotent_and_keeps_tokens(self):
        uid = self._user("t@x.test")
        self.db.update_pcloud_settings(uid, "pcuser", "Deeperguard/backups", "eu", True)
        self.bp.write_pcloud_token(uid, '{"access_token":"t"}')
        self.db.init_schema()
        self.db.init_schema()
        row = self.db.get_user_by_id(uid)
        self.assertEqual(row["pcloud_username"], "pcuser")
        self.assertEqual(row["pcloud_enabled"], 1)
        self.assertEqual(row["managed_backup_enabled"], 0)
        self.assertEqual(row["pcloud_dir_id"], "")
        self.assertTrue(self.bp.pcloud_token_set(uid))


if __name__ == "__main__":
    unittest.main()
