"""Relay for agenda (.ics) feed links, see docs/ICS_SUBSCRIBE_SPEC.md section 4.

The signed-in client posts a feed URL here and gets the feed text back. Nothing
is stored or logged: not the URL, not the host, not the content. This module
never calls a logger, and every failure is reduced to a fixed code, so no
exception text (which could contain the URL or host) leaves it.

SSRF protection: the host is resolved once, every address must be globally
routable, and the connection goes to that validated address (pinned) with the
original host used for SNI, certificate checks and the Host header. Redirects
are followed by hand (max 3) and each one is fully re-validated.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit

MAX_URL_CHARS = 2048
MAX_BODY_BYTES = 2 * 1024 * 1024
TOTAL_TIMEOUT = 10.0
MAX_REDIRECTS = 3
USER_AGENT = "Mozilla/5.0 (compatible; calendar-feed-fetcher)"
_REDIRECT_STATUS = {301, 302, 303, 307, 308}

# code -> HTTP status (subset of the fixed set in the spec)
STATUS = {
    "E_URL": 400,
    "E_AUTH": 401,
    "E_BLOCKED": 403,
    "E_RATE": 429,
    "E_TOO_LARGE": 413,
    "E_REDIRECT": 502,
    "E_UPSTREAM": 502,
    "E_TIMEOUT": 504,
}

_DENY_NETS = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "100.64.0.0/10",
        "169.254.0.0/16",
        "192.0.0.0/24",
        "198.18.0.0/15",
        "64:ff9b::/96",  # NAT64
        "64:ff9b:1::/48",  # local-use NAT64
        "2001::/32",  # Teredo
        "2002::/16",  # 6to4
        "fd00:ec2::/32",  # AWS IPv6 metadata
    )
]


class RelayError(Exception):
    """Carries only a fixed code; never a message from the network."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def ip_allowed(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip_allowed(str(ip.ipv4_mapped))
    if (
        ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified or not ip.is_global
    ):
        return False
    return not any(ip in net for net in _DENY_NETS if net.version == ip.version)


def parse_url(url: object, *, redirect: bool = False) -> tuple[str, str]:
    """Return (host, path+query). Raises RelayError."""
    bad = "E_REDIRECT" if redirect else "E_URL"
    if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS:
        raise RelayError("E_URL")
    if any(ord(c) <= 32 or ord(c) >= 127 for c in url):
        raise RelayError(bad)
    try:
        parts = urlsplit(url)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise RelayError(bad) from None
    if parts.scheme.lower() != "https" or parts.username is not None or parts.password is not None:
        raise RelayError(bad)
    if port not in (None, 443) or not host or "%" in host or "\\" in url:
        raise RelayError(bad)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return host.lower(), path


def resolve_public(host: str) -> list[str]:
    """Resolve once; refuse if ANY address is not allowed."""
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise RelayError("E_UPSTREAM") from None
    addrs: list[str] = []
    for info in infos:
        a = info[4][0]
        if a not in addrs:
            addrs.append(a)
    if not addrs:
        raise RelayError("E_UPSTREAM")
    if not all(ip_allowed(a) for a in addrs):
        raise RelayError("E_BLOCKED")
    return addrs


def connect_pinned(ip: str, host: str, timeout: float):
    """TCP connect to the validated ip; TLS with SNI + cert check for host."""
    raw = socket.create_connection((ip, 443), timeout=timeout)
    try:
        ctx = ssl.create_default_context()
        return ctx.wrap_socket(raw, server_hostname=host)
    except BaseException:
        raw.close()
        raise


class _PinnedConnection(http.client.HTTPConnection):
    def __init__(self, sock, host: str, timeout: float):
        super().__init__(host, 443, timeout=timeout)
        self._pinned = sock

    def connect(self):
        self.sock = self._pinned


def _fetch_once(host: str, path: str, addrs: list[str], deadline: float, connect):
    """One request. Returns ('ok', bytes) or ('redirect', location)."""
    sock = None
    last: Exception | None = None
    for ip in addrs[:4]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RelayError("E_TIMEOUT")
        try:
            sock = connect(ip, host, remaining)
            break
        except Exception as err:  # noqa: BLE001 - message may hold the host; keep nothing
            last = err
    if sock is None:
        if isinstance(last, (socket.timeout, TimeoutError)):
            raise RelayError("E_TIMEOUT")
        raise RelayError("E_UPSTREAM")
    conn = _PinnedConnection(sock, host, max(0.1, deadline - time.monotonic()))
    try:
        conn.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host)
        conn.putheader("User-Agent", USER_AGENT)
        conn.putheader("Accept", "text/calendar, text/plain, */*;q=0.5")
        conn.putheader("Accept-Encoding", "identity")
        conn.putheader("Connection", "close")
        conn.endheaders()
        sock.settimeout(max(0.1, deadline - time.monotonic()))
        resp = conn.getresponse()
        if resp.status in _REDIRECT_STATUS:
            loc = resp.getheader("Location")
            if not loc:
                raise RelayError("E_REDIRECT")
            return "redirect", loc
        if not 200 <= resp.status < 300:
            raise RelayError("E_UPSTREAM")
        length = resp.getheader("Content-Length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            raise RelayError("E_TOO_LARGE")
        chunks: list[bytes] = []
        total = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RelayError("E_TIMEOUT")
            if sock.fileno() != -1:  # http.client closes it once the body is complete
                sock.settimeout(max(0.05, remaining))
            chunk = resp.read1(65536)  # one recv at a time, so slow drips hit the deadline
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                raise RelayError("E_TOO_LARGE")
            chunks.append(chunk)
        return "ok", b"".join(chunks)
    except RelayError:
        raise
    except (socket.timeout, TimeoutError):
        raise RelayError("E_TIMEOUT") from None
    except Exception:  # noqa: BLE001 - http.client/ssl messages can contain the host
        raise RelayError("E_UPSTREAM") from None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass


def fetch_feed(url: object, *, resolve=None, connect=None) -> bytes:
    """Fetch ``url`` under the SSRF rules. Raises RelayError(code) only."""
    resolve = resolve or resolve_public
    connect = connect or connect_pinned
    deadline = time.monotonic() + TOTAL_TIMEOUT
    redirects = 0
    current = url
    try:
        while True:
            host, path = parse_url(current, redirect=redirects > 0)
            addrs = resolve(host)
            kind, value = _fetch_once(host, path, addrs, deadline, connect)
            if kind == "ok":
                return value
            redirects += 1
            if redirects > MAX_REDIRECTS:
                raise RelayError("E_REDIRECT")
            try:
                current = urljoin(f"https://{host}{path}", value.strip())
            except ValueError:
                raise RelayError("E_REDIRECT") from None
    except RelayError:
        raise
    except Exception:  # noqa: BLE001 - never leak exception text
        raise RelayError("E_UPSTREAM") from None
