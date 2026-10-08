"""Per-user upload directory layout and migration."""
import importlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _fresh_modules():
    for name in list(sys.modules):
        if name in {"config", "db", "uploads"}:
            sys.modules.pop(name, None)
    import db as notes_db
    import uploads as up

    return notes_db, up


class UploadDirTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ["NOTES_ROOT"] = str(root)
        os.environ["NOTES_DATA"] = str(root / "data")
        os.environ["NOTES_KEYS"] = str(root / "keys")
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        self.notes_db, self.uploads = _fresh_modules()
        self.notes_db.init_schema()
        self.uploads_root = root / "data" / "uploads"
        self.uploads_root.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS"):
            os.environ.pop(key, None)

    def test_colliding_emails_use_distinct_user_id_dirs(self):
        from uploads import email_fs_name, user_upload_dir

        email_a = "a+b@collision.test"
        email_b = "a_b@collision.test"
        self.assertEqual(email_fs_name(email_a), email_fs_name(email_b))
        uid_a = self.notes_db.create_user_srp(
            email_a,
            "salt-a",
            "srp-salt-a",
            "1" * 64,
        )
        uid_b = self.notes_db.create_user_srp(
            email_b,
            "salt-b",
            "srp-salt-b",
            "2" * 64,
        )
        dir_a = user_upload_dir(uid_a)
        dir_b = user_upload_dir(uid_b)
        self.assertNotEqual(dir_a, dir_b)
        self.assertEqual(dir_a.name, str(uid_a))
        self.assertEqual(dir_b.name, str(uid_b))

    def test_migration_moves_single_owner_legacy_dir(self):
        from uploads import email_fs_name, migrate_email_named_upload_dirs, user_upload_dir

        email = "legacy-migrate@collision.test"
        uid = self.notes_db.create_user_srp(email, "salt", "srp-salt", "3" * 64)
        from uploads import user_upload_dir

        shutil.rmtree(user_upload_dir(uid), ignore_errors=True)
        legacy = self.uploads_root / email_fs_name(email)
        legacy.mkdir(parents=True)
        marker = legacy / "device-reports" / "marker.txt"
        marker.parent.mkdir(parents=True)
        marker.write_text("migrated", encoding="utf-8")
        self.uploads._migration_done = False

        migrate_email_named_upload_dirs()
        target = user_upload_dir(uid)
        self.assertTrue(target.is_dir())
        self.assertFalse(legacy.exists())
        migrated_marker = target / "device-reports" / "marker.txt"
        self.assertEqual(migrated_marker.read_text(encoding="utf-8"), "migrated")

    def test_migration_leaves_colliding_legacy_dir(self):
        from uploads import email_fs_name, migrate_email_named_upload_dirs

        self.assertEqual(email_fs_name("p+lus@collision.test"), email_fs_name("p_lus@collision.test"))

        self.notes_db.create_user_srp("p+lus@collision.test", "s1", "ss1", "4" * 64)
        self.notes_db.create_user_srp("p_lus@collision.test", "s2", "ss2", "5" * 64)
        legacy = self.uploads_root / email_fs_name("p+lus@collision.test")
        legacy.mkdir(parents=True)
        (legacy / "keep.txt").write_text("stay", encoding="utf-8")
        self.uploads._migration_done = False

        migrate_email_named_upload_dirs()
        self.assertTrue(legacy.is_dir())
        self.assertEqual((legacy / "keep.txt").read_text(encoding="utf-8"), "stay")

    def test_purge_removes_only_target_user_dir(self):
        from uploads import user_upload_dir

        uid_a = self.notes_db.create_user_srp("purge-a@test", "s1", "ss1", "6" * 64)
        uid_b = self.notes_db.create_user_srp("purge-b@test", "s2", "ss2", "7" * 64)
        dir_a = user_upload_dir(uid_a)
        dir_b = user_upload_dir(uid_b)
        (dir_a / "touch.txt").write_text("a", encoding="utf-8")
        (dir_b / "touch.txt").write_text("b", encoding="utf-8")

        self.notes_db.purge_user_data(uid_a)
        self.assertFalse(dir_a.exists())
        self.assertTrue(dir_b.is_dir())
        self.assertEqual((dir_b / "touch.txt").read_text(encoding="utf-8"), "b")


if __name__ == "__main__":
    unittest.main()
