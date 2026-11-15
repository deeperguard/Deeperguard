"""Managed pCloud backup using the admin-stored (encrypted) service token."""
import importlib
import logging
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_managed_pcloud import ManagedPcloudTests  # noqa: E402

TOKEN = "STORED-TOKEN-abc987"


class StoredTokenTests(ManagedPcloudTests):
    def setUp(self):
        super().setUp()
        sys.modules.pop("pcloud_service_token", None)

    def _store(self):
        pst = importlib.import_module("pcloud_service_token")
        pst.set_token(TOKEN, "eu", "admin@example.com")

    def _capture(self, rc=0, stderr=""):
        calls = []

        def fake_run(cmd, **kw):
            calls.append((cmd, kw))
            return subprocess.CompletedProcess(cmd, rc, "", stderr)

        self._fake_rclone("exit 0\n")
        return calls, mock.patch("backup_pcloud.subprocess.run", fake_run)

    def test_status_not_configured(self):
        self.assertEqual(self.bp.service_status(), dict(configured=False, source="not_configured"))
        self.assertEqual(self.bp.test_connection(), dict(ok=False, category="not_configured"))
        self.assertEqual(self.bp.managed_healthcheck()["reason_code"], "not_configured")

    def test_token_in_env_not_argv_no_config_file(self):
        self._store()
        calls, patch = self._capture()
        before = set(Path(self.tmp.name).rglob("*"))
        with patch:
            self.assertEqual(self.bp.test_connection(), dict(ok=True, category="ok"))
        cmd, kw = calls[0]
        self.assertNotIn(TOKEN, " ".join(cmd))
        self.assertNotIn("--config", cmd)
        env = kw["env"]
        self.assertIn(TOKEN, env["RCLONE_CONFIG_DGSERVICE_TOKEN"])
        self.assertEqual(env["RCLONE_CONFIG_DGSERVICE_TYPE"], "pcloud")
        self.assertEqual(env["RCLONE_CONFIG_DGSERVICE_HOSTNAME"], "eapi.pcloud.com")
        self.assertNotIn("RCLONE_CONFIG_DGSERVICE_TOKEN", os.environ)
        self.assertEqual(set(Path(self.tmp.name).rglob("*")), before)
        self.assertEqual(self.bp.service_status(), dict(configured=True, source="admin"))

    def test_env_remote_wins(self):
        self._store()
        os.environ["NOTES_PCLOUD_SERVICE_REMOTE"] = "svc"
        calls, patch = self._capture()
        with patch:
            self.bp.managed_healthcheck()
        cmd, kw = calls[0]
        self.assertTrue(any(a.startswith("svc:") for a in cmd))
        self.assertIsNone(kw["env"])
        self.assertEqual(self.bp.service_status()["source"], "env")

    def test_echoed_token_never_logged_or_returned(self):
        self._store()
        calls, patch = self._capture(1, "error token " + TOKEN + " 401")
        with patch, self.assertLogs("deeperguard.backup.pcloud", level=logging.DEBUG) as cm:
            res = self.bp.managed_healthcheck()
            conn = self.bp.test_connection()
        self.assertEqual(conn, dict(ok=False, category="auth"))
        self.assertNotIn(TOKEN, repr(res) + repr(conn) + "\n".join(cm.output))


# Only run the new tests here, not the inherited ones a second time.
for _name in [n for n in dir(ManagedPcloudTests) if n.startswith("test_")]:
    if _name not in StoredTokenTests.__dict__:
        setattr(StoredTokenTests, _name, None)

if __name__ == "__main__":
    unittest.main()
