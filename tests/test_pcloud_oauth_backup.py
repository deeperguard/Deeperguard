"""Scheduled pCloud backup with the OAuth token from the connect flow.

A fake ``rclone`` on PATH plays pCloud: it accepts only the access tokens listed in
FAKE_PCLOUD_TOKENS, stores uploads under FAKE_PCLOUD_ROOT and answers a refused
token the way rclone prints a pCloud API error.
"""
import importlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

ENV_KEYS = (
    "NOTES_ROOT", "NOTES_DATA", "NOTES_KEYS", "NOTES_PCLOUD_CREDENTIALS_KEY",
    "NOTES_PCLOUD_SERVICE_REMOTE", "PATH", "FAKE_PCLOUD_TOKENS", "FAKE_PCLOUD_ROOT", "FAKE_PCLOUD_LOG",
)
OAUTH_TOKEN = "oauth-access-TOKEN-7b21"
LEGACY_TOKEN = "legacy-rclone-TOKEN-4410"
MODULES = {
    "config", "db", "backup_mail", "backup_cron", "backup_pcloud", "mailer",
    "pcloud_credentials", "pcloud_oauth", "plans", "maintenance_lock",
}

FAKE_RCLONE = """#!{python}
import json, os, shutil, sys
from pathlib import Path

args = sys.argv[1:]
cfg = json.loads(os.environ.get("RCLONE_CONFIG_DEEPERGUARD_TOKEN") or "{{}}")
token = cfg.get("access_token", "")
cmd = next(a for a in args if a in ("copy", "delete"))
remote = next(a for a in args if a.startswith("deeperguard:"))
with open(os.environ["FAKE_PCLOUD_LOG"], "a") as log:
    log.write(json.dumps({{"cmd": cmd, "remote": remote, "token": token,
                          "hostname": os.environ.get("RCLONE_CONFIG_DEEPERGUARD_HOSTNAME", "")}}) + "\\n")
if token not in os.environ.get("FAKE_PCLOUD_TOKENS", "").split(","):
    sys.stderr.write("ERROR : Attempt 1/2 failed: pcloud error: Invalid 'access_token' provided. (2094)\\n")
    sys.exit(1)
if cmd == "copy":
    src = Path(args[args.index("copy") + 1])
    dest = Path(os.environ["FAKE_PCLOUD_ROOT"]) / remote.split(":", 1)[1]
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dest / src.name)
"""


