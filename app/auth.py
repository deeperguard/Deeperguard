"""LAN CIDR gate, sessions, CSRF, and account auth."""
from __future__ import annotations

import hmac
import ipaddress
import json
import os
import secrets
import time
import urllib.error
import urllib.request

from flask import request, session

from config import SESSION_SECONDS, skip_login
from db import (
    create_user_session,
    get_first_user,
    get_session_by_token,
    get_user_by_id,
    revoke_session_by_token,
    touch_user_session,
)
from passwords import verify_password
from totp import verify as totp_verify

SESSION_USER = "uid"
SESSION_AUTH = "authed"
SESSION_EXP = "exp"
SESSION_CSRF = "csrf"
SESSION_TOTP = "totp_ok"
SESSION_SRP = "srp_state"
SESSION_SRP_EMAIL = "srp_email"
SESSION_SID = "sid"

_GEO_CACHE: dict[str, str] = {}


def client_ip() -> str:
    remote = str(request.remote_addr or "").strip()
    hops = 0
    try:
        from config import trust_proxy_hops

        hops = trust_proxy_hops()
    except Exception:
        hops = 0
    # Only honor X-Forwarded-For from a local reverse proxy (cloudflared).
    if hops > 0 and remote in {"127.0.0.1", "::1"}:
        forwarded = str(request.headers.get("X-Forwarded-For") or "").strip()
        if forwarded:
            parts = [part.strip() for part in forwarded.split(",") if part.strip()]
            if parts:
                idx = max(0, len(parts) - hops)
                return parts[idx]
    return remote


def device_label(user_agent: str = "") -> str:
    ua = user_agent or str(request.headers.get("User-Agent") or "")
    if "iPhone" in ua:
        device = "iPhone"
    elif "iPad" in ua:
        device = "iPad"
    elif "Android" in ua:
        device = "Android"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        device = "Mac"
    elif "Windows" in ua:
        device = "Windows"
    elif "Linux" in ua:
        device = "Linux"
    else:
        device = "Unknown device"
    if "Edg/" in ua or "Edge/" in ua:
        browser = "Edge"
    elif "CriOS/" in ua or ("Chrome/" in ua and "Chromium" not in ua):
        browser = "Chrome"
    elif "FxiOS/" in ua or "Firefox/" in ua:
        browser = "Firefox"
    elif "Safari/" in ua and "Chrome" not in ua and "CriOS" not in ua:
        browser = "Safari"
    else:
        browser = "Browser"
    return f"{device} · {browser}"


def ip_location(ip: str = "") -> str:
    addr = (ip or client_ip() or "").strip()
    try:
        parsed = ipaddress.ip_address(addr)
        if parsed.is_private or parsed.is_loopback or parsed.is_link_local:
            return "Local network"
    except ValueError:
        return "Unknown"
    city = str(request.headers.get("CF-IPCity") or "").strip()
    country = str(request.headers.get("CF-IPCountry") or "").strip().upper()
    if country in {"", "XX", "T1"}:
        country = ""
    if city and country:
        return f"{city}, {country}"
    if country:
        return country
    if city:
        return city
    return _lookup_ip_location(addr)


def _lookup_ip_location(ip: str) -> str:
    if ip in _GEO_CACHE:
        return _GEO_CACHE[ip]
    if os.environ.get("NOTES_GEOIP", "1") != "1":
        return "Unknown"
    loc = "Unknown"
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,country,city"
        with urllib.request.urlopen(url, timeout=1.2) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        if isinstance(data, dict) and data.get("status") == "success":
            parts = [str(data.get("city") or "").strip(), str(data.get("country") or "").strip()]
            loc = ", ".join(part for part in parts if part) or "Unknown"
    except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        loc = "Unknown"
    _GEO_CACHE[ip] = loc
    return loc


def current_session_token() -> str:
    return str(session.get(SESSION_SID) or "")


def request_device_id() -> str:
    from db import normalize_device_id

    return normalize_device_id(str(request.headers.get("X-Device-Id") or ""))


def _record_device_session(user_id: int, *, login: bool = True) -> str:
    ip = client_ip()
    ua = str(request.headers.get("User-Agent") or "")
    return create_user_session(
        int(user_id),
        device_label=device_label(ua),
        user_agent=ua,
        ip=ip,
        ip_location=ip_location(ip),
        device_id=request_device_id(),
        login=login,
    )


