"""pCloud credential storage must never persist account passwords or plaintext tokens."""
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

TEST_PCLOUD_KEY = "aa" * 32


class PcloudCredentialSecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = TEST_PCLOUD_KEY
        (root / "keys").mkdir(parents=True)
        for name in list(sys.modules):
            if name in {"config", "pcloud_credentials", "backup_pcloud"}:
                sys.modules.pop(name, None)
        self.config = importlib.import_module("config")
        self.pc = importlib.import_module("pcloud_credentials")
        self.backup_pcloud = importlib.import_module("backup_pcloud")

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_PCLOUD_CREDENTIALS_KEY"):
            os.environ.pop(key, None)

    def test_token_encrypted_on_disk_not_plain_json(self):
        token = '{"access_token":"secret-access-value","token_type":"bearer"}'
        self.config.write_pcloud_token(7, token)
        path = self.config.pcloud_token_path(7)
        raw = path.read_text(encoding="utf-8")
        self.assertTrue(raw.startswith("dg-pcloud-v1:"))
        self.assertNotIn("secret-access-value", raw)
        self.assertEqual(self.config.pcloud_token(7), token)

    def test_legacy_plaintext_token_migrated_on_save(self):
        path = self.config.pcloud_token_path(3)
        legacy = '{"access_token":"migrate-me","token_type":"bearer"}'
        path.write_text(legacy, encoding="utf-8")
        self.pc.migrate_token_file(path)
        raw = path.read_text(encoding="utf-8")
        self.assertTrue(raw.startswith("dg-pcloud-v1:"))
        self.assertNotIn("migrate-me", raw)

    def test_legacy_password_file_removed_on_settings_save(self):
        keys = Path(os.environ["NOTES_KEYS"])
        legacy = keys / "pcloud-password-5"
        legacy.write_text("plaintext-pcloud-password", encoding="utf-8")
        with mock.patch.object(self.backup_pcloud.db, "update_pcloud_settings"):
            self.backup_pcloud.save_pcloud_settings(
                5,
                username="u@pcloud.test",
                remote_path="Deeperguard/backups",
                region="eu",
                enabled=False,
                rclone_token='{"access_token":"tok","token_type":"bearer"}',
            )
        self.assertFalse(legacy.is_file())
        self.pc.assert_keys_dir_has_no_plaintext_passwords(keys)

    def test_password_in_settings_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            self.backup_pcloud.save_pcloud_settings(
                1,
                username="u@pcloud.test",
                remote_path="Deeperguard/backups",
                region="eu",
                enabled=True,
                password="no-store",
            )
        self.assertIn("no longer stored", str(ctx.exception))

    def test_write_rclone_config_does_not_persist_token_file(self):
        token = '{"access_token":"rclone-token-value","token_type":"bearer"}'
        self.config.write_pcloud_token(9, token)
        path = self.backup_pcloud.write_rclone_config(9, "eu")
        try:
            text = path.read_text(encoding="utf-8")
            self.assertIn("type = pcloud", text)
            self.assertIn("rclone-token-value", text)
            persisted = self.config.pcloud_rclone_config_path(9)
            self.assertFalse(persisted.is_file())
        finally:
            path.unlink(missing_ok=True)
        stored = self.config.pcloud_token_path(9).read_text(encoding="utf-8")
        self.assertNotIn("rclone-token-value", stored)


if __name__ == "__main__":
    unittest.main()