class PcloudOAuthBackupTests(unittest.TestCase):
    def setUp(self):
        saved = {k: os.environ.get(k) for k in ENV_KEYS}
        self.addCleanup(self._restore_env, saved)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for sub in ("keys", "data", "bin", "pcloud"):
            (root / sub).mkdir()
        self.cloud = root / "pcloud"
        self.calls_log = root / "pcloud-calls.log"
        os.environ.update(
            NOTES_ROOT=str(root), NOTES_DATA=str(root / "data"), NOTES_KEYS=str(root / "keys"),
            NOTES_PCLOUD_CREDENTIALS_KEY="cc" * 32, FAKE_PCLOUD_TOKENS=OAUTH_TOKEN,
            FAKE_PCLOUD_ROOT=str(self.cloud), FAKE_PCLOUD_LOG=str(self.calls_log),
            PATH=str(root / "bin") + os.pathsep + (saved["PATH"] or ""),
        )
        os.environ.pop("NOTES_PCLOUD_SERVICE_REMOTE", None)
        rclone = root / "bin" / "rclone"
        rclone.write_text(FAKE_RCLONE.format(python=sys.executable))
        rclone.chmod(rclone.stat().st_mode | stat.S_IEXEC)
        for name in list(sys.modules):
            if name in MODULES:
                sys.modules.pop(name, None)
        self.config = importlib.import_module("config")
        self.db = importlib.import_module("db")
        self.bp = importlib.import_module("backup_pcloud")
        self.cron = importlib.import_module("backup_cron")
        self.oauth = importlib.import_module("pcloud_oauth")
        self.db.init_schema()
        self.mails = []
        patcher = mock.patch.object(
            self.bp, "send_plain_email", side_effect=lambda to, subject, body: self.mails.append((to, subject, body))
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _restore_env(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _user(self, email="own@x.test"):
        conn = self.db.connection()
        conn.execute(
            "INSERT INTO users (email, password_hash, kdf_salt, plan, created_at, updated_at,"
            " pcloud_enabled, pcloud_username, pcloud_remote_path, pcloud_region)"
            " VALUES (?, 'hash', 'salt', 'pro', 1, 1, 1, ?, 'Deeperguard/backups', 'us')",
            (email, email),
        )
        conn.commit()
        uid = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()[0]
        self.db.upsert_item(uid, f"item-{uid}", f"CIPHERTEXT-{uid}", 1, "h", False, 5.0)
        return uid

    def _calls(self):
        if not self.calls_log.exists():
            return []
        return [json.loads(line) for line in self.calls_log.read_text().splitlines()]

    def _uploaded(self):
        return sorted(p.relative_to(self.cloud).as_posix() for p in self.cloud.rglob("*") if p.is_file())

    def test_scheduled_backup_uploads_with_oauth_token(self):
        uid = self._user()
        self.oauth.store_token(uid, OAUTH_TOKEN, "eapi.pcloud.com")
        sent, synced = self.cron.run_backups()
        self.assertEqual((sent, synced), (0, 1))
        uploaded = self._uploaded()
        self.assertEqual(len(uploaded), 1)
        self.assertRegex(uploaded[0], rf"^Deeperguard/backups/user-{uid}-.*-full\.enc\.json\.gz$")
        copies = [c for c in self._calls() if c["cmd"] == "copy"]
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0]["token"], OAUTH_TOKEN)
        # The API host pCloud named at connect time wins over the old region setting ('us').
        self.assertEqual(copies[0]["hostname"], "eapi.pcloud.com")
        user = self.db.get_user_by_id(uid)
        self.assertEqual(user["pcloud_last_sync_status"], "ok")
        self.assertEqual(self.mails, [])

    def test_refused_token_sets_reconnect_needed_and_notifies_user(self):
        uid = self._user()
        self.oauth.store_token(uid, "revoked-TOKEN-0000", "api.pcloud.com")
        sent, synced = self.cron.run_backups()
        self.assertEqual(synced, 0)
        self.assertEqual(self._uploaded(), [])
        user = self.db.get_user_by_id(uid)
        self.assertEqual(user["pcloud_last_sync_status"], self.bp.STATUS_RECONNECT)
        self.assertEqual(user["pcloud_last_sync_detail"], self.bp.RECONNECT_DETAIL)
        self.assertNotIn("revoked-TOKEN", user["pcloud_last_sync_detail"])
        self.assertEqual(len(self.mails), 1)
        to, subject, body = self.mails[0]
        self.assertEqual(to, "own@x.test")
        self.assertIn("pCloud backup failed", subject)
        self.assertIn(self.bp.RECONNECT_DETAIL, body)
        self.assertNotIn("revoked-TOKEN", body)
        log = self.db.connection().execute(
            "SELECT status, detail FROM backup_log WHERE user_id = ? ORDER BY id DESC", (uid,)
        ).fetchone()
        self.assertEqual(log["status"], "error")
        # Connecting again (new token) makes the next run succeed and clears the status.
        self.oauth.store_token(uid, OAUTH_TOKEN, "api.pcloud.com")
        self.assertEqual(self.cron.run_backups(), (0, 1))
        self.assertEqual(self.db.get_user_by_id(uid)["pcloud_last_sync_status"], "ok")

    def test_token_unreadable_with_current_key_needs_reconnect_without_calling_pcloud(self):
        uid = self._user()
        self.oauth.store_token(uid, OAUTH_TOKEN, "eapi.pcloud.com")
        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = "dd" * 32
        self.assertEqual(self.cron.run_backups(), (0, 0))
        self.assertEqual(self._calls(), [])
        user = self.db.get_user_by_id(uid)
        self.assertEqual(user["pcloud_last_sync_status"], self.bp.STATUS_RECONNECT)
        self.assertEqual(len(self.mails), 1)

    def test_job_never_reads_or_uses_the_legacy_stored_token(self):
        legacy = json.dumps({"access_token": LEGACY_TOKEN, "token_type": "bearer"})
        only_legacy = self._user("legacy@x.test")
        both = self._user("both@x.test")
        self.config.write_pcloud_token(only_legacy, legacy)
        self.config.write_pcloud_token(both, legacy)
        self.oauth.store_token(both, OAUTH_TOKEN, "eapi.pcloud.com")
        os.environ["FAKE_PCLOUD_TOKENS"] = f"{OAUTH_TOKEN},{LEGACY_TOKEN}"  # pCloud would accept both
        with mock.patch.object(self.config, "pcloud_token", wraps=self.config.pcloud_token) as legacy_reader:
            self.assertEqual(self.cron.run_backups(), (0, 1))
        legacy_reader.assert_not_called()
        self.assertEqual({c["token"] for c in self._calls()}, {OAUTH_TOKEN})
        self.assertEqual(len([c for c in self._calls() if c["cmd"] == "copy"]), 1)
        self.assertEqual(self.db.get_user_by_id(both)["pcloud_last_sync_status"], "ok")
        legacy_user = self.db.get_user_by_id(only_legacy)
        self.assertEqual(legacy_user["pcloud_last_sync_status"], self.bp.STATUS_RECONNECT)
        self.assertEqual(legacy_user["pcloud_last_sync_detail"], self.bp.NOT_CONNECTED_DETAIL)
        self.assertEqual([m[0] for m in self.mails], ["legacy@x.test"])
        # The legacy file stays readable for the migration; the job just does not use it.
        self.assertEqual(self.config.pcloud_token(only_legacy), legacy)

    def test_one_users_refused_token_does_not_stop_the_next_user(self):
        bad, good = self._user("bad@x.test"), self._user("good@x.test")
        self.oauth.store_token(bad, "revoked-TOKEN-0000", "eapi.pcloud.com")
        self.oauth.store_token(good, OAUTH_TOKEN, "eapi.pcloud.com")
        self.assertEqual(self.cron.run_backups(), (0, 1))
        self.assertEqual(self.db.get_user_by_id(bad)["pcloud_last_sync_status"], self.bp.STATUS_RECONNECT)
        self.assertEqual(self.db.get_user_by_id(good)["pcloud_last_sync_status"], "ok")
        self.assertEqual([m[0] for m in self.mails], ["bad@x.test"])


if __name__ == "__main__":
    unittest.main()
