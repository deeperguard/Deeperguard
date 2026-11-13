"""Agenda feed relay: SSRF rules, limits, auth, rate limit and no-leak checks.

Only fake hosts (example.invalid) and a fake token (token=TEST) are used. The
"upstream" is a local plain-socket server; the TLS layer is replaced by a test
connect hook that records which IP the relay pinned.
"""
from __future__ import annotations

import importlib
import logging
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

import ics_relay  # noqa: E402

SECRET_URL = "https://example.invalid/cal/feed.ics?token=TEST"
PUBLIC_IP = "93.184.216.34"
ICS = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"


def http_response(status=200, body=b"", headers=None):
    head = [f"HTTP/1.1 {status} X"]
    hdrs = {"Content-Length": str(len(body)), "Connection": "close"}
    hdrs.update(headers or {})
    head += [f"{k}: {v}" for k, v in hdrs.items()]
    return ("\r\n".join(head) + "\r\n\r\n").encode() + body


class FakeUpstream:
    """Serves handler(request_bytes, n) -> bytes (or a generator of bytes)."""

    def __init__(self, handler):
        self.handler = handler
        self.requests: list[bytes] = []
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(8)
        self.port = self.srv.getsockname()[1]
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        try:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                data += chunk
            self.requests.append(data)
            out = self.handler(data, len(self.requests))
            if isinstance(out, (bytes, bytearray)):
                out = [out]
            for part in out:
                conn.sendall(part)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.srv.close()


class Hooks:
    def __init__(self, upstream, ips=None):
        self.upstream = upstream
        self.ips = ips or {}  # host -> [ip]
        self.resolved: list[str] = []
        self.connected: list[tuple[str, str]] = []

    def resolve(self, host):
        self.resolved.append(host)
        addrs = self.ips.get(host, [PUBLIC_IP])
        if not all(ics_relay.ip_allowed(a) for a in addrs):
            raise ics_relay.RelayError("E_BLOCKED")
        return list(addrs)

    def connect(self, ip, host, timeout):
        self.connected.append((ip, host))
        return socket.create_connection(("127.0.0.1", self.upstream.port), timeout=timeout)


class IpClassTest(unittest.TestCase):
    BLOCKED = [
        "127.0.0.1", "127.8.9.10", "::1", "10.0.0.1", "172.16.5.5", "192.168.1.1",
        "169.254.1.1", "169.254.169.254", "fe80::1", "100.64.0.1", "100.127.255.254",
        "224.0.0.1", "239.1.1.1", "ff02::1", "240.0.0.1", "255.255.255.255",
        "0.0.0.0", "0.1.2.3", "::", "fd00:ec2::254", "fc00::1", "fd12::1",
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
        "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "192.0.0.1",
    ]

    def test_blocked_classes(self):
        for addr in self.BLOCKED:
            self.assertFalse(ics_relay.ip_allowed(addr), addr)

    def test_public_allowed(self):
        for addr in (PUBLIC_IP, "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"):
            self.assertTrue(ics_relay.ip_allowed(addr), addr)

    def test_resolve_refuses_if_any_address_is_internal(self):
        infos = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_IP, 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 443)),
        ]
        with mock.patch("socket.getaddrinfo", return_value=infos):
            with self.assertRaises(ics_relay.RelayError) as cm:
                ics_relay.resolve_public("example.invalid")
        self.assertEqual(cm.exception.code, "E_BLOCKED")

    def test_ip_literal_hosts_are_checked(self):
        for host in ("127.0.0.1", "[::1]", "[::ffff:10.0.0.1]", "169.254.169.254"):
            with self.assertRaises(ics_relay.RelayError) as cm:
                ics_relay.fetch_feed(f"https://{host}/x.ics")
            self.assertEqual(cm.exception.code, "E_BLOCKED", host)


