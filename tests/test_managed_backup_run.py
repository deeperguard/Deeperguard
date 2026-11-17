"""Managed pCloud backup run: isolation, retention, status, content, plan limit."""
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
    "NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", "PATH", "FAKE_FAIL_DIR", "FAKE_ARGV_LOG",
)
PLAINTEXT = "my secret plaintext note"
VAULT_PASSWORD_HASH = "argon2-hash-SECRET"


class ManagedRunTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        self.addCleanup(self._restore_env)
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        os.environ.update(
            NOTES_ROOT=str(root), NOTES_DATA=str(root / "data"), NOTES_KEYS=str(root / "keys"),
            NOTES_PCLOUD_CREDENTIALS_KEY="cc" * 32, NOTES_PCLOUD_SERVICE_REMOTE="svc",
        )
        os.environ.pop("NOTES_PCLOUD_SERVICE_ROOT", None)
        os.environ.pop("NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", None)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.argv_log = root / "argv.log"
        self.uploads = root / "uploads"
        self.uploads.mkdir()
        os.environ["FAKE_ARGV_LOG"] = str(self.argv_log)
        os.environ.pop("FAKE_FAIL_DIR", None)
        for name in list(sys.modules):
            if name in {"config", "db", "backup_mail", "backup_cron", "backup_pcloud", "mailer", "plans"}:
                sys.modules.pop(name, None)
        self.bp = importlib.import_module("backup_pcloud")
        self.cron = importlib.import_module("backup_cron")
        self.db = importlib.import_module("db")
        self.db.init_schema()
        self._fake_rclone()

    def tearDown(self):
        self.tmp.cleanup()

    def _restore_env(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _fake_rclone(self):
        up = self.uploads
        script = f"""#!/bin/sh
echo "$@" >> "$FAKE_ARGV_LOG"
for a in "$@"; do
  case "$a" in *"$FAKE_FAIL_DIR"*) [ -n "$FAKE_FAIL_DIR" ] && {{ echo "secret stderr 401" >&2; exit 1; }};; esac
done
cmd="$1"
if [ "$cmd" = "copyto" ]; then
  d=$(echo "$3" | sed 's/^svc://' | tr '/' '_')
  cp "$2" "{up}/$d"
elif [ "$cmd" = "lsf" ]; then
  d=$(echo "$2" | sed 's/^svc://' | tr '/' '_')
  ls "{up}" | grep "^$d" | sed "s/^$d\\///" | sed "s/^${{d}}_//" | grep '^backup-' || true
fi
exit 0
"""
        path = self.bin / "rclone"
        path.write_text(script)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        os.environ["PATH"] = str(self.bin) + ":" + self.saved["PATH"]

    def _user(self, email, plan="pro", managed=True):
        conn = self.db.connection()
        conn.execute(
            "INSERT INTO users (email, password_hash, kdf_salt, plan, created_at, updated_at) "
            "VALUES (?, ?, 'salt', ?, 1, 1)", (email, VAULT_PASSWORD_HASH, plan))
        conn.commit()
        uid = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()[0]
        if managed:
            self.db.enable_managed_backup(uid)
        self.db.upsert_item(uid, f"item-{uid}", "CIPHERTEXT-" + str(uid), 1, "h", False, 5.0)
        return uid

    def _argv(self):
        return self.argv_log.read_text().splitlines() if self.argv_log.exists() else []

    def test_only_enabled_and_plan_allowed_users_upload_to_own_dir(self):
        a = self._user("a@x.test")
        free = self._user("free@x.test", plan="free")
        off = self._user("off@x.test", managed=False)
        results = {r["user_id"]: r for r in self.bp.run_managed_backups()}
        self.assertTrue(results[a]["ok"])
        self.assertEqual(results[free]["code"], "plan")
        self.assertNotIn(off, results)
        ida = self.db.get_user_by_id(a)["pcloud_dir_id"]
        copies = [l for l in self._argv() if l.startswith("copyto")]
        self.assertEqual(len(copies), 1)
        self.assertIn(f"svc:Deeperguard/users/{ida}/backup-", copies[0])
        for line in self._argv():
            self.assertNotIn("free@x.test", line)
            self.assertNotIn("a@x.test", line)
        self.assertEqual(self.db.get_user_by_id(free)["pcloud_last_sync_status"], "skipped")

    def test_failure_for_a_does_not_stop_b_and_status_is_stored(self):
        a, b = self._user("a@x.test"), self._user("b@x.test")
        os.environ["FAKE_FAIL_DIR"] = self.db.get_user_by_id(a)["pcloud_dir_id"]
        results = {r["user_id"]: r for r in self.bp.run_managed_backups()}
        self.assertFalse(results[a]["ok"])
        self.assertTrue(results[b]["ok"])
        ua, ub = self.db.get_user_by_id(a), self.db.get_user_by_id(b)
        self.assertEqual(ua["pcloud_last_sync_status"], "error")
        self.assertEqual(ua["pcloud_last_sync_detail"], results[a]["code"])
        self.assertNotIn("secret", ua["pcloud_last_sync_detail"])
        self.assertGreater(ua["pcloud_last_sync_at"], 0)
        self.assertEqual(ub["pcloud_last_sync_status"], "ok")
        self.assertGreater(ub["pcloud_last_size"], 0)
        self.assertEqual(ub["pcloud_last_kept"], 1)
        # next run retries A
        os.environ.pop("FAKE_FAIL_DIR")
        again = {r["user_id"]: r for r in self.bp.run_managed_backups()}
        self.assertTrue(again[a]["ok"])
        self.assertEqual(self.db.get_user_by_id(a)["pcloud_last_sync_status"], "ok")

    def test_retention_is_per_user_directory(self):
        a, b = self._user("a@x.test"), self._user("b@x.test")
        self.bp.run_managed_backups()
        ida = self.db.get_user_by_id(a)["pcloud_dir_id"]
        idb = self.db.get_user_by_id(b)["pcloud_dir_id"]
        deletes = [l for l in self._argv() if l.startswith("delete")]
        self.assertEqual(len(deletes), 2)
        self.assertTrue(any(f"/{ida} " in l + " " for l in deletes))
        self.assertTrue(any(f"/{idb} " in l + " " for l in deletes))
        for l in deletes:
            self.assertIn("--min-age 7d", l)
            self.assertIn("--include backup-*.enc.json.gz", l)
            self.assertEqual(l.count("svc:"), 1)  # exactly one directory targeted
        self.assertFalse(any(l.rstrip().endswith("Deeperguard/users") for l in self._argv()))

    def test_archive_contains_only_ciphertext_export_list(self):
        a = self._user("a@x.test")
        self.db.upsert_item(a, "doc", "CT2", 1, "h2", False, 6.0, "BLOBCT")
        path, count, _ = self.bp.write_managed_archive(a, Path(self.tmp.name))
        raw = gzip.open(path, "rt").read()
        data = json.loads(raw)
        self.assertEqual(tuple(sorted(data)), self.bp.MANAGED_TOP_LEVEL_KEYS)
        self.assertEqual(count, 2)
        for item in data["items"]:
            self.assertEqual(tuple(sorted(item)), self.bp.MANAGED_ITEM_KEYS)
        for forbidden in ("a@x.test", VAULT_PASSWORD_HASH, PLAINTEXT, "password", "user_email",
                          "recovery", "totp", "token", "session"):
            self.assertNotIn(forbidden, raw)

    def test_legacy_token_user_without_managed_flag_keeps_old_flow(self):
        uid = self._user("own@x.test", managed=False)
        conn = self.db.connection()
        conn.execute("UPDATE users SET pcloud_enabled = 1, pcloud_username = 'u' WHERE id = ?", (uid,))
        conn.commit()
        called = []
        self.bp.sync_user_backup = lambda u: called.append(u) or {}
        self.bp.pcloud_credentials_configured = lambda u: True
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        self.assertEqual(called, [uid])
        self.assertEqual(self.bp.run_managed_backups(), [])

    def test_managed_user_skipped_by_legacy_flow(self):
        uid = self._user("m@x.test")
        conn = self.db.connection()
        conn.execute("UPDATE users SET pcloud_enabled = 1, pcloud_username = 'u' WHERE id = ?", (uid,))
        conn.commit()
        self.bp.sync_user_backup = lambda u: self.fail("legacy flow must not run")
        self.bp.pcloud_credentials_configured = lambda u: True
        self.assertEqual(self.bp.run_pcloud_backups(), 0)

    def test_unavailable_remote_fails_all_with_code_and_cron_exposes_results(self):
        a = self._user("a@x.test")
        os.environ.pop("NOTES_PCLOUD_SERVICE_REMOTE")
        self.cron.run_backups()
        res = self.cron.LAST_MANAGED_RESULTS
        self.assertEqual([r["user_id"] for r in res], [a])
        self.assertEqual(res[0]["code"], "not_configured")
        self.assertEqual(self.db.get_user_by_id(a)["pcloud_last_sync_status"], "error")


class ManagedMailTests(ManagedRunTests):
    def setUp(self):
        super().setUp()
        self.sent = []
        self.bp.send_plain_email = lambda to, subj, body: self.sent.append((to, subj, body))

    def _run(self):
        self.cron.run_backups()

    def test_one_mail_per_run_success_and_failure(self):
        a, b = self._user("a@x.test"), self._user("b@x.test")
        os.environ["FAKE_FAIL_DIR"] = self.db.get_user_by_id(b)["pcloud_dir_id"]
        self._run()
        by = {to: (s, body) for to, s, body in self.sent}
        self.assertEqual(len(self.sent), 2)
        self.assertIn("succeeded", by["a@x.test"][0])
        self.assertIn("Backups kept: 1", by["a@x.test"][1])
        self.assertIn("failed", by["b@x.test"][0])

    def test_no_mail_to_unverified_address(self):
        a = self._user("a@x.test")
        conn = self.db.connection()
        conn.execute("UPDATE users SET email_verified = 0 WHERE id = ?", (a,))
        conn.commit()
        self._run()
        self.assertEqual(self.sent, [])

    def test_failures_only_preference(self):
        a, b = self._user("a@x.test"), self._user("b@x.test")
        self.db.set_pcloud_mail_pref(a, True)
        self.db.set_pcloud_mail_pref(b, True)
        os.environ["FAKE_FAIL_DIR"] = self.db.get_user_by_id(b)["pcloud_dir_id"]
        self._run()
        self.assertEqual([m[0] for m in self.sent], ["b@x.test"])
        self.assertEqual(self.db.get_user_by_id(a)["pcloud_mail_pref"], "failures")

    def test_default_pref_is_both(self):
        a = self._user("a@x.test")
        self.assertEqual(self.db.get_user_by_id(a)["pcloud_mail_pref"], "both")

    def test_mail_failure_does_not_break_run(self):
        self._user("a@x.test")
        def boom(*a):
            raise OSError("smtp down")
        self.bp.send_plain_email = boom
        self.assertEqual(self._run(), None)
        self.assertEqual(len(self.cron.LAST_MANAGED_RESULTS), 1)

    def test_mail_has_no_forbidden_strings(self):
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "fakeremote"
        a = self._user("a@x.test")
        did = self.db.get_user_by_id(a)["pcloud_dir_id"]
        os.environ["FAKE_FAIL_DIR"] = did
        results = [
            {"user_id": a, "ok": False, "code": c, "size": 0, "kept": 0, "at": 1.0}
            for c in ("upload_failed", "quota", "timeout", "plan", "remote_unavailable")
        ] + [{"user_id": a, "ok": True, "code": "ok", "size": 2048, "kept": 3, "at": 1.0}]
        for r in results:
            subj, body = self.bp.managed_result_mail(r)
            text = subj + body
            for bad in ("fakeremote", "Deeperguard/users", did, "/tmp", "Traceback",
                        "secret stderr", "rclone", "401", "token", "/"):
                self.assertNotIn(bad, text.replace("UTC", ""))


if __name__ == "__main__":
    unittest.main()
