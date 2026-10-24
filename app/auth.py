"""LAN CIDR gate, sessions, CSRF, and account auth."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
import urllib.error
import urllib.request

from flask import g, request, session

from config import SESSION_SECONDS, skip_login
from db import (
    consume_srp_challenge,
    create_srp_challenge,
    create_user_session,
    find_reusable_session,
    get_first_user,
    get_latest_session_for_device,
    get_session_by_token,
    get_user_by_id,
    get_user_by_email,
    list_user_sessions,
    prune_user_sessions,
    revoke_session_by_token,
    touch_user_session,
    user_plan,
)
from passwords import verify_password
from plans import plan_active_session_limit
from totp import verify as totp_verify


class SessionCapExceeded(Exception):
    """Raised when a new device session would exceed the plan soft cap.

    Existing sessions are never revoked automatically.
    """

    def __init__(self, payload: dict, *, user_id: int):
        self.payload = payload
        self.user_id = int(user_id)
        super().__init__(str(payload.get("error") or "session_cap"))

SESSION_USER = "uid"
SESSION_CAP_REVOKE = "session_cap_revoke"
SESSION_CAP_REVOKE_SECONDS = 600
SESSION_CAP_PENDING = "session_cap_pending"
SESSION_AUTH = "authed"
SESSION_EXP = "exp"
SESSION_CSRF = "csrf"
SESSION_TOTP = "totp_ok"
SESSION_SRP_LOGIN_CHALLENGE = "srp_login_challenge_id"
SESSION_SRP_CRED_CHALLENGE = "srp_cred_challenge_id"
# Legacy keys (pre server-side SRP store) — must never hold private state again.
SESSION_SRP = "srp_state"
SESSION_SRP_EMAIL = "srp_email"
SESSION_SRP_CRED = "srp_cred_state"
SESSION_SRP_CRED_EMAIL = "srp_cred_email"
SESSION_SRP_CRED_SALT = "srp_cred_salt"
SESSION_SRP_CRED_VERIFIER = "srp_cred_verifier"

SRP_PURPOSE_LOGIN = "login"
SRP_PURPOSE_REPAIR_LOGIN = "repair-login"
SRP_PURPOSE_VAULT_RECOVERY = "vault-recovery"
SRP_PURPOSE_PASSWORD_CHANGE = "password-change"
SRP_PURPOSE_UNLOCK = "account-unlock"
SRP_PURPOSE_KDF_UPGRADE = "kdf-upgrade"
SESSION_PW_ROTATION = "pw_rotation"
SESSION_SID = "sid"

PASSWORD_ROTATION_SECONDS = int(os.environ.get("NOTES_PASSWORD_ROTATION_SECONDS", "600"))

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
    if os.environ.get("NOTES_GEOIP", "0") != "1":
        return "Unknown"
    loc = "Unknown"
    try:
        url = f"https://ip-api.com/json/{ip}?fields=status,country,city"
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


def session_cap_public_row(row) -> dict:
    """Cap UI row: location only (no full IP), matching new-device email (#186)."""
    return {
        "id": int(row["id"]),
        "device": str(row["device_label"] or "Unknown device"),
        "ip_location": str(row["ip_location"] or "Unknown"),
        "last_login_at": float(row["last_login_at"] or 0),
        "last_seen_at": float(row["last_seen_at"] or 0),
    }


def _session_cap_payload(user_id: int, *, limit: int, plan: str) -> dict:
    """Public sessions list for the sign-in device-limit error (no auto-revoke)."""
    prune_user_sessions(int(user_id), older_than=time.time() - SESSION_SECONDS)
    rows = list_user_sessions(int(user_id), active_since=time.time() - SESSION_SECONDS)
    sessions = [session_cap_public_row(row) for row in rows]
    return {
        "error": session_cap_message(limit=int(limit), plan=plan, totp_required=False),
        "code": "session_cap",
        "limit": int(limit),
        "plan": str(plan or ""),
        "sessions": sessions,
    }


def session_cap_message(*, limit: int, plan: str, totp_required: bool = False) -> str:
    """Plain session-cap copy (no device list). Used when TOTP is still required."""
    n = int(limit)
    plan_label = str(plan or "free").capitalize()
    devices = f"{n} signed-in device{'s' if n != 1 else ''}"
    base = f"Your {plan_label} plan allows {devices}, and all {n} are in use. "
    if totp_required:
        return base + "Enter your 2FA code, then sign out a device to continue."
    return base + "Sign out one below, then sign in again, or upgrade."


def _assert_session_slot_available(user_id: int) -> None:
    """Block creating a *new* device session when the plan soft cap is full.

    Reusing an existing live session for this device is always allowed.
    Never auto-revokes; never touches existing sessions.
    """
    user = get_user_by_id(int(user_id))
    if not user:
        return
    plan = user_plan(user)
    limit = plan_active_session_limit(plan)
    if limit is None:
        return
    ip = client_ip()
    ua = str(request.headers.get("User-Agent") or "")
    label = device_label(ua)
    device_id = request_device_id()
    if find_reusable_session(
        int(user_id), device_id=device_id, ip=ip, device_label=label
    ):
        return
    prune_user_sessions(int(user_id), older_than=time.time() - SESSION_SECONDS)
    active = list_user_sessions(
        int(user_id), active_since=time.time() - SESSION_SECONDS
    )
    if len(active) >= int(limit):
        raise SessionCapExceeded(
            _session_cap_payload(int(user_id), limit=int(limit), plan=plan),
            user_id=int(user_id),
        )


def issue_session_cap_revoke(user_id: int) -> str:
    """Short-lived proof after a successful password/SRP check at the session cap.

    Lets the blocked client revoke a listed device without creating a new session.
    Bound to ``user_id`` for SESSION_CAP_REVOKE_SECONDS (not transferable).
    """
    token = secrets.token_urlsafe(24)
    session[SESSION_CAP_REVOKE] = {
        "uid": int(user_id),
        "token": token,
        "exp": time.time() + SESSION_CAP_REVOKE_SECONDS,
    }
    session.modified = True
    return token


def session_cap_revoke_uid(token: str) -> int | None:
    """Return user id when ``token`` matches a live session-cap revoke proof.

    The token is bound to the uid stored in the Flask session; it cannot revoke
    another user's devices even if a foreign session_id is supplied.
    """
    data = session.get(SESSION_CAP_REVOKE)
    if not isinstance(data, dict):
        return None
    if str(data.get("token") or "") != str(token or "").strip():
        return None
    if float(data.get("exp") or 0) < time.time():
        session.pop(SESSION_CAP_REVOKE, None)
        session.modified = True
        return None
    try:
        return int(data["uid"])
    except (KeyError, TypeError, ValueError):
        return None


def clear_session_cap_revoke() -> None:
    if SESSION_CAP_REVOKE in session:
        session.pop(SESSION_CAP_REVOKE, None)
        session.modified = True


def begin_session_cap_totp(user_id: int) -> None:
    """Partial auth after password/SRP/passkey at the session cap when TOTP is required.

    Establishes a Flask session so ``/totp`` can run, but does not create a device
    session row and does not issue a revoke token or session list.
    """
    session.clear()
    session.permanent = True
    session[SESSION_USER] = int(user_id)
    session[SESSION_AUTH] = True
    session[SESSION_EXP] = time.time() + SESSION_SECONDS
    session[SESSION_CSRF] = secrets.token_urlsafe(32)
    session[SESSION_TOTP] = False
    session[SESSION_CAP_PENDING] = True
    session.modified = True


def session_cap_pending() -> bool:
    return bool(session.get(SESSION_CAP_PENDING))


def finish_session_cap_pending() -> None:
    """After TOTP on a session-cap-pending login, create the device session or raise."""
    if not session.get(SESSION_CAP_PENDING):
        return
    try:
        uid = int(session.get(SESSION_USER))
    except (TypeError, ValueError):
        session.pop(SESSION_CAP_PENDING, None)
        session.modified = True
        return
    _assert_session_slot_available(uid)
    session.pop(SESSION_CAP_PENDING, None)
    session[SESSION_TOTP] = True
    session[SESSION_SID] = _record_device_session(uid, check_cap=False)
    session.modified = True


def issue_session_cap_revoke_exclusive(user_id: int) -> str:
    """Replace the Flask session with only a uid-bound revoke proof.

    Used after TOTP when the soft-cap still blocks a new device session.
    """
    token = secrets.token_urlsafe(24)
    session.clear()
    session[SESSION_CAP_REVOKE] = {
        "uid": int(user_id),
        "token": token,
        "exp": time.time() + SESSION_CAP_REVOKE_SECONDS,
    }
    session.modified = True
    return token


def _record_device_session(
    user_id: int, *, login: bool = True, check_cap: bool = True
) -> str:
    if check_cap:
        _assert_session_slot_available(int(user_id))
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


def _align_session_with_request(_user_id: int, row) -> str:
    """Refresh THIS cookie's own session row — never another live row.

    L-17: an authenticated request that names another live same-user
    ``X-Device-Id`` must not adopt that row or rotate its token (that would
    invalidate the other browser's cookie). Only retitle this cookie's row
    when it already names this device or has no device id yet.

    Round 72: freeze ``device_label`` at login (or the first non-empty label).
    Later requests may refresh last_seen / IP / location and record the current
    user_agent, but DevTools emulation must not rename the row.
    """
    ua = str(request.headers.get("User-Agent") or "")
    label = device_label(ua)
    device_id = request_device_id()
    ip = client_ip()
    loc = ip_location(ip)
    cookie_device = str(row["device_id"] or "")
    if cookie_device and cookie_device != device_id:
        # This cookie belongs to a known device the request did not name.
        # Keep its label; do not adopt or rotate a different live row.
        touch_user_session(int(row["id"]), ip=ip, ip_location=loc)
        return ""
    stored_label = str(row["device_label"] or "")
    stored_ua = str(row["user_agent"] or "")
    # Freeze label once set; only fill when the row still has no label.
    next_label = "" if stored_label else label
    if (next_label and stored_label != next_label) or (ua and stored_ua != ua[:300]):
        touch_user_session(
            int(row["id"]),
            ip=ip,
            ip_location=loc,
            user_agent=ua,
            device_label=next_label,
        )
    else:
        touch_user_session(int(row["id"]), ip=ip, ip_location=loc)
    return ""


def ensure_device_session() -> None:
    if not session.get(SESSION_AUTH):
        return
    # Cap-pending logins must not create a device row (or leak slots) before TOTP.
    if session.get(SESSION_CAP_PENDING):
        return
    try:
        uid = int(session.get(SESSION_USER))
    except (TypeError, ValueError):
        return
    token = current_session_token()
    if token:
        row = get_session_by_token(token)
        if row and not row["revoked_at"] and int(row["user_id"]) == uid:
            rebound = _align_session_with_request(uid, row)
            if rebound:
                session[SESSION_SID] = rebound
                session.modified = True
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


def login_user(user_id: int, *, totp_ok: bool, check_cap: bool = True) -> None:
    # Cap check before clearing the Flask session so a blocked sign-in leaves
    # the browser's prior anonymous/CSRF state intact.
    if check_cap:
        _assert_session_slot_available(int(user_id))
    session.clear()
    session.permanent = True
    session[SESSION_USER] = int(user_id)
    session[SESSION_AUTH] = True
    session[SESSION_EXP] = time.time() + SESSION_SECONDS
    session[SESSION_CSRF] = secrets.token_urlsafe(32)
    session[SESSION_TOTP] = bool(totp_ok)
    session[SESSION_SID] = _record_device_session(int(user_id), check_cap=False)


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


def _session_row_requires_wipe(row) -> bool:
    if not row or not row["revoked_at"]:
        return False
    return str(row["revoke_reason"] or "") == "user"


def session_requires_wipe() -> bool:
    """True when this device was remotely signed out and must drop local vault data."""
    token = current_session_token()
    if token:
        row = get_session_by_token(token)
        if _session_row_requires_wipe(row):
            return True
    device_id = request_device_id()
    if not device_id:
        return False
    # A device id is shared by every account that used this browser. When the
    # (expired) cookie still names an account, only that account's sessions
    # may tell the device to wipe; another account's remote sign-out must not
    # erase this one's local vault.
    user_id = None
    try:
        if session.get(SESSION_USER) is not None:
            user_id = int(session.get(SESSION_USER))
    except (TypeError, ValueError):
        user_id = None
    return _session_row_requires_wipe(get_latest_session_for_device(device_id, user_id=user_id))


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
    from auth_rate_limit import allow as rate_allow
    from db import set_user_totp_last_step, user_totp_last_step
    from totp import verify_and_step

    uid = current_user_id()
    if not uid:
        return False
    user = get_user_by_id(uid)
    if not user or not user["totp_secret"]:
        return False
    # Per-user attempt limit (IP-independent).
    if not rate_allow(f"totp-user:{uid}", limit=10, window=300.0):
        return False
    last_step = user_totp_last_step(user)
    ok, step = verify_and_step(str(user["totp_secret"]), code, last_step=last_step)
    if not ok:
        return False
    if step:
        set_user_totp_last_step(uid, step)
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
    if base in {
        "/",
        app_entry_path(),
        "/pricing",
        "/compare/standard-notes",
        "/compare/notesnook",
        "/compare/joplin",
        "/evernote-alternative",
        "/for/freelancers",
        "/login",
        "/register",
        "/privacy",
        "/terms",
        "/contact",
        "/download",
        "/self-host",
        "/verify",
        "/api/health",
        "/api/app-shell",
        "/ca.crt",
        "/favicon.ico",
    } or base.startswith("/static/"):
        return True
    if base in {"/manifest.json", "/sw.js"}:
        return True
    # Only genuinely pre-login auth routes are public (M3). Passkey management
    # and other post-login /api/auth/* routes require a session + CSRF + 2FA.
    if base in {
        "/api/auth/srp/challenge",
        "/api/auth/srp/verify",
        "/api/auth/srp/register",
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/webauthn/login/options",
        "/api/auth/webauthn/login/verify",
        # Login-adjacent recovery / drift repair (password never leaves the client
        # as a stored verifier proof). Kept public so sign-in still works.
        "/api/auth/repair-login",
        "/api/auth/repair-login/challenge",
        # verify-vault is prove-only (no verifier write). resync is a pre-login
        # leftover-hash repair; the handler 403s a TOTP-pending session.
        "/api/auth/verify-vault",
        "/api/auth/srp/resync",
        # After a successful proof that hits the plan session soft-cap: revoke one
        # listed device (token-gated; never auto-revokes).
        "/api/auth/session-cap/revoke",
        # vault-recovery and srp/upgrade write salt/verifier. They require a
        # session and must not skip the 2FA gate (L-22; same as kdf-upgrade).
    }:
        return True
    if base in {"/api/contact", "/api/promo", "/robots.txt", "/sitemap.xml", "/.well-known/security.txt"}:
        return True
    from config import INDEXNOW_KEY

    if INDEXNOW_KEY and base == f"/{INDEXNOW_KEY}.txt":
        return True
    return False


def cacheable_shell(path: str) -> bool:
    """HTML/PWA files that must stay cookie-free so Safari can cache them offline."""
    from config import app_entry_path

    base = path.split("?", 1)[0]
    return base in {"/", app_entry_path(), "/manifest.json", "/sw.js", "/ca.crt", "/favicon.ico", "/api/app-shell"} or base.startswith("/static/")


def bootstrap_path(path: str, method: str) -> bool:
    """Session bootstrap for cached PWA shells without cookies."""
    base = path.split("?", 1)[0]
    return base == "/api/account/unlock" and method.upper() == "POST"


def _clear_legacy_srp_session_keys() -> None:
    for key in (
        SESSION_SRP,
        SESSION_SRP_EMAIL,
        SESSION_SRP_CRED,
        SESSION_SRP_CRED_EMAIL,
        SESSION_SRP_CRED_SALT,
        SESSION_SRP_CRED_VERIFIER,
    ):
        session.pop(key, None)


def _user_id_for_email(email: str) -> int | None:
    user = get_user_by_email(email.strip().lower())
    if not user:
        return None
    return int(user["id"])


def store_srp_state(email: str, state: dict, srp_salt: str, srp_verifier: str) -> None:
    uid = _user_id_for_email(email)
    if uid is None:
        return
    _clear_legacy_srp_session_keys()
    challenge_id = create_srp_challenge(
        purpose=SRP_PURPOSE_LOGIN,
        user_id=uid,
        email=email,
        state=state,
        srp_salt=srp_salt,
        srp_verifier=srp_verifier,
    )
    session[SESSION_SRP_LOGIN_CHALLENGE] = challenge_id


def pop_srp_state(email: str, srp_salt: str, srp_verifier: str) -> dict | None:
    if session.get(SESSION_SRP) or session.get(SESSION_SRP_CRED):
        _clear_legacy_srp_session_keys()
        return None
    challenge_id = str(session.pop(SESSION_SRP_LOGIN_CHALLENGE, None) or "").strip()
    if not challenge_id:
        return None
    uid = _user_id_for_email(email)
    if uid is None:
        return None
    return consume_srp_challenge(
        challenge_id,
        purpose=SRP_PURPOSE_LOGIN,
        email=email,
        user_id=uid,
        srp_salt=srp_salt,
        srp_verifier=srp_verifier,
    )


def store_srp_credential_challenge(
    email: str,
    srp_salt: str,
    srp_verifier: str,
    state: dict,
    purpose: str,
    user_id: int,
) -> None:
    _clear_legacy_srp_session_keys()
    challenge_id = create_srp_challenge(
        purpose=purpose,
        user_id=int(user_id),
        email=email,
        state=state,
        srp_salt=srp_salt,
        srp_verifier=srp_verifier,
    )
    session[SESSION_SRP_CRED_CHALLENGE] = challenge_id


def issue_password_rotation_token(user_id: int) -> str:
    """Short-lived proof that the current password was verified before vault re-key."""
    token = secrets.token_urlsafe(32)
    session[SESSION_PW_ROTATION] = {
        "uid": int(user_id),
        "hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
        "exp": time.time() + PASSWORD_ROTATION_SECONDS,
    }
    return token


def peek_password_rotation_token(user_id: int) -> bool:
    row = session.get(SESSION_PW_ROTATION)
    if not isinstance(row, dict):
        return False
    if int(row.get("uid") or 0) != int(user_id):
        return False
    return time.time() <= float(row.get("exp") or 0)


def consume_password_rotation_token(user_id: int, token: str) -> bool:
    row = session.get(SESSION_PW_ROTATION)
    if not isinstance(row, dict):
        return False
    if int(row.get("uid") or 0) != int(user_id):
        return False
    if time.time() > float(row.get("exp") or 0):
        session.pop(SESSION_PW_ROTATION, None)
        return False
    want = str(row.get("hash") or "")
    got = hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()
    if not hmac.compare_digest(want, got):
        return False
    session.pop(SESSION_PW_ROTATION, None)
    return True


def pop_srp_credential_challenge(
    email: str,
    srp_salt: str,
    srp_verifier: str,
    purpose: str,
    user_id: int,
) -> dict | None:
    if session.get(SESSION_SRP) or session.get(SESSION_SRP_CRED):
        _clear_legacy_srp_session_keys()
        return None
    challenge_id = str(session.pop(SESSION_SRP_CRED_CHALLENGE, None) or "").strip()
    if not challenge_id:
        return None
    return consume_srp_challenge(
        challenge_id,
        purpose=purpose,
        email=email,
        user_id=int(user_id),
        srp_salt=srp_salt,
        srp_verifier=srp_verifier,
    )


def auth_exempt_path(path: str) -> bool:
    base = path.split("?", 1)[0]
    return public_path(base) or base in {"/api/account/unlock", "/api/sync/pull"}


def csp_nonce() -> str:
    nonce = getattr(g, "csp_nonce", None)
    if not nonce:
        nonce = secrets.token_urlsafe(16)
        g.csp_nonce = nonce
    return nonce


def _csp_on_app_shell() -> bool:
    """True for the notes PWA shell — including query variants and /app/… paths.

    Dropbox OAuth redirects to ``{origin}/app`` (query string is not in
    ``request.path``). The in-app Update download uses ``/api/app-shell``.
    """
    try:
        from config import app_entry_path

        path = request.path.split("?", 1)[0]
        entry = app_entry_path()
    except Exception:
        return False
    if path == entry or path.startswith(f"{entry}/"):
        return True
    return path == "/api/app-shell"


def content_security_policy() -> str:
    nonce = csp_nonce()
    # Optional Google Drive backups (GIS token client + drive.file). Allowed
    # only so the client can load the GIS script and call Google APIs — no
    # vault keys or plaintext ever leave the browser. Hosts are emitted only
    # when GOOGLE_OAUTH_CLIENT_ID is set, and only on the app shell (L-19).
    google_script = ""
    google_connect = ""
    google_frame = ""
    # Optional Dropbox App-folder backups (OAuth 2 PKCE + files API). Browser
    # talks to Dropbox directly; encrypted .dgbackup blobs only. Hosts are
    # emitted only when DROPBOX_APP_KEY is set, and only on the app shell.
    dropbox_connect = ""
    try:
        google_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
        dropbox_key = os.environ.get("DROPBOX_APP_KEY", "").strip()
        on_app = _csp_on_app_shell()
        if google_id and on_app:
            google_script = " https://accounts.google.com"
            google_connect = (
                " https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com"
            )
            google_frame = " https://accounts.google.com"
        if dropbox_key and on_app:
            dropbox_connect = (
                " https://api.dropboxapi.com https://content.dropboxapi.com https://www.dropbox.com"
            )
    except Exception:
        google_script = google_connect = google_frame = ""
        dropbox_connect = ""
    # Optional Cloudflare Turnstile (when a site key is configured).
    turnstile = ""
    try:
        from config import turnstile_site_key

        if turnstile_site_key():
            turnstile = " https://challenges.cloudflare.com"
    except Exception:
        turnstile = ""
    return "; ".join(
        (
            "default-src 'self'",
            f"script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'{google_script}{turnstile}",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            # Widget talks to challenges.cloudflare.com from the browser.
            # api.github.com: client release-hash check (CORS *); release asset
            # CDN hosts are intentionally omitted — they lack ACAO and are unused.
            f"connect-src 'self' https://api.github.com{google_connect}{dropbox_connect}{turnstile}",
            "media-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
            f"frame-src 'self'{google_frame}{turnstile}",
            "worker-src 'self' blob:",
            "manifest-src 'self'",
            "form-action 'self'",
        )
    )


def security_headers() -> dict[str, str]:
    headers = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
        # same-origin-allow-popups keeps Google GIS / Dropbox OAuth popups working
        # (strict same-origin COOP breaks window.closed / postMessage opener links).
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if os.environ.get("NOTES_SECURE_COOKIES", "0") == "1":
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    policy = content_security_policy()
    if os.environ.get("NOTES_CSP_REPORT_ONLY", "0") == "1":
        headers["Content-Security-Policy-Report-Only"] = policy
    else:
        headers["Content-Security-Policy"] = policy
    return headers
