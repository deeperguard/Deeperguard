"""Scheduled pCloud backup with the OAuth token, the legacy fallback and the reconnect state.

rclone is replaced by a fake that accepts only tokens pCloud still honours, so the
test sees exactly which token, host and remote path each run uploads with.
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_pcloud_oauth as _tpo  # noqa: E402

OAUTH = "oauth-TOKEN-1111"
OAUTH_NEW = "oauth-TOKEN-2222"
LEGACY = "legacy-TOKEN-3333"
PASSWORD = "plain-PASSWORD-4444"
LEGACY_JSON = json.dumps({"access_token": LEGACY, "token_type": "bearer"})
DEFAULT_PATH = "Deeperguard/backups"


class PcloudScheduledOauthTests(unittest.TestCase):
    setUp = _tpo.PcloudOAuthTests.setUp
    tearDown = _tpo.PcloudOAuthTests.tearDown
    _user = _tpo.PcloudOAuthTests._user
    _login = _tpo.PcloudOAuthTests._login
    _start = _tpo.PcloudOAuthTests._start
    _callback = _tpo.PcloudOAuthTests._callback
    _row = _tpo.PcloudOAuthTests._row

    def _setup_backup(self, *, oauth=None, legacy=False, host="eapi.pcloud.com"):
        for name in ("backup_pcloud", "backup_mail"):
            sys.modules.pop(name, None)  # bind to this test's fresh db and config modules
        import backup_pcloud
        import config

        self.bp = backup_pcloud
        uid = self._user()
        self.notes_db.update_pcloud_settings(uid, "me@pcloud.example", DEFAULT_PATH, "us", True)
        if oauth:
            self.oauth.store_token(uid, oauth, host)
        if legacy:
            config.write_pcloud_token(uid, LEGACY_JSON)
        self.uploads, self.mails, self.refused = [], [], set()
        self.failure = None  # (stderr, stdout) of a non-refusal rclone failure, or an exception to raise
        self.local = Path(self.tmp.name) / "user-backup.enc.json.gz"
        self.local.write_bytes(b"ciphertext")

        def fake_run(cmd, **kwargs):
            env = kwargs["env"]
            token = json.loads(env["RCLONE_CONFIG_DEEPERGUARD_TOKEN"])["access_token"]
            self.uploads.append({
                "cmd": list(cmd), "token": token, "env": env,
                "host": env["RCLONE_CONFIG_DEEPERGUARD_HOSTNAME"],
            })
            if isinstance(self.failure, BaseException):
                raise self.failure
            if self.failure is not None and "copy" in cmd:
                return SimpleNamespace(returncode=1, stderr=self.failure[0], stdout=self.failure[1])
            bad = token in self.refused
            return SimpleNamespace(
                returncode=1 if bad else 0, stdout="",
                stderr="Failed to copy: 401 Unauthorized" if bad else "",
            )

        patches = [
            patch.object(backup_pcloud, "ensure_local_full_backup", return_value=(self.local, 1, 10)),
            patch.object(backup_pcloud, "rclone_bin", return_value="/usr/bin/rclone"),
            patch.object(backup_pcloud.subprocess, "run", side_effect=fake_run),
            patch.object(
                backup_pcloud, "send_plain_email",
                side_effect=lambda to, subject, body: self.mails.append((to, subject, body)),
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return uid

    def _copies(self):
        return [u for u in self.uploads if "copy" in u["cmd"]]

    def _destination(self, upload):
        cmd = upload["cmd"]
        return cmd[cmd.index("copy") + 2]

    def _account(self, uid):
        self._login(uid)
        return self.client.get("/api/account").get_json()

    def _managed(self, uid):
        self._login(uid)
        return self.client.get("/api/backup/managed").get_json()

    def _status(self, uid):
        row = self.notes_db.get_user_by_id(uid)
        return row["pcloud_last_sync_status"], row["pcloud_last_sync_detail"]

    def test_legacy_only_account_still_backs_up(self):
        uid = self._setup_backup(legacy=True)
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        copies = self._copies()
        self.assertEqual([c["token"] for c in copies], [LEGACY])
        self.assertEqual(copies[0]["host"], "api.pcloud.com")  # the user's region setting, as before
        self.assertEqual(self._status(uid)[0], "ok")
        self.assertEqual(self.mails, [])
        acct = self._account(uid)["pcloud_oauth"]
        self.assertEqual((acct["mode"], acct["state"], acct["oauth_refused"]), ("legacy", "none", False))
        self.assertEqual(self._managed(uid)["own_connection"], "legacy")

    def test_account_with_both_uploads_with_oauth_token(self):
        uid = self._setup_backup(oauth=OAUTH, legacy=True)
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        copies = self._copies()
        self.assertEqual([c["token"] for c in copies], [OAUTH])
        self.assertEqual(copies[0]["host"], "eapi.pcloud.com")  # host pCloud gave at connect time
        self.assertEqual(self._status(uid)[0], "ok")
        acct = self._account(uid)["pcloud_oauth"]
        self.assertEqual((acct["mode"], acct["state"]), ("oauth", "connected"))
        self.assertEqual(self._managed(uid)["own_connection"], "oauth")

    def test_oauth_and_legacy_upload_to_the_same_remote_folder(self):
        self._setup_backup(oauth=OAUTH)
        self.bp.run_pcloud_backups()
        oauth_dest = self._destination(self._copies()[0])
        self.uploads.clear()
        import config

        uid = self._user(email="legacy@home.local")
        self.notes_db.update_pcloud_settings(uid, "x@pcloud.example", DEFAULT_PATH, "eu", True)
        config.write_pcloud_token(uid, LEGACY_JSON)
        self.bp.sync_user_backup(uid)
        legacy_dest = self._destination(self._copies()[0])
        self.assertEqual(oauth_dest, legacy_dest)
        self.assertEqual(oauth_dest, "deeperguard:" + DEFAULT_PATH)

    def test_refused_oauth_token_sets_reconnect_needed_and_mails_once(self):
        uid = self._setup_backup(oauth=OAUTH)
        self.refused.add(OAUTH)
        self.assertEqual(self.bp.run_pcloud_backups(), 0)
        status, detail = self._status(uid)
        self.assertEqual(status, "reconnect_needed")
        self.assertIn("Reconnect pCloud", detail)
        self.assertEqual(len(self.mails), 1)
        self.assertIn("Reconnect pCloud", self.mails[0][2])
        acct = self._account(uid)
        self.assertEqual(acct["pcloud_oauth"]["mode"], "reconnect_needed")
        self.assertEqual(acct["pcloud_oauth"]["state"], "relink")
        self.assertEqual(acct["pcloud_last_sync_status"], "reconnect_needed")
        self.assertEqual(self._managed(uid)["own_connection"], "reconnect_needed")
        # Later runs neither retry the refused token nor mail again.
        uploads_before = len(self.uploads)
        self.bp.run_pcloud_backups()
        self.bp.run_pcloud_backups()
        self.assertEqual(len(self.uploads), uploads_before)
        self.assertEqual(len(self.mails), 1)
        self.assertEqual(self._status(uid)[0], "reconnect_needed")

    def test_ordinary_upload_failures_do_not_mark_the_oauth_token_refused(self):
        uid = self._setup_backup(oauth=OAUTH)
        name = f"user-{uid}-20261120.enc.json.gz"
        failures = [
            ("Failed to copy: user-401-20261120.enc.json.gz: connection reset by peer", ""),
            ("Failed to copy: pcloud error: upload interrupted after 1401 bytes", ""),
            ("Failed to copy: dial tcp: lookup eapi.pcloud.com: no such host (code 4010)", ""),
            ("", f"Transferred: 401 B / 4010 B, 10%\nERROR : {name}: i/o timeout"),
            subprocess.TimeoutExpired(cmd="rclone", timeout=1),
        ]
        for failure in failures:
            with self.subTest(failure=failure):
                self.failure = failure
                self.assertEqual(self.bp.run_pcloud_backups(), 0)
                self.assertEqual(self._status(uid)[0], "error")
                self.assertIsNone(self.notes_db.get_pcloud_oauth_token(uid)["refused_at"] or None)
                self.assertTrue(all("reconnect" not in m[1] for m in self.mails))
        # The working token is still used once the network is back.
        self.failure = None
        self.uploads.clear()
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        self.assertEqual([c["token"] for c in self._copies()], [OAUTH])
        self.assertEqual(self._account(uid)["pcloud_oauth"]["mode"], "oauth")

    def test_refusal_phrases_from_pcloud_mark_the_token_refused(self):
        uid = self._setup_backup(oauth=OAUTH)
        for stderr in (
            "Failed to copy: pcloud error: Log in required. (1000)",
            "Failed to copy: pcloud error: Invalid 'access_token' provided. (2094)",
            "Failed to copy: HTTP error 401 (401 Unauthorized)",
        ):
            with self.subTest(stderr=stderr):
                self.oauth.store_token(uid, OAUTH, "eapi.pcloud.com")  # a fresh connection each round
                self.failure = (stderr, "")
                self.bp.run_pcloud_backups()
                self.assertEqual(self._status(uid)[0], "reconnect_needed")
                self.assertTrue(self.notes_db.get_pcloud_oauth_token(uid)["refused_at"])

    def test_reconnecting_after_refusal_uploads_again(self):
        uid = self._setup_backup(oauth=OAUTH)
        self.refused.add(OAUTH)
        self.bp.run_pcloud_backups()
        self.oauth.store_token(uid, OAUTH_NEW, "eapi.pcloud.com")
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        self.assertEqual(self._copies()[-1]["token"], OAUTH_NEW)
        self.assertEqual(self._status(uid)[0], "ok")
        self.assertEqual(self._account(uid)["pcloud_oauth"]["mode"], "oauth")
        self.assertEqual(len(self.mails), 1)
        # Refused again after reconnecting: a new mail, because it is a new refusal.
        self.refused.add(OAUTH_NEW)
        self.bp.run_pcloud_backups()
        self.assertEqual(len(self.mails), 2)

    def test_refused_oauth_falls_back_to_legacy_and_says_so(self):
        uid = self._setup_backup(oauth=OAUTH, legacy=True)
        self.refused.add(OAUTH)
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        self.assertEqual([c["token"] for c in self._copies()], [OAUTH, LEGACY])
        self.assertEqual(len(self.mails), 1)
        status, detail = self._status(uid)
        self.assertEqual(status, "ok")
        self.assertIn("reconnect pCloud", detail)
        acct = self._account(uid)["pcloud_oauth"]
        self.assertEqual((acct["mode"], acct["state"], acct["oauth_refused"]), ("legacy", "relink", True))
        self.bp.run_pcloud_backups()
        self.assertEqual([c["token"] for c in self._copies()], [OAUTH, LEGACY, LEGACY])
        self.assertEqual(len(self.mails), 1)

    def test_account_with_no_token_gets_reconnect_needed_and_one_mail(self):
        uid = self._setup_backup()
        self.assertEqual(self.bp.run_pcloud_backups(), 0)
        self.bp.run_pcloud_backups()
        self.assertEqual(self.uploads, [])
        self.assertEqual(self._status(uid)[0], "reconnect_needed")
        self.assertEqual(len(self.mails), 1)
        self.assertIn("Connect pCloud", self.mails[0][2])
        self.assertEqual(self._account(uid)["pcloud_oauth"]["mode"], "reconnect_needed")

    def test_oauth_only_account_without_username_is_backed_up(self):
        uid = self._setup_backup(oauth=OAUTH)
        self.notes_db.update_pcloud_settings(uid, "", DEFAULT_PATH, "eu", True)
        self.assertEqual(self.bp.run_pcloud_backups(), 1)
        self.assertEqual([c["token"] for c in self._copies()], [OAUTH])

    def test_job_never_uses_a_stored_password(self):
        uid = self._setup_backup(oauth=OAUTH, legacy=True)
        legacy_file = Path(self.tmp.name) / "keys" / f"pcloud-password-{uid}"
        legacy_file.write_text(PASSWORD)
        self.bp.run_pcloud_backups()
        self.assertTrue(self.uploads)
        for upload in self.uploads:
            self.assertNotIn(PASSWORD, " ".join(upload["cmd"]))
            self.assertNotIn(PASSWORD, json.dumps({k: str(v) for k, v in upload["env"].items()}))
        self.assertFalse(legacy_file.exists())  # only the migration touches it, and it deletes it

    def test_connecting_enables_scheduled_backup_and_disconnect_without_legacy_disables(self):
        uid = self._user()
        csrf = self._login(uid)
        self.assertEqual(self.notes_db.users_with_pcloud_enabled(), [])
        _, state = self._start(csrf)
        self.assertEqual(self._callback(state).status_code, 302)
        self.assertEqual([int(u["id"]) for u in self.notes_db.users_with_pcloud_enabled()], [uid])
        self.client.post(_tpo.DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(self.notes_db.users_with_pcloud_enabled(), [])


if __name__ == "__main__":
    unittest.main()
