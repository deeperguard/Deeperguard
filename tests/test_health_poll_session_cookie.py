"""A background GET /api/health or /api/account must not rewrite the session cookie.

A permanent cookie session is re-sent on every response. A health poll that was in
flight while another request changed the session (the vault-keys proof token) wrote
the old copy back and dropped that change (first recovery-key PUT answered 401).
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))


class HealthPollSessionCookieTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "keys").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        (root / "keys" / "flask-secret").write_text("health-poll-secret", encoding="utf-8")
        patcher = mock.patch.dict(
            os.environ,
            {
                "NOTES_ROOT": str(root),
                "NOTES_DATA": str(root / "data"),
                "NOTES_KEYS": str(root / "keys"),
                "NOTES_ALLOWED_CIDRS": "127.0.0.1/32",
                "NOTES_SKIP_LOGIN": "0",
                "NOTES_SERVER_INFO_REFRESH": "0",
                "NOTES_DISABLE_CIDR_GATE": "1",
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in list(sys.modules):
            if name in {"app", "config", "auth", "db", "srp_auth", "auth_rate_limit"} or name.startswith("app."):
                sys.modules.pop(name, None)
        self.app_mod = importlib.import_module("app")
        self.client = self.app_mod.app.test_client()
        with self.client.session_transaction() as sess:
            sess.permanent = True
            sess["marker"] = "kept"

    def _set_cookie_headers(self, resp):
        return [v for v in resp.headers.getlist("Set-Cookie") if v.startswith(("session=", "__Host-session="))]

    def test_health_poll_leaves_session_cookie_alone(self):
        resp = self.client.get("/api/health")
        self.assertEqual(self._set_cookie_headers(resp), [])

    def test_account_refresh_leaves_session_cookie_alone(self):
        # Right after registration GET /api/account ran between vault-keys/prove and the
        # recovery-key PUT; its stale copy dropped the proof token and the PUT gave 401.
        resp = self.client.get("/api/account")
        self.assertEqual(self._set_cookie_headers(resp), [])

    def test_other_requests_still_refresh_permanent_session(self):
        # Any other route keeps the sliding permanent session.
        resp = self.client.get("/login")
        self.assertTrue(self._set_cookie_headers(resp))

    def test_other_api_requests_still_refresh_permanent_session(self):
        # Only the listed GETs are exempt: other API reads and the sync POSTs an
        # API-only client keeps sending still slide the expiry.
        for method, path in (("GET", "/api/boot-account"), ("POST", "/api/sync/pull")):
            resp = self.client.open(path, method=method, json={} if method == "POST" else None)
            self.assertTrue(self._set_cookie_headers(resp), f"{method} {path}")


if __name__ == "__main__":
    unittest.main()
