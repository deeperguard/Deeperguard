"""Managed pCloud backup API: no sensitive fields, off by default, unavailable without remote."""
from __future__ import annotations

import os
import stat
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stripe_billing as _tsb  # noqa: E402
from test_app import stop_app_background_threads  # noqa: E402

_SETUP, _TEARDOWN = _tsb.StripeBillingTests.setUp, _tsb.StripeBillingTests.tearDown
del _tsb

REMOTE = "SentinelRemote"
ROOT = "Sentinel/RootDir"
CFG = "/tmp/sentinel-rclone.conf"


PCLOUD_ENV_KEYS = ("NOTES_PCLOUD_SERVICE_REMOTE", "NOTES_PCLOUD_SERVICE_ROOT",
                   "NOTES_PCLOUD_SERVICE_RCLONE_CONFIG", "PATH")


def _restore_env(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


class ManagedApiTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(_restore_env, {k: os.environ.get(k) for k in PCLOUD_ENV_KEYS})
        _SETUP(self)

    def _login(self, uid):
        import secrets
        import time

        from config import SESSION_SECONDS

        with self.client.session_transaction() as sess:
            sess["uid"] = uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            return sess["csrf"]

    def tearDown(self):
        _TEARDOWN(self)
        stop_app_background_threads()

    def _prep(self, remote=True, healthy=True, plan="pro"):
        self._path = os.environ["PATH"]
        os.environ.pop("NOTES_PCLOUD_SERVICE_REMOTE", None)
        if remote:
            os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = REMOTE
            os.environ["NOTES_PCLOUD_SERVICE_ROOT"] = ROOT
            os.environ["NOTES_PCLOUD_SERVICE_RCLONE_CONFIG"] = CFG
            binp = Path(self.tmp.name) / "bin"
            binp.mkdir(exist_ok=True)
            r = binp / "rclone"
            body = "exit 0\n" if healthy else "echo SentinelRemote >&2; exit 1\n"
            r.write_text("#!/bin/sh\n" + body)
            r.chmod(r.stat().st_mode | stat.S_IEXEC)
            os.environ["PATH"] = str(binp) + ":" + self._path
        from passwords import hash_password, new_kdf_salt

        uid = int(self.notes_db.create_user("m@home.local", hash_password("pw-secure-123"), new_kdf_salt()))
        self.notes_db.connection().execute("UPDATE users SET plan = ? WHERE id = ?", (plan, uid))
        self.notes_db.connection().commit()
        self.app_mod._managed_health_cache.update(at=0.0, value=None)
        return uid, self._login(uid)

    def _assert_clean(self, res):
        raw = res.get_data(as_text=True).lower()
        keys = set(res.get_json())
        self.assertFalse(keys & {"remote", "root", "path", "dir_id", "pcloud_dir_id", "folder_id", "config"})
        for needle in (REMOTE, ROOT, "sentinel", CFG, "dir_id"):
            self.assertNotIn(needle.lower(), raw, needle)
        dir_id = self.notes_db.get_user_by_email("m@home.local")["pcloud_dir_id"]
        if dir_id:
            self.assertNotIn(dir_id, raw)

    def test_default_off_and_no_sensitive_fields(self):
        uid, csrf = self._prep()
        res = self.client.get("/api/backup/managed")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["available"])
        self.assertFalse(body["enabled"])
        self.assertFalse(body["failures_only"])
        self._assert_clean(res)
        hdr = {"X-CSRF-Token": csrf}
        on = self.client.post("/api/backup/managed", json={"enabled": True}, headers=hdr)
        self.assertEqual(on.status_code, 200, on.get_json())
        self.assertTrue(on.get_json()["enabled"])
        self._assert_clean(on)
        pref = self.client.post("/api/backup/managed", json={"failures_only": True}, headers=hdr)
        self.assertTrue(pref.get_json()["failures_only"])
        self._assert_clean(self.client.get("/api/backup/managed"))

    def test_unavailable_without_remote(self):
        uid, csrf = self._prep(remote=False)
        body = self.client.get("/api/backup/managed").get_json()
        self.assertFalse(body["available"])
        self.assertFalse(body["enabled"])
        res = self.client.post("/api/backup/managed", json={"enabled": True}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 409)
        self.assertFalse(self.notes_db.get_user_by_id(uid)["managed_backup_enabled"])

    def test_unavailable_when_healthcheck_fails_and_no_leak(self):
        self._prep(healthy=False)
        res = self.client.get("/api/backup/managed")
        self.assertFalse(res.get_json()["available"])
        self._assert_clean(res)

    def test_toggle_requires_csrf_and_login(self):
        uid, csrf = self._prep()
        res = self.client.post("/api/backup/managed", json={"enabled": True})
        self.assertEqual(res.status_code, 400)
        self.assertFalse(self.notes_db.get_user_by_id(uid)["managed_backup_enabled"])
        anon = self.app_mod.app.test_client()
        self.assertNotEqual(anon.get("/api/backup/managed").status_code, 200)

    def test_plan_gate(self):
        uid, csrf = self._prep(plan="free")
        res = self.client.post("/api/backup/managed", json={"enabled": True}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 403)

    def test_own_token_user_keeps_setup_and_is_flagged(self):
        uid, csrf = self._prep()
        c = self.notes_db.connection()
        c.execute("UPDATE users SET pcloud_enabled = 1, pcloud_username = 'u' WHERE id = ?", (uid,))
        c.commit()
        orig = self.app_mod.pcloud_token_set
        self.app_mod.pcloud_token_set = lambda u: True
        try:
            body = self.client.get("/api/backup/managed").get_json()
            self.assertTrue(body["own_token"])
            self.assertFalse(body["enabled"])
            self.client.post("/api/backup/managed", json={"enabled": True}, headers={"X-CSRF-Token": csrf})
        finally:
            self.app_mod.pcloud_token_set = orig
        row = self.notes_db.get_user_by_id(uid)
        self.assertEqual(row["pcloud_username"], "u")  # old setup untouched
        self.assertTrue(row["managed_backup_enabled"])


if __name__ == "__main__":
    unittest.main()
