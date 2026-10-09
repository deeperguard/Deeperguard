"""Tests for encrypted email and pCloud backup helpers."""
import importlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))


class BackupHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        for name in list(sys.modules):
            if name in {"config", "db", "backup_mail", "backup_cron", "backup_pcloud", "mailer"}:
                sys.modules.pop(name, None)
        self.backup_mail = importlib.import_module("backup_mail")
        self.backup_cron = importlib.import_module("backup_cron")
        self.backup_pcloud = importlib.import_module("backup_pcloud")
        self.db = importlib.import_module("db")

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS"):
            os.environ.pop(key, None)

    def test_compact_payload_drops_large_items(self):
        payload = {
            "format": "deeperguard-backup-v1",
            "items": [
                {"item_uuid": "small", "ciphertext": "note"},
                {"item_uuid": "big", "ciphertext": "D" * 250_000},
            ],
        }
        out = self.backup_mail.compact_payload(payload)
        self.assertTrue(out["email_compact"])
        self.assertEqual(out["item_count"], 1)
        self.assertEqual(out["items"][0]["item_uuid"], "small")
        self.assertEqual(out["attachments_omitted"], 1)
        self.assertLessEqual(len(self.backup_mail.gzip_json(out)), self.backup_mail.EMAIL_ATTACHMENT_MAX)

    def test_users_with_backup_enabled_allows_empty_email(self):
        conn = self.db.connection()
        now = time.time()
        conn.execute(
            """
            INSERT INTO users (email, password_hash, kdf_salt, backup_enabled, backup_email, created_at, updated_at)
            VALUES ('owner@home.local', 'x', 'salt', 1, '', ?, ?)
            """,
            (now, now),
        )
        conn.commit()
        rows = self.db.users_with_backup_enabled()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["email"], "owner@home.local")

    def test_run_backups_syncs_pcloud_before_email(self):
        order = []

        def pcloud():
            order.append("pcloud")
            return 1

        def email(_uid, _recipient):
            order.append("email")
            return {}

        with patch.object(self.backup_cron, "run_pcloud_backups", side_effect=pcloud), patch.object(
            self.backup_cron, "send_user_backup", side_effect=email
        ), patch.object(
            self.backup_cron.db,
            "users_with_backup_enabled",
            return_value=[{"id": 1, "email": "owner@home.local", "backup_email": ""}],
        ):
            sent, synced = self.backup_cron.run_backups()
        self.assertEqual(order, ["pcloud", "email"])
        self.assertEqual(sent, 1)
        self.assertEqual(synced, 1)

    def test_run_backups_keeps_pcloud_when_email_raises(self):
        order = []

        def pcloud():
            order.append("pcloud")
            return 1

        def email(_uid, _recipient):
            order.append("email")
            raise RuntimeError("smtp down")

        with patch.object(self.backup_cron, "run_pcloud_backups", side_effect=pcloud), patch.object(
            self.backup_cron, "send_user_backup", side_effect=email
        ), patch.object(
            self.backup_cron.db,
            "users_with_backup_enabled",
            return_value=[{"id": 1, "email": "owner@home.local", "backup_email": "a@b.c"}],
        ), patch.object(self.backup_cron.db, "log_backup"):
            sent, synced = self.backup_cron.run_backups()
        self.assertEqual(order, ["pcloud", "email"])
        self.assertEqual(sent, 0)
        self.assertEqual(synced, 1)

    def test_prepare_email_backup_reuses_recent_full_and_stays_compact(self):
        backups = Path(os.environ["NOTES_DATA"]) / "backups"
        backups.mkdir(parents=True)
        full = backups / "user-1-20260830-100000-full.enc.json.gz"
        full.write_bytes(b"x" * (self.backup_mail.EMAIL_ATTACHMENT_MAX + 50))
        os.utime(full, None)

        compact = {
            "format": "deeperguard-backup-v1",
            "items": [{"item_uuid": "n1", "ciphertext": "tiny"}],
            "item_count": 1,
            "email_compact": True,
            "attachments_omitted": 3,
        }
        with patch.object(self.backup_mail, "write_local_full_backup_streaming") as writer, patch.object(
            self.backup_mail, "compact_payload_streaming", return_value=compact
        ):
            meta = self.backup_mail.prepare_email_backup(1)
        writer.assert_not_called()
        self.assertTrue(meta["compact"])
        self.assertEqual(meta["item_count"], 1)
        self.assertEqual(meta["omitted"], 3)
        self.assertEqual(meta["local_path"], str(full))

    def test_prepare_email_backup_does_not_export_full_payload(self):
        compact = {
            "format": "deeperguard-backup-v1",
            "items": [],
            "item_count": 0,
            "email_compact": True,
            "attachments_omitted": 0,
        }
        with patch.object(
            self.backup_mail, "ensure_local_full_backup", return_value=(Path("/tmp/full.enc.json.gz"), 2, 9_000_000)
        ), patch.object(
            self.backup_mail, "compact_payload_streaming", return_value=compact
        ):
            meta = self.backup_mail.prepare_email_backup(1)
        self.assertTrue(meta["compact"])


    def test_pcloud_upload_uses_copy_not_full_dir_sync(self):
        calls = []
        local = Path(self.tmp.name) / "data" / "backups" / "user-3-20260916-120000-full.enc.json.gz"
        local.parent.mkdir(parents=True)
        local.write_bytes(b"gzip")

        def fake_run(cmd, **kwargs):
            calls.append(list(cmd))
            class Proc:
                returncode = 0
                stdout = ""
                stderr = ""

            return Proc()

        with patch.object(self.backup_pcloud, "ensure_local_full_backup", return_value=(local, 2, 99)), patch.object(
            self.backup_pcloud, "write_rclone_config", return_value=(Path("/tmp/rclone.conf"), False)
        ), patch.object(self.backup_pcloud, "probe_webdav_write"), patch.object(
            self.backup_pcloud, "pcloud_password", return_value="secret"), patch.object(
            self.backup_pcloud, "pcloud_credentials_configured", return_value=True), patch.object(
            self.backup_pcloud.db, "get_user_by_id", return_value={
                "id": 3,
                "email": "u@example.com",
                "pcloud_username": "u@example.com",
                "pcloud_remote_path": "Homelab/backups",
                "pcloud_region": "eu",
            }
        ), patch.object(self.backup_pcloud.db, "update_pcloud_sync_status"), patch.object(
            self.backup_pcloud.db, "log_backup"
        ), patch.object(self.backup_pcloud.subprocess, "run", side_effect=fake_run):
            self.backup_pcloud.sync_user_backup(3)

        copy_cmds = [c for c in calls if "copy" in c]
        sync_cmds = [c for c in calls if "sync" in c]
        self.assertEqual(len(copy_cmds), 1)
        self.assertEqual(sync_cmds, [])
        self.assertIn(str(local), copy_cmds[0])
        delete_cmds = [c for c in calls if "delete" in c]
        self.assertEqual(len(delete_cmds), 1)
        self.assertIn("--min-age", delete_cmds[0])
        self.assertIn("7d", delete_cmds[0])

    def test_run_pcloud_backups_emails_on_failure(self):
        sent = []

        def fail(_uid):
            raise RuntimeError("rclone timed out")

        with patch.object(self.backup_pcloud.db, "users_with_pcloud_enabled", return_value=[
            {
                "id": 1,
                "email": "owner@home.local",
                "backup_email": "backup@home.local",
                "pcloud_remote_path": "Deeperguard/backups",
            }
        ]), patch.object(self.backup_pcloud, "pcloud_password", return_value="x"), patch.object(
            self.backup_pcloud, "sync_user_backup", side_effect=fail
        ), patch.object(self.backup_pcloud, "notify_pcloud_backup_failure", side_effect=lambda u, d: sent.append((u["email"], d))):
            count = self.backup_pcloud.run_pcloud_backups()
        self.assertEqual(count, 0)
        self.assertEqual(sent, [("owner@home.local", "rclone timed out")])

    def test_normalize_pcloud_token_requires_access_token(self):
        with self.assertRaises(ValueError):
            self.backup_pcloud.normalize_pcloud_token('{"token_type":"bearer"}')
        out = self.backup_pcloud.normalize_pcloud_token('{"access_token":"abc","token_type":"bearer"}')
        self.assertIn("access_token", out)

    def test_write_rclone_config_obscure_password_via_stdin(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append((list(cmd), kwargs.get("input")))
            class Proc:
                stdout = "obscured-token"
                stderr = ""
                returncode = 0

            return Proc()

        with patch.object(self.backup_pcloud, "pcloud_token", return_value=""), patch.object(
            self.backup_pcloud, "rclone_bin", return_value="/usr/bin/rclone"
        ), patch.object(self.backup_pcloud.subprocess, "run", side_effect=fake_run), patch.object(
            self.backup_pcloud, "pcloud_rclone_config_path", return_value=Path(self.tmp.name) / "keys" / "rclone.conf"
        ):
            path, native = self.backup_pcloud.write_rclone_config(9, "user@pcloud", "s3cret!", "eu")
        self.assertFalse(native)
        self.assertTrue(path.is_file())
        self.assertEqual(calls[0][0][-2:], ["obscure", "-"])
        self.assertEqual(calls[0][1], "s3cret!")
        self.assertIn("obscured-token", path.read_text(encoding="utf-8"))

    def test_run_pcloud_backups_emails_when_password_missing(self):
        sent = []
        with patch.object(self.backup_pcloud.db, "users_with_pcloud_enabled", return_value=[
            {
                "id": 1,
                "email": "owner@home.local",
                "backup_email": "",
                "pcloud_remote_path": "Deeperguard/backups",
            }
        ]), patch.object(self.backup_pcloud, "pcloud_credentials_configured", return_value=False), patch.object(
            self.backup_pcloud, "notify_pcloud_backup_failure", side_effect=lambda u, d: sent.append((u["email"], d))
        ), patch.object(self.backup_pcloud.db, "update_pcloud_sync_status"), patch.object(
            self.backup_pcloud.db, "log_backup"
        ):
            count = self.backup_pcloud.run_pcloud_backups()
        self.assertEqual(count, 0)
        self.assertEqual(len(sent), 1)
        self.assertIn("token", sent[0][1].lower())


class BackupDeployTests(unittest.TestCase):
    def test_install_services_writes_cron_from_env_hour(self):
        install = (Path(__file__).resolve().parents[1] / "deploy" / "install-services.sh").read_text(encoding="utf-8")
        self.assertIn("NOTES_BACKUP_CRON_HOUR", install)
        self.assertIn("/etc/cron.d/deeperguard-backup", install)
        self.assertIn("backup_cron.py", install)
        self.assertIn("command -v rclone", install)
        self.assertIn("logrotate.d/deeperguard", install)
        self.assertIn("systemctl restart deeperguard-ocr.service", install)


if __name__ == "__main__":
    unittest.main()
