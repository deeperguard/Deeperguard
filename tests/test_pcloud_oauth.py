"""pCloud OAuth connect flow against a fake pCloud HTTP server.

Covers start, callback and disconnect, the state check, ciphertext-only storage
in the database, and that token, code and client secret never reach the logs.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_stripe_billing as _tsb  # noqa: E402
from test_app import stop_app_background_threads  # noqa: E402

_SETUP, _TEARDOWN = _tsb.StripeBillingTests.setUp, _tsb.StripeBillingTests.tearDown
del _tsb

CLIENT_ID = "fake-client-id"
CLIENT_SECRET = "fake-client-SECRET-5f1c"
CODE = "fake-auth-CODE-9a7d"
ACCESS_TOKEN = "fake-access-TOKEN-c3e8"
KEY = "ab" * 32
OTHER_KEY = "cd" * 32
ENV_KEYS = (
    "NOTES_PCLOUD_OAUTH_CLIENT_ID",
    "NOTES_PCLOUD_OAUTH_CLIENT_SECRET",
    "NOTES_PCLOUD_CREDENTIALS_KEY",
)
START = "/api/backup/pcloud/oauth/start"
CALLBACK = "/api/backup/pcloud/oauth/callback"
DISCONNECT = "/api/backup/pcloud/oauth/disconnect"


class FakePcloud:
    """Minimal pCloud API: oauth2_token hands out a token for the right code, logout revokes it."""

    def __init__(self):
        self.requests = []
        self.live_tokens = set()
        self.token_to_issue = ACCESS_TOKEN
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
                method = self.path.lstrip("/")
                fake.requests.append(
                    {"method": method, "form": form, "authorization": self.headers.get("Authorization", "")}
                )
                if method == "oauth2_token":
                    ok = (
                        form.get("client_id") == CLIENT_ID
                        and form.get("client_secret") == CLIENT_SECRET
                        and form.get("code") == CODE
                    )
                    if ok:
                        fake.live_tokens.add(fake.token_to_issue)
                        body = {"result": 0, "access_token": fake.token_to_issue, "token_type": "bearer"}
                    else:
                        body = {"result": 2012, "error": "Invalid 'code' provided."}
                elif method == "logout":
                    token = self.headers.get("Authorization", "").removeprefix("Bearer ")
                    deleted = token in fake.live_tokens
                    fake.live_tokens.discard(token)
                    body = {"result": 0, "auth_deleted": deleted}
                else:
                    body = {"result": 1000, "error": "unknown method"}
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def calls(self, method):
        return [r for r in self.requests if r["method"] == method]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


def _restore_env(saved):
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


class PcloudOAuthTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(_restore_env, {k: os.environ.get(k) for k in ENV_KEYS})
        os.environ["NOTES_PCLOUD_OAUTH_CLIENT_ID"] = CLIENT_ID
        os.environ["NOTES_PCLOUD_OAUTH_CLIENT_SECRET"] = CLIENT_SECRET
        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = KEY
        _SETUP(self)
        sys.modules.pop("pcloud_oauth", None)
        import pcloud_oauth

        self.oauth = pcloud_oauth
        self.fake = FakePcloud()
        self.addCleanup(self.fake.close)
        # Route both allowlisted pCloud API hosts to the fake server.
        self._real_hosts = dict(pcloud_oauth.API_BASE_URLS)
        pcloud_oauth.API_BASE_URLS.update({host: self.fake.url for host in self._real_hosts})
        self.addCleanup(pcloud_oauth.API_BASE_URLS.update, self._real_hosts)

        self.log_capture = _ListHandler()
        root = logging.getLogger()
        self._root_level = root.level
        root.addHandler(self.log_capture)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.setLevel, self._root_level)
        self.addCleanup(root.removeHandler, self.log_capture)

    def tearDown(self):
        _TEARDOWN(self)
        stop_app_background_threads()

    def _user(self, email="oauth@home.local", plan="pro"):
        from passwords import hash_password, new_kdf_salt

        uid = int(self.notes_db.create_user(email, hash_password("pw-secure-123"), new_kdf_salt()))
        self.notes_db.connection().execute("UPDATE users SET plan = ? WHERE id = ?", (plan, uid))
        self.notes_db.connection().commit()
        return uid

    def _login(self, uid, client=None):
        import secrets
        import time

        from config import SESSION_SECONDS

        with (client or self.client).session_transaction() as sess:
            sess["uid"] = uid
            sess["authed"] = True
            sess["exp"] = time.time() + SESSION_SECONDS
            sess["csrf"] = secrets.token_urlsafe(32)
            sess["totp_ok"] = True
            return sess["csrf"]

    def _start(self, csrf, client=None):
        res = (client or self.client).post(START, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200, res.get_json())
        url = res.get_json()["authorize_url"]
        return url, parse_qs(urlsplit(url).query)["state"][0]

    def _callback(self, state, code=CODE, hostname="eapi.pcloud.com", client=None):
        query = {"code": code, "state": state, "locationid": "2", "hostname": hostname}
        return (client or self.client).get(CALLBACK, query_string=query)

    def _row(self, uid):
        return self.notes_db.connection().execute(
            "SELECT * FROM pcloud_oauth_tokens WHERE user_id = ?", (uid,)
        ).fetchone()

    def _connect(self):
        uid = self._user()
        csrf = self._login(uid)
        _, state = self._start(csrf)
        res = self._callback(state)
        self.assertEqual(res.status_code, 302, res.get_data(as_text=True))
        return uid, csrf

    def test_start_returns_pcloud_authorize_url_with_state(self):
        uid = self._user()
        csrf = self._login(uid)
        url, state = self._start(csrf)
        parts = urlsplit(url)
        self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", "https://my.pcloud.com/oauth2/authorize")
        query = parse_qs(parts.query)
        self.assertEqual(query["client_id"], [CLIENT_ID])
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["redirect_uri"], ["https://www.deeperguard.com" + CALLBACK])
        self.assertGreaterEqual(len(state), 32)
        self.assertNotIn(CLIENT_SECRET, url)
        _, second_state = self._start(csrf)
        self.assertNotEqual(state, second_state)

    def test_start_requires_csrf_login_plan_and_configuration(self):
        uid = self._user()
        csrf = self._login(uid)
        self.assertEqual(self.client.post(START, json={}).status_code, 400)
        anon = self.app_mod.app.test_client()
        self.assertEqual(anon.post(START, json={}).status_code, 401)

        free_client = self.app_mod.app.test_client()
        free_csrf = self._login(self._user("free@home.local", plan="free"), free_client)
        self.assertEqual(free_client.post(START, json={}, headers={"X-CSRF-Token": free_csrf}).status_code, 403)

        for missing in ENV_KEYS:
            saved = os.environ.pop(missing)
            res = self.client.post(START, json={}, headers={"X-CSRF-Token": csrf})
            os.environ[missing] = saved
            self.assertEqual(res.status_code, 503, missing)
            self.assertNotIn("authorize_url", res.get_json())

    def test_connect_flow_exchanges_code_and_stores_token(self):
        uid, _ = self._connect()
        exchange = self.fake.calls("oauth2_token")
        self.assertEqual(len(exchange), 1)
        self.assertEqual(
            exchange[0]["form"], {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "code": CODE}
        )
        self.assertEqual(self.oauth.stored_token(uid), ACCESS_TOKEN)
        self.assertEqual(self._row(uid)["api_host"], "eapi.pcloud.com")

    def assertFailedRedirect(self, res, outcome="failed"):
        """A failed callback lands in the app with a readable message, never bare JSON."""
        self.assertEqual(res.status_code, 302, res.get_data(as_text=True))
        self.assertTrue(res.headers["Location"].endswith(f"/app?pcloud={outcome}"), res.headers["Location"])
        self.assertEqual(res.headers["Cache-Control"], "no-store")

    def test_callback_redirects_to_app_without_leaking_token(self):
        uid = self._user()
        _, state = self._start(self._login(uid))
        res = self._callback(state)
        self.assertEqual(res.status_code, 302)
        self.assertTrue(res.headers["Location"].endswith("/app?pcloud=connected"), res.headers["Location"])
        self.assertNotIn(ACCESS_TOKEN, res.headers["Location"])
        self.assertNotIn(ACCESS_TOKEN, res.get_data(as_text=True))

    def test_callback_with_invalid_state_is_rejected(self):
        uid = self._user()
        csrf = self._login(uid)
        _, state = self._start(csrf)
        for bad in ("", "not-the-state", state + "x", state[:-1]):
            res = self._callback(bad)
            self.assertFailedRedirect(res)
            # A failed attempt also uses up the state: start again for the next one.
            self.assertFailedRedirect(self._callback(state))
            _, state = self._start(csrf)
        self.assertEqual(self.fake.requests, [])
        self.assertIsNone(self._row(uid))

    def test_callback_without_start_is_rejected(self):
        uid = self._user()
        self._login(uid)
        self.assertFailedRedirect(self._callback("anything"))
        self.assertEqual(self.fake.requests, [])
        self.assertIsNone(self._row(uid))

    def test_state_is_single_use_and_bound_to_the_session(self):
        uid = self._user()
        csrf = self._login(uid)
        _, state = self._start(csrf)

        other = self.app_mod.app.test_client()
        other_uid = self._user("other@home.local")
        self._login(other_uid, other)
        self.assertFailedRedirect(self._callback(state, client=other))
        self.assertIsNone(self._row(other_uid))

        self.assertEqual(self._callback(state).status_code, 302)
        self.assertFailedRedirect(self._callback(state))
        self.assertEqual(len(self.fake.calls("oauth2_token")), 1)

    def test_expired_state_is_rejected(self):
        uid = self._user()
        _, state = self._start(self._login(uid))
        with self.client.session_transaction() as sess:
            saved = dict(sess["pcloud_oauth_state"])
            saved["exp"] = saved["exp"] - self.oauth.STATE_TTL_SECONDS - 1
            sess["pcloud_oauth_state"] = saved
        self.assertFailedRedirect(self._callback(state))
        self.assertIsNone(self._row(uid))

    def test_callback_requires_login(self):
        anon = self.app_mod.app.test_client()
        self.assertEqual(self._callback("x", client=anon).status_code, 401)
        self.assertEqual(self.fake.requests, [])

    def test_callback_rejects_unknown_api_host_and_missing_code(self):
        uid = self._user()
        csrf = self._login(uid)
        for kwargs in ({"hostname": "evil.example"}, {"hostname": ""}, {"code": ""}):
            _, state = self._start(csrf)
            res = self._callback(state, **kwargs)
            self.assertFailedRedirect(res)
        self.assertEqual(self.fake.requests, [])
        self.assertIsNone(self._row(uid))

    def test_access_denied_at_pcloud_redirects_to_app(self):
        uid = self._user()
        _, state = self._start(self._login(uid))
        query = {"error": "access_denied", "state": state}
        res = self.client.get(CALLBACK, query_string=query)
        self.assertEqual(res.status_code, 302, res.get_data(as_text=True))
        self.assertTrue(res.headers["Location"].endswith("/app?pcloud=denied"), res.headers["Location"])
        self.assertEqual(res.headers["Cache-Control"], "no-store")
        self.assertEqual(self.fake.requests, [])
        self.assertIsNone(self._row(uid))
        # The state was used up; a denial with a forged state is still rejected.
        self.assertFailedRedirect(self.client.get(CALLBACK, query_string=query))

    def test_code_refused_by_pcloud_stores_nothing(self):
        uid = self._user()
        _, state = self._start(self._login(uid))
        res = self._callback(state, code="wrong-code")
        self.assertFailedRedirect(res)
        self.assertIsNone(self._row(uid))

    def test_unreachable_pcloud_stores_nothing(self):
        uid = self._user()
        _, state = self._start(self._login(uid))
        self.fake.close()
        self.assertFailedRedirect(self._callback(state))
        self.assertIsNone(self._row(uid))

    def test_callback_after_downgrade_or_without_server_config_lands_in_the_app(self):
        uid = self._user()
        csrf = self._login(uid)
        _, state = self._start(csrf)
        self.notes_db.connection().execute("UPDATE users SET plan = 'free' WHERE id = ?", (uid,))
        self.notes_db.connection().commit()
        self.assertFailedRedirect(self._callback(state), "plan")
        self.assertIsNone(self._row(uid))
        self.notes_db.connection().execute("UPDATE users SET plan = 'pro' WHERE id = ?", (uid,))
        self.notes_db.connection().commit()
        _, state = self._start(csrf)
        saved = os.environ.pop(ENV_KEYS[0])
        try:
            self.assertFailedRedirect(self._callback(state), "unavailable")
        finally:
            os.environ[ENV_KEYS[0]] = saved
        self.assertEqual(self.fake.requests, [])

    def test_account_reports_none_connected_and_relink_needed(self):
        uid = self._user()
        csrf = self._login(uid)
        status = lambda: self.client.get("/api/account").get_json()["pcloud_oauth"]
        self.assertEqual(
            status(), {"state": "none", "available": True, "mode": "none", "oauth_refused": False}
        )
        _, state = self._start(csrf)
        self._callback(state)
        self.assertEqual(status()["state"], "connected")
        # The server key changed: the stored token is unusable, the user must connect again.
        saved = os.environ.pop("NOTES_PCLOUD_CREDENTIALS_KEY", None)
        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = "0" * 64
        try:
            self.assertEqual(status()["state"], "relink")
        finally:
            if saved is None:
                os.environ.pop("NOTES_PCLOUD_CREDENTIALS_KEY", None)
            else:
                os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = saved
        self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(status()["state"], "none")

    def test_connecting_twice_keeps_only_the_latest_token(self):
        uid, csrf = self._connect()
        self.fake.token_to_issue = "second-TOKEN-71bb"
        _, state = self._start(csrf)
        self.assertEqual(self._callback(state, hostname="api.pcloud.com").status_code, 302)
        rows = self.notes_db.connection().execute("SELECT COUNT(*) FROM pcloud_oauth_tokens").fetchone()[0]
        self.assertEqual(rows, 1)
        self.assertEqual(self.oauth.stored_token(uid), "second-TOKEN-71bb")
        self.assertEqual(self._row(uid)["api_host"], "api.pcloud.com")

    def test_database_holds_only_ciphertext_unreadable_without_env_key(self):
        import pcloud_credentials as pc

        uid, _ = self._connect()
        stored = self._row(uid)["token_enc"]
        self.assertTrue(stored.startswith("dg-pcloud-v1:"))
        self.assertNotIn(ACCESS_TOKEN, stored)

        # No table holds the token or the key in the clear.
        conn = self.notes_db.connection()
        dump = "\n".join(conn.iterdump())
        self.assertIn(stored, dump)
        self.assertNotIn(ACCESS_TOKEN, dump)
        self.assertNotIn(KEY, dump)
        self.assertNotIn(CLIENT_SECRET, dump)
        # Nor does any file the server wrote (database, WAL, keys directory).
        conn.execute("PRAGMA wal_checkpoint(FULL)")
        for path in Path(self.tmp.name).rglob("*"):
            if path.is_file():
                raw = path.read_bytes()
                self.assertNotIn(ACCESS_TOKEN.encode(), raw, path)
                self.assertNotIn(bytes.fromhex(KEY), raw, path)
                self.assertNotIn(KEY.encode(), raw, path)

        # A copy of the database alone, read without the app, yields no token.
        db_files = [p for p in Path(self.tmp.name).rglob("*") if p.is_file() and p.read_bytes()[:15] == b"SQLite format 3"]
        self.assertEqual(len(db_files), 1)
        copy = sqlite3.connect(f"file:{db_files[0]}?mode=ro", uri=True)
        try:
            copied = copy.execute("SELECT token_enc FROM pcloud_oauth_tokens WHERE user_id = ?", (uid,)).fetchone()[0]
        finally:
            copy.close()
        self.assertEqual(copied, stored)

        del os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"]
        self.assertEqual(self.oauth.stored_token(uid), "")
        with self.assertRaises(RuntimeError):
            pc.decrypt_at_rest(copied)

        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = OTHER_KEY
        self.assertEqual(self.oauth.stored_token(uid), "")
        from cryptography.exceptions import InvalidTag

        with self.assertRaises(InvalidTag):
            pc.decrypt_at_rest(copied)

        os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"] = KEY
        self.assertEqual(self.oauth.stored_token(uid), ACCESS_TOKEN)

    def test_disconnect_revokes_at_pcloud_and_deletes_token(self):
        uid, csrf = self._connect()
        self.assertIn(ACCESS_TOKEN, self.fake.live_tokens)
        res = self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"ok": True, "connected": False, "revoked": True})
        self.assertIsNone(self._row(uid))
        self.assertEqual(self.oauth.stored_token(uid), "")
        self.assertNotIn(ACCESS_TOKEN, self.fake.live_tokens)
        self.assertEqual(self.fake.calls("logout")[0]["authorization"], f"Bearer {ACCESS_TOKEN}")

        again = self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(again.get_json(), {"ok": True, "connected": False, "revoked": False})
        self.assertEqual(len(self.fake.calls("logout")), 1)

    def test_disconnect_requires_csrf_and_login(self):
        uid, _ = self._connect()
        self.assertEqual(self.client.post(DISCONNECT, json={}).status_code, 400)
        anon = self.app_mod.app.test_client()
        self.assertEqual(anon.post(DISCONNECT, json={}).status_code, 401)
        self.assertIsNotNone(self._row(uid))
        self.assertEqual(self.fake.calls("logout"), [])

    def test_disconnect_deletes_token_when_pcloud_is_down(self):
        uid, csrf = self._connect()
        self.fake.close()
        res = self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.get_json(), {"ok": True, "connected": False, "revoked": False})
        self.assertIsNone(self._row(uid))

    def test_disconnect_without_env_key_deletes_without_revoking(self):
        uid, csrf = self._connect()
        del os.environ["NOTES_PCLOUD_CREDENTIALS_KEY"]
        res = self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.get_json(), {"ok": True, "connected": False, "revoked": False})
        self.assertIsNone(self._row(uid))
        self.assertEqual(self.fake.calls("logout"), [])

    def test_disconnect_works_after_downgrade_from_pro(self):
        uid, csrf = self._connect()
        self.notes_db.connection().execute("UPDATE users SET plan = 'free' WHERE id = ?", (uid,))
        self.notes_db.connection().commit()
        res = self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(res.status_code, 200)
        self.assertIsNone(self._row(uid))

    def test_deleting_the_account_removes_the_token_row(self):
        uid, _ = self._connect()
        self.assertTrue(self.notes_db.delete_user(uid))
        self.assertIsNone(self._row(uid))

    def test_no_token_code_or_secret_in_logs(self):
        uid, csrf = self._connect()
        # Failure paths log too: refused code, bad state, unknown host, failed revoke.
        _, state = self._start(csrf)
        self.assertFailedRedirect(self._callback(state, code=CODE + "-refused"))
        self.assertFailedRedirect(self._callback("bad-state"))
        _, state = self._start(csrf)
        self.assertFailedRedirect(self._callback(state, hostname="evil.example"))
        self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})
        _, state = self._start(csrf)
        self.assertEqual(self._callback(state).status_code, 302)
        self.fake.close()
        _, state = self._start(csrf)
        self.assertFailedRedirect(self._callback(state))
        self.client.post(DISCONNECT, json={}, headers={"X-CSRF-Token": csrf})

        logged = "\n".join(self.log_capture.lines)
        # The capture works: the flow's own log lines are in it.
        self.assertIn("pCloud OAuth connected", logged)
        self.assertIn("pCloud OAuth disconnected", logged)
        self.assertIn("code exchange failed", logged)
        for secret in (ACCESS_TOKEN, CODE, CLIENT_SECRET, KEY):
            self.assertNotIn(secret, logged)


if __name__ == "__main__":
    unittest.main()