def ensure_device_session() -> None:
    if not session.get(SESSION_AUTH):
        return
    try:
        uid = int(session.get(SESSION_USER))
    except (TypeError, ValueError):
        return
    token = current_session_token()
    if token:
        row = get_session_by_token(token)
        if row and not row["revoked_at"] and int(row["user_id"]) == uid:
            ip = client_ip()
            touch_user_session(int(row["id"]), ip=ip, ip_location=ip_location(ip))
            return
        session.pop(SESSION_SID, None)
    try:
        session[SESSION_SID] = _record_device_session(uid, login=False)
        session.modified = True
    except Exception:
        pass


def client_allowed() -> bool:
    try:
        from config import cidr_gate_enabled

        if not cidr_gate_enabled():
            return True
    except Exception:
        pass
    from config import ALLOWED_CIDRS

    ip = client_ip()
    if ip in {"127.0.0.1", "::1"}:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.is_loopback:
        return True
    for raw in ALLOWED_CIDRS:
        try:
            network = ipaddress.ip_network(raw, strict=False)
        except ValueError:
            continue
        if addr in network:
            return True
    return False


def login_user(user_id: int, *, totp_ok: bool) -> None:
    session.clear()
    session.permanent = True
    session[SESSION_USER] = int(user_id)
    session[SESSION_AUTH] = True
    session[SESSION_EXP] = time.time() + SESSION_SECONDS
    session[SESSION_CSRF] = secrets.token_urlsafe(32)
    session[SESSION_TOTP] = bool(totp_ok)
    session[SESSION_SID] = _record_device_session(int(user_id))


def logout() -> None:
    token = current_session_token()
    if token:
        revoke_session_by_token(token)
    session.clear()


def current_user_id() -> int | None:
    if not authenticated():
        return None
    uid = session.get(SESSION_USER)
    try:
        return int(uid)
    except (TypeError, ValueError):
        return None


def authenticated() -> bool:
    if not session.get(SESSION_AUTH):
        return False
    if float(session.get(SESSION_EXP) or 0) < time.time():
        return False
    token = current_session_token()
    if not token:
        return True
    row = get_session_by_token(token)
    if not row or row["revoked_at"]:
        return False
    try:
        return int(row["user_id"]) == int(session.get(SESSION_USER) or 0)
    except (TypeError, ValueError):
        return False


def slide_session() -> None:
    """Extend the session expiration for active authenticated sessions."""
    if not authenticated():
        return
    exp = float(session.get(SESSION_EXP) or 0)
    now = time.time()
    if exp - now < SESSION_SECONDS - 3600:
        session.permanent = True
        session[SESSION_EXP] = now + SESSION_SECONDS
        session.modified = True
    ensure_device_session()


def ensure_skip_login_session() -> bool:
    if not skip_login():
        return False
    try:
        from config import cidr_gate_enabled

        # Never auto-login the first user on a public (CIDR-open) host.
        if not cidr_gate_enabled():
            return False
    except Exception:
        return False
    if authenticated():
        return True
    user = get_first_user()
    if not user:
        return False
    login_user(int(user["id"]), totp_ok=True)
    return True


def totp_satisfied() -> bool:
    return bool(session.get(SESSION_TOTP))


def needs_totp() -> bool:
    uid = current_user_id()
    if not uid:
        return False
    user = get_user_by_id(uid)
    if not user:
        return False
    return bool(user["totp_enabled"]) and not totp_satisfied()


def verify_credentials(email: str, password: str) -> tuple[int | None, bool]:
    from db import get_user_by_email

    user = get_user_by_email(email)
    if not user:
        return None, False
    if not verify_password(user["password_hash"], password):
        return None, False
    totp_required = bool(user["totp_enabled"])
    return int(user["id"]), totp_required


def verify_totp_for_current_user(code: str) -> bool:
    uid = current_user_id()
    if not uid:
        return False
    user = get_user_by_id(uid)
    if not user or not user["totp_secret"]:
        return False
    if not totp_verify(str(user["totp_secret"]), code):
        return False
    session[SESSION_TOTP] = True
    return True


def csrf_token() -> str:
    token = session.get(SESSION_CSRF)
    if not token:
        token = secrets.token_urlsafe(32)
        session[SESSION_CSRF] = token
    return str(token)


def csrf_ok() -> bool:
    expected = session.get(SESSION_CSRF)
    if not expected:
        return False
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token") or ""
    if not supplied:
        body = request.get_json(silent=True) or {}
        if isinstance(body, dict):
            supplied = str(body.get("csrf_token") or "")
    return bool(supplied) and hmac.compare_digest(str(expected), str(supplied))