class UrlRulesTest(unittest.TestCase):
    def test_rejected_urls(self):
        for url in (
            "http://example.invalid/a.ics",
            "https://example.invalid:8443/a.ics",
            "https://example.invalid:80/a.ics",
            "https://user:pw@example.invalid/a.ics",
            "https://example.invalid/a b.ics",
            "https://example.invalid/a\r\nX: y",
            "ftp://example.invalid/a.ics",
            "webcal://example.invalid/a.ics",
            "https:///a.ics",
            "https://example.invalid/" + "a" * 2100,
            "", None, 5,
        ):
            with self.assertRaises(ics_relay.RelayError, msg=str(url)[:40]) as cm:
                ics_relay.fetch_feed(url, resolve=lambda h: self.fail("resolved"))
            self.assertEqual(cm.exception.code, "E_URL")

    def test_explicit_443_ok(self):
        self.assertEqual(ics_relay.parse_url("https://Example.invalid:443/a?x=1"), ("example.invalid", "/a?x=1"))


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.upstreams: list[FakeUpstream] = []

    def tearDown(self):
        for u in self.upstreams:
            u.close()

    def up(self, handler):
        u = FakeUpstream(handler)
        self.upstreams.append(u)
        return u

    def fetch(self, hooks, url=SECRET_URL):
        return ics_relay.fetch_feed(url, resolve=hooks.resolve, connect=hooks.connect)

    def test_success_pins_ip_and_sends_original_host_without_credentials(self):
        up = self.up(lambda req, n: http_response(200, ICS))
        h = Hooks(up)
        self.assertEqual(self.fetch(h), ICS)
        self.assertEqual(h.connected, [(PUBLIC_IP, "example.invalid")])
        req = up.requests[0].decode().lower()
        self.assertIn("host: example.invalid\r\n", req)
        self.assertTrue(req.startswith("get /cal/feed.ics?token=test http/1.1"))
        for forbidden in ("cookie", "authorization", "referer"):
            self.assertNotIn(forbidden, req)

    def test_dns_rebinding_second_lookup_is_never_used(self):
        up = self.up(lambda req, n: http_response(200, ICS))
        answers = iter([[PUBLIC_IP], ["127.0.0.1"], ["127.0.0.1"]])
        h = Hooks(up)
        h.resolve = lambda host: (h.resolved.append(host), next(answers))[1]
        self.assertEqual(self.fetch(h), ICS)
        self.assertEqual(h.resolved, ["example.invalid"])  # exactly one lookup per hop
        self.assertEqual(h.connected[0][0], PUBLIC_IP)

    def test_redirect_to_private_address_is_blocked(self):
        up = self.up(lambda req, n: http_response(302, b"", {"Location": "https://internal.invalid/x"}))
        h = Hooks(up, {"internal.invalid": ["10.1.2.3"]})
        with self.assertRaises(ics_relay.RelayError) as cm:
            self.fetch(h)
        self.assertEqual(cm.exception.code, "E_BLOCKED")
        self.assertEqual(len(h.connected), 1)

    def test_redirect_to_ip_literal_metadata_is_blocked(self):
        up = self.up(lambda req, n: http_response(301, b"", {"Location": "https://169.254.169.254/latest"}))
        with self.assertRaises(ics_relay.RelayError) as cm:
            self._fetch_real_resolver(up)
        self.assertEqual(cm.exception.code, "E_BLOCKED")

    def _fetch_real_resolver(self, up):
        h = Hooks(up)

        def resolve(host):
            if host == "example.invalid":
                return [PUBLIC_IP]
            return ics_relay.resolve_public(host)

        return ics_relay.fetch_feed(SECRET_URL, resolve=resolve, connect=h.connect)

    def test_redirect_to_http_or_other_port_refused(self):
        for loc in ("http://example.invalid/a", "https://example.invalid:8443/a"):
            up = self.up(lambda req, n, loc=loc: http_response(302, b"", {"Location": loc}))
            with self.assertRaises(ics_relay.RelayError) as cm:
                self.fetch(Hooks(up))
            self.assertEqual(cm.exception.code, "E_REDIRECT")

    def test_three_redirects_ok_fourth_fails_and_each_is_rechecked(self):
        def handler(req, n):
            if n <= 3:
                return http_response(302, b"", {"Location": f"/hop{n}"})
            return http_response(200, ICS)

        up = self.up(handler)
        h = Hooks(up)
        self.assertEqual(self.fetch(h), ICS)
        self.assertEqual(len(h.resolved), 4)

        up2 = self.up(lambda req, n: http_response(302, b"", {"Location": f"/hop{n}"}))
        h2 = Hooks(up2)
        with self.assertRaises(ics_relay.RelayError) as cm:
            self.fetch(h2)
        self.assertEqual(cm.exception.code, "E_REDIRECT")
        self.assertEqual(len(h2.resolved), 4)

    def test_size_limit_with_content_length(self):
        up = self.up(lambda req, n: http_response(200, b"", {"Content-Length": str(ics_relay.MAX_BODY_BYTES + 1)}))
        with self.assertRaises(ics_relay.RelayError) as cm:
            self.fetch(Hooks(up))
        self.assertEqual(cm.exception.code, "E_TOO_LARGE")

    def test_size_limit_streaming_without_content_length(self):
        def handler(req, n):
            yield b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
            block = b"x" * 65536
            for _ in range(80):  # 5 MB, more than the cap
                yield block

        up = self.up(handler)
        with self.assertRaises(ics_relay.RelayError) as cm:
            self.fetch(Hooks(up))
        self.assertEqual(cm.exception.code, "E_TOO_LARGE")

    def test_exactly_at_limit_is_accepted(self):
        body = b"y" * ics_relay.MAX_BODY_BYTES
        up = self.up(lambda req, n: http_response(200, body))
        self.assertEqual(len(self.fetch(Hooks(up))), ics_relay.MAX_BODY_BYTES)

    def test_total_time_limit_with_slow_drip(self):
        def handler(req, n):
            yield b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
            for _ in range(100):
                time.sleep(0.05)
                yield b"x"

        up = self.up(handler)
        t0 = time.monotonic()
        with mock.patch.object(ics_relay, "TOTAL_TIMEOUT", 0.6):
            with self.assertRaises(ics_relay.RelayError) as cm:
                self.fetch(Hooks(up))
        self.assertEqual(cm.exception.code, "E_TIMEOUT")
        self.assertLess(time.monotonic() - t0, 3)

    def test_silent_upstream_times_out(self):
        up = self.up(lambda req, n: (time.sleep(2), b"")[1])
        with mock.patch.object(ics_relay, "TOTAL_TIMEOUT", 0.4):
            with self.assertRaises(ics_relay.RelayError) as cm:
                self.fetch(Hooks(up))
        self.assertEqual(cm.exception.code, "E_TIMEOUT")

    def test_upstream_error_status_gives_code_only(self):
        up = self.up(lambda req, n: http_response(404, b"secret body token=TEST"))
        with self.assertRaises(ics_relay.RelayError) as cm:
            self.fetch(Hooks(up))
        self.assertEqual(cm.exception.code, "E_UPSTREAM")
        self.assertNotIn("TEST", str(cm.exception))

    def test_connect_failure_message_not_leaked(self):
        def boom(ip, host, timeout):
            raise OSError(f"cannot reach {host} {SECRET_URL}")

        with self.assertRaises(ics_relay.RelayError) as cm:
            ics_relay.fetch_feed(SECRET_URL, resolve=lambda h: [PUBLIC_IP], connect=boom)
        self.assertEqual(str(cm.exception), "E_UPSTREAM")
        self.assertIsNone(cm.exception.__cause__)


class RelayRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="dg-ics-relay-")
        cls._env = {
            "NOTES_ROOT": cls._tmp.name,
            "NOTES_DATA": str(Path(cls._tmp.name) / "data"),
            "NOTES_KEYS": str(Path(cls._tmp.name) / "keys"),
            "NOTES_ALLOWED_CIDRS": "127.0.0.1/32",
            "NOTES_DISABLE_CIDR_GATE": "1",
            "NOTES_ALLOW_REGISTER": "1",
            "NOTES_SECURE_COOKIES": "0",
        }
        os.environ.update(cls._env)
        (Path(cls._tmp.name) / "keys").mkdir(parents=True, exist_ok=True)
        (Path(cls._tmp.name) / "keys" / "flask-secret").write_text("ics-relay-secret", encoding="utf-8")
        for name in list(sys.modules):
            if name in {"app", "auth", "config", "db", "srp_auth", "auth_rate_limit", "plans", "mailer"}:
                sys.modules.pop(name, None)
        cls.app_mod = importlib.import_module("app")
        cls.client = cls.app_mod.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()
        for key in cls._env:
            os.environ.pop(key, None)

    def setUp(self):
        import auth_rate_limit as arl

        arl._hits.clear()
        self.client = self.app_mod.app.test_client()
        self.upstreams: list[FakeUpstream] = []

    def tearDown(self):
        for u in self.upstreams:
            u.close()

    def _login(self):
        import test_agenda_reminders_api as rem

        return rem.AgendaRemindersApiTest._login_free_user(self)

    def _csrf_headers(self):
        import secrets

        with self.client.session_transaction() as sess:
            token = sess.get("csrf") or secrets.token_urlsafe(32)
            sess["csrf"] = token
        return {"X-CSRF-Token": str(token)}

    def _post(self, url=SECRET_URL, **kw):
        return self.client.post("/api/agenda/ics-relay", headers=self._csrf_headers(), json={"url": url}, **kw)

    def _patch_upstream(self, handler, ips=None):
        up = FakeUpstream(handler)
        self.upstreams.append(up)
        h = Hooks(up, ips)
        return h, mock.patch.multiple(ics_relay, resolve_public=h.resolve, connect_pinned=h.connect)

    def test_requires_session(self):
        res = self.client.post("/api/agenda/ics-relay", json={"url": SECRET_URL})
        self.assertIn(res.status_code, (401, 403))
        self.assertNotIn("TEST", res.get_data(as_text=True))
        res = self._post()
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.get_json()["error"], "login required")  # generic API gate answers first

    def test_success_headers(self):
        self._login()
        h, patch = self._patch_upstream(lambda req, n: http_response(200, ICS))
        with patch:
            res = self._post()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_data(), ICS)
        self.assertEqual(res.headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(res.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("no-store", res.headers["Cache-Control"])

    def test_url_in_query_string_is_not_accepted(self):
        self._login()
        res = self.client.post(
            "/api/agenda/ics-relay?url=https://example.invalid/a.ics", headers=self._csrf_headers(), json={}
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json(), {"error": "E_URL"})

    def test_body_over_4kb_refused(self):
        self._login()
        res = self._post(url="https://example.invalid/" + "a" * 5000)
        self.assertEqual(res.status_code, 400)

    def test_rate_limit_30_per_hour_per_user(self):
        self._login()
        h, patch = self._patch_upstream(lambda req, n: http_response(200, ICS))
        with patch:
            for _ in range(30):
                self.assertEqual(self._post().status_code, 200)
            res = self._post()
        self.assertEqual(res.status_code, 429)
        self.assertEqual(res.get_json(), {"error": "E_RATE"})
        # a different user is not affected
        self.client = self.app_mod.app.test_client()
        self._login()
        with patch:
            self.assertEqual(self._post().status_code, 200)

    def test_blocked_and_error_responses_have_only_a_code(self):
        self._login()
        h, patch = self._patch_upstream(
            lambda req, n: http_response(500, b"token=TEST"), {"example.invalid": ["10.0.0.1"]}
        )
        with patch:
            res = self._post()
            self.assertEqual((res.status_code, res.get_json()), (403, {"error": "E_BLOCKED"}))
            res = self._post("http://example.invalid/a.ics?token=TEST")
            self.assertEqual((res.status_code, res.get_json()), (400, {"error": "E_URL"}))
            res = self._post("https://example.invalid:8443/a.ics?token=TEST")
            self.assertEqual(res.get_json(), {"error": "E_URL"})

    def test_no_url_host_token_or_body_in_logs_or_error_responses(self):
        self._login()
        secret_body = b"BEGIN:VCALENDAR\r\nSUMMARY:CONTENT-MARKER-TEST\r\nEND:VCALENDAR\r\n"
        records: list[str] = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage() + "\n" + (self.format(record) if record.exc_info else ""))

        handler = Capture(level=logging.DEBUG)
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        for name in ("werkzeug", "deeperguard.sync", "urllib3", "app"):
            logging.getLogger(name).setLevel(logging.DEBUG)
        responses: list[str] = []
        try:
            scenarios = [
                (lambda req, n: http_response(200, secret_body), None),
                (lambda req, n: http_response(500, secret_body), None),
                (lambda req, n: http_response(302, secret_body, {"Location": "https://internal.invalid/x?token=TEST"}),
                 {"internal.invalid": ["127.0.0.1"]}),
                (lambda req, n: http_response(302, b"", {"Location": "http://example.invalid/?token=TEST"}), None),
                (lambda req, n: http_response(200, b"x" * (ics_relay.MAX_BODY_BYTES + 1)), None),
                (lambda req, n: b"garbage\r\n\r\n", None),
                (lambda req, n: http_response(200, secret_body), {"example.invalid": ["169.254.169.254"]}),
            ]
            for handler_fn, ips in scenarios:
                h, patch = self._patch_upstream(handler_fn, ips)
                with patch:
                    res = self._post()
                if res.status_code != 200:  # a successful answer legitimately carries the feed
                    responses.append(res.get_data(as_text=True))
            # boom inside the relay itself (unexpected exception type)
            with mock.patch.object(ics_relay, "fetch_feed", side_effect=RuntimeError(SECRET_URL)):
                res = self._post()
            self.assertEqual(res.get_json(), {"error": "E_UPSTREAM"})
            responses.append(res.get_data(as_text=True))
            res = self._post("https://example.invalid:8443/x?token=TEST")
            responses.append(res.get_data(as_text=True))
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        for text in records + responses:
            for needle in ("example.invalid", "token=TEST", "TEST", "internal.invalid", "CONTENT-MARKER", "feed.ics"):
                self.assertNotIn(needle, text, needle)


if __name__ == "__main__":
    unittest.main()
