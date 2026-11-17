"""Admin dashboard: pCloud backup connection (set, test, remove). Token never leaves the server."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stripe_billing as _tsb  # noqa: E402

_SETUP, _TEARDOWN = _tsb.StripeBillingTests.setUp, _tsb.StripeBillingTests.tearDown
del _tsb

from test_app import stop_app_background_threads  # noqa: E402

TOKEN = "ADMINPASTEDtokenXyz0987654321"


def _restore_env(key, value):
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
URL = "/api/admin/pcloud-service"


class AdminPcloudServiceTests(unittest.TestCase):
    def setUp(self):
        saved = os.environ.get("NOTES_PCLOUD_SERVICE_REMOTE")
        self.addCleanup(_restore_env, "NOTES_PCLOUD_SERVICE_REMOTE", saved)
        for name in ("admin_api", "admin_notify", "backup_pcloud", "backup_mail", "mailer",
                     "pcloud_service_token", "auth_rate_limit", "server_info_cache"):
            sys.modules.pop(name, None)
        os.environ.pop("NOTES_PCLOUD_SERVICE_REMOTE", None)
        _SETUP(self)
        import auth_rate_limit

        auth_rate_limit._hits.clear()
        from passwords import hash_password, new_kdf_salt

        db = self.notes_db
        self.admin_id = int(db.create_user("boss@home.local", hash_password("pw-secure-123"), new_kdf_salt()))
        db.update_user_admin_flag(self.admin_id, True)
        self.user_id = int(db.create_user("joe@home.local", hash_password("pw-secure-123"), new_kdf_salt()))
        self.bodies: list[str] = []

    def tearDown(self):
        import auth_rate_limit

        auth_rate_limit._hits.clear()
        _TEARDOWN(self)
        stop_app_background_threads()

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

    def _call(self, method, path, csrf=None, body=None):
        headers = {"X-CSRF-Token": csrf} if csrf else {}
        res = getattr(self.client, method)(path, json=body, headers=headers)
        self.bodies.append(res.get_data(as_text=True))
        return res

    def _assert_no_token(self, extra=()):
        parts = [TOKEN[i:i + 8] for i in range(0, len(TOKEN) - 7, 4)]
        for text in list(self.bodies) + list(extra):
            self.assertNotIn(TOKEN, text)
            for part in parts:
                self.assertNotIn(part, text)

    def test_non_admin_forbidden(self):
        csrf = self._login(self.user_id)
        self.assertEqual(self._call("get", URL).status_code, 403)
        self.assertEqual(self._call("put", URL, csrf, {"token": TOKEN, "region": "eu"}).status_code, 403)
        self.assertEqual(self._call("post", URL + "/test", csrf, {}).status_code, 403)
        self.assertEqual(self._call("delete", URL, csrf).status_code, 403)
        import pcloud_service_token as pst

        self.assertFalse(pst.status()["configured"])

    def test_write_without_csrf_refused(self):
        self._login(self.admin_id)
        res = self._call("put", URL, None, {"token": TOKEN, "region": "eu"})
        self.assertIn(res.status_code, (400, 403))
        self.assertEqual(self._call("delete", URL, None).status_code, res.status_code)
        self.assertEqual(self._call("post", URL + "/test", None, {}).status_code, res.status_code)
        import pcloud_service_token as pst

        self.assertFalse(pst.status()["configured"])

    def test_set_test_remove_flow_never_exposes_token(self):
        csrf = self._login(self.admin_id)
        calls = []

        def fake_run(cmd, **kw):
            calls.append((cmd, kw))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with self.assertLogs(level="DEBUG") as logs:
            logging.getLogger("deeperguard.admin").info("start")
            res = self._call("get", URL)
            self.assertFalse(res.get_json()["pcloud"]["configured"])
            blob = json.dumps({"access_token": TOKEN, "token_type": "bearer", "expiry": "0001-01-01T00:00:00Z"})
            res = self._call("put", URL, csrf, {"token": blob, "region": "us"})
            self.assertEqual(res.status_code, 200)
            st = res.get_json()["pcloud"]
            self.assertTrue(st["configured"])
            self.assertEqual(st["region"], "us")
            self.assertEqual(st["set_by"], "boss@home.local")
            self.assertGreater(st["set_at"], 0)
            self.assertEqual(st["last_test_at"], 0)
            with mock.patch("backup_pcloud.subprocess.run", fake_run), \
                    mock.patch("backup_pcloud.rclone_bin", lambda: "/usr/bin/rclone"):
                res = self._call("post", URL + "/test", csrf, {})
            self.assertEqual(res.status_code, 200)
            self.assertTrue(res.get_json()["test_ok"])
            st = res.get_json()["pcloud"]
            self.assertTrue(st["last_test_ok"])
            self.assertGreater(st["last_test_at"], 0)
            self.assertNotIn(TOKEN, " ".join(calls[0][0]))
            self.assertIn(TOKEN, calls[0][1]["env"]["RCLONE_CONFIG_DGSERVICE_TOKEN"])
            # failing test: rclone output echoing the token is not passed on
            with mock.patch("backup_pcloud.subprocess.run",
                            lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, TOKEN, f"401 bad {TOKEN}")), \
                    mock.patch("backup_pcloud.rclone_bin", lambda: "/usr/bin/rclone"):
                res = self._call("post", URL + "/test", csrf, {})
            self.assertFalse(res.get_json()["test_ok"])
            self.assertFalse(res.get_json()["pcloud"]["last_test_ok"])
            # invalid input: error does not echo it
            res = self._call("put", URL, csrf, {"token": TOKEN + " junk", "region": "eu"})
            self.assertEqual(res.status_code, 400)
            res = self._call("put", URL, csrf, {"token": TOKEN, "region": "mars"})
            self.assertEqual(res.status_code, 400)
            res = self._call("get", "/api/admin/overview")
            self.assertEqual(res.status_code, 200)
            res = self._call("delete", URL, csrf)
            self.assertEqual(res.status_code, 200)
            self.assertFalse(res.get_json()["pcloud"]["configured"])
        lines = [r.getMessage() for r in logs.records]
        audit = [line for line in lines if "pcloud-service" in line]
        self.assertTrue(any(line.startswith("admin pcloud-service set by=boss@home.local") for line in audit))
        self.assertTrue(any(line.startswith("admin pcloud-service test") for line in audit))
        self.assertTrue(any(line.startswith("admin pcloud-service remove by=boss@home.local") for line in audit))
        self._assert_no_token(lines)
        row = self.notes_db.connection().execute("SELECT COUNT(*) FROM pcloud_service_token").fetchone()[0]
        self.assertEqual(row, 0)

    def test_rate_limit_on_save_and_test(self):
        csrf = self._login(self.admin_id)
        codes = [self._call("put", URL, csrf, {"token": TOKEN, "region": "eu"}).status_code for _ in range(8)]
        self.assertEqual(codes[0], 200)
        self.assertIn(429, codes)
        with mock.patch("backup_pcloud.subprocess.run",
                        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "", "")), \
                mock.patch("backup_pcloud.rclone_bin", lambda: "/usr/bin/rclone"):
            codes = [self._call("post", URL + "/test", csrf, {}).status_code for _ in range(8)]
        self.assertEqual(codes[0], 200)
        self.assertIn(429, codes)
        self._assert_no_token()

    def test_env_remote_read_only(self):
        csrf = self._login(self.admin_id)
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        st = self._call("get", URL).get_json()["pcloud"]
        self.assertTrue(st["env_remote"])
        self.assertTrue(st["read_only"])
        self.assertEqual(self._call("put", URL, csrf, {"token": TOKEN, "region": "eu"}).status_code, 409)
        self.assertEqual(self._call("post", URL + "/test", csrf, {}).status_code, 409)
        self.assertEqual(self._call("delete", URL, csrf).status_code, 409)
        import pcloud_service_token as pst

        self.assertFalse(pst.status()["configured"])
        self._assert_no_token()

    def test_admin_page_has_section_without_forbidden_words(self):
        self._login(self.admin_id)
        html = self.client.get("/admin").get_data(as_text=True)
        self.assertIn("pCloud backup connection", html)
        self.assertIn('id="pcloud-token"', html)
        self.assertRegex(html, r'<textarea id="pcloud-token"[^>]*autocomplete="off"')
        js = (Path(__file__).resolve().parent.parent / "app" / "static" / "js" / "admin.js").read_text()
        section = html[html.index('id="admin-pcloud"'):html.index('id="admin-error"')]
        for text in (section.lower(), js.lower()):
            for word in ("veilig", "secure", "zero-knowledge", "zero knowledge"):
                self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