def _canonical_site_hosts() -> set[str]:
    """www + apex of the public notes host only — not pool.* or other siblings."""
    from config import normalize_host, webauthn_default_rp_id, webauthn_preferred_host

    hosts: set[str] = set()
    public = normalize_host(os.environ.get("NOTES_PUBLIC_HOST", "") or webauthn_preferred_host())
    rp_id = webauthn_default_rp_id()
    for raw in (public, rp_id):
        host = normalize_host(raw)
        if not host:
            continue
        hosts.add(host)
        if host.startswith("www."):
            hosts.add(host[4:])
        else:
            hosts.add(f"www.{host}")
    return hosts


def _hosts_match(h1: str, h2: str) -> bool:
    if not h1 or not h2:
        return False
    from config import normalize_host

    n1 = normalize_host(h1)
    n2 = normalize_host(h2)
    if n1 == n2:
        return True
    allowed = _canonical_site_hosts()
    return bool(n1 and n2 and n1 in allowed and n2 in allowed)


def request_is_same_origin() -> bool:
    """Validate that the request originated from the same origin or allowed subdomain.
    Checks Sec-Fetch-Site first; falls back to Origin / Referer host comparison.
    """
    sec_site = (request.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if sec_site:
        if sec_site not in {"same-origin", "none", "same-site"}:
            return False

    req_host = ""
    try:
        from urllib.parse import urlparse

        req_host = (urlparse(f"//{request.host}").hostname or "").strip().lower()
    except Exception:
        req_host = (request.host or "").split(":", 1)[0].strip("[]").lower()

    origin = (request.headers.get("Origin") or "").strip()
    origin_host = ""
    if origin:
        if origin.lower() == "null":
            return False
        try:
            from urllib.parse import urlparse

            origin_host = (urlparse(origin).hostname or "").strip().lower()
        except Exception:
            return False
        if not _hosts_match(origin_host, req_host):
            return False

    referer = (request.headers.get("Referer") or "").strip()
    referer_host = ""
    if referer:
        try:
            from urllib.parse import urlparse

            referer_host = (urlparse(referer).hostname or "").strip().lower()
        except Exception:
            return False
        if not _hosts_match(referer_host, req_host):
            return False

    # same-site includes sibling subdomains (pool.deeperguard.com). Require an
    # Origin/Referer that matches the notes host — do not accept same-site alone.
    if sec_site == "same-site" and not origin_host and not referer_host:
        return False

    return True


def public_path(path: str) -> bool:
    from config import app_entry_path

    base = path.split("?", 1)[0]
    if base in {"/", app_entry_path(), "/pricing", "/login", "/register", "/privacy", "/terms", "/self-host", "/api/health", "/api/app-shell", "/ca.crt"} or base.startswith("/static/"):
        return True
    if base in {"/manifest.json", "/sw.js"}:
        return True
    if base.startswith("/api/auth/"):
        return True
    if base in {"/api/contact", "/api/promo", "/robots.txt", "/sitemap.xml"}:
        return True
    from config import INDEXNOW_KEY

    if INDEXNOW_KEY and base == f"/{INDEXNOW_KEY}.txt":
        return True
    return False


def cacheable_shell(path: str) -> bool:
    """HTML/PWA files that must stay cookie-free so Safari can cache them offline."""
    from config import app_entry_path

    base = path.split("?", 1)[0]
    return base in {"/", app_entry_path(), "/manifest.json", "/sw.js", "/ca.crt", "/api/app-shell"} or base.startswith("/static/")


def bootstrap_path(path: str, method: str) -> bool:
    """Session bootstrap for cached PWA shells without cookies."""
    base = path.split("?", 1)[0]
    return base == "/api/account/unlock" and method.upper() == "POST"


def store_srp_state(email: str, state: dict) -> None:
    session[SESSION_SRP_EMAIL] = email.strip().lower()
    session[SESSION_SRP] = state


def pop_srp_state(email: str) -> dict | None:
    stored_email = str(session.get(SESSION_SRP_EMAIL) or "").strip().lower()
    if stored_email != email.strip().lower():
        return None
    state = session.pop(SESSION_SRP, None)
    session.pop(SESSION_SRP_EMAIL, None)
    return state if isinstance(state, dict) else None


def auth_exempt_path(path: str) -> bool:
    base = path.split("?", 1)[0]
    return public_path(base) or base in {"/api/account/unlock", "/api/sync/pull"}


def security_headers() -> dict[str, str]:
    headers = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    }
    if os.environ.get("NOTES_SECURE_COOKIES", "0") == "1":
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return headers
