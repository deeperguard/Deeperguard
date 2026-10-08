"""Deeperguard — encrypted notes with sync, search, tags, 2FA, and email backup."""
from __future__ import annotations

import gzip
import json
import logging
import os
import re
import time
import base64
from pathlib import Path

from flask import Flask, jsonify, make_response, redirect, render_template, request, send_from_directory, session, url_for

import admin_api
import ai_relay
import auth
import db
import ocr as ocr_mod
import ocr_index
import ocr_jobs
import server_info_cache
import sync_log
import totp as totp_mod
from flask.sessions import SecureCookieSessionInterface
from datetime import timedelta

from config import CONTACT_EMAIL, DATA_DIR, INDEXNOW_KEY, NOTES_PUBLIC_HOST, NOTES_PUBLIC_URL, SESSION_SECONDS, app_entry_path, ensure_flask_secret, is_ip_host, log_server_ocr_startup_warning, normalize_host, ocr_ephemeral, pcloud_password_set, pcloud_token_set, repair_login_password_enabled, server_ocr_enabled, session_cookie_domain, skip_login, strict_zk, allow_register, min_password_length, webauthn_preferred_host, user_is_admin
from uploads import ensure_user_upload_dir, user_upload_dir
import promo as notes_promo
from backup_mail import send_user_backup
from admin_notify import log_signup_notify_config, notify_new_user_signup
from mailer import send_contact_email
from backup_pcloud import pcloud_credentials_configured, save_pcloud_settings, sync_user_backup
from passwords import hash_password, new_kdf_salt, verify_password
from srp_auth import SrpServerSession, generate_verifier_hex, new_srp_salt_hex
from vault_crypto import password_unlocks_samples
import webauthn_helper as webauthn_mod
from auth_rate_limit import allow as auth_rate_allow
from plans import FEATURE_CATALOG, PLAN_BASIC, PLAN_CATALOG, PLAN_PRO, account_plan_payload, plan_has, plan_required_error

class DynamicDomainSessionInterface(SecureCookieSessionInterface):
    def get_cookie_domain(self, app: Flask) -> str | None:
        configured = app.config.get("SESSION_COOKIE_DOMAIN")
        if not configured:
            return None
        try:
            from flask import request
            from config import normalize_host

            host = normalize_host(request.host)
            domain = configured.lstrip(".")
            if host == domain or host.endswith("." + domain):
                return configured
            return None
        except Exception:
            return None


app = Flask(__name__, template_folder="templates", static_folder="static")
app.session_interface = DynamicDomainSessionInterface()
app.secret_key = ensure_flask_secret()
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("NOTES_SECURE_COOKIES", "0") == "1"
app.config["SESSION_COOKIE_DOMAIN"] = session_cookie_domain()
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(seconds=SESSION_SECONDS)
# 50 MB files are stored as base64 inside JSON (~4/3). 48 MB rejected those uploads.
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024


@app.context_processor
def _inject_template_globals():
    return {"csp_nonce": auth.csp_nonce()}


@app.errorhandler(413)
def request_too_large(_err):
    return jsonify({"error": "File too large to upload"}), 413


log = logging.getLogger("deeperguard.sync")
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = True
EMAIL_RE = re.compile(r"^[^\s<>'\"&]+@[^\s<>'\"&]+\.[^\s<>'\"&]+$")
ITEM_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
WARN_AT_MAX_FUTURE = 10 * 365 * 24 * 60 * 60


def _srp_verifier_matches(user, email: str, password: str) -> bool:
    if not db.user_has_srp(user):
        return False
    try:
        computed = int(generate_verifier_hex(str(user["srp_salt"]), email, password), 16)
        stored = int(str(user["srp_verifier"]), 16)
    except (TypeError, ValueError):
        return False
    return computed == stored


def _account_login_password_ok(user, email: str, password: str) -> bool:
    """True when password matches the stored SRP verifier and/or leftover login hash."""
    if not password:
        return False
    if db.user_has_srp(user) and _srp_verifier_matches(user, email, password):
        return True
    if db.user_has_legacy_password(user) and verify_password(user["password_hash"], password):
        return True
    return False


def _stored_srp_challenge(email: str, user) -> str:
    """SRP step-1 bound to the account's *stored* salt/verifier.

    Repair-login and strict-ZK vault-recovery proofs must authenticate against the
    credentials on file — never against client-supplied ones, which would let an
    unauthenticated caller swap in a self-made verifier (SECURITY-REVIEW-2026-10-07 H-1/M-1).
    """
    sess = SrpServerSession()
    srp_salt = str(user["srp_salt"])
    srp_verifier = str(user["srp_verifier"])
    b_hex = sess.step1(email, srp_salt, srp_verifier)
    auth.store_srp_credential_challenge(email, srp_salt, srp_verifier, sess.to_private_state())
    return b_hex


def _verify_stored_srp_proof(email: str, user, a_hex: str, m1: str) -> bool:
    """True when A/M1 complete an SRP exchange against the stored verifier (password never sent)."""
    if not db.user_has_srp(user):
        return False
    state = auth.pop_srp_credential_challenge(email, str(user["srp_salt"]), str(user["srp_verifier"]))
    if not state:
        return False
    try:
        sess = SrpServerSession.from_private_state(state)
        sess.step2(a_hex, m1)
        return True
    except ValueError:
        return False


def _vault_password_matches(user, password: str) -> bool:
    samples = db.get_recovery_sample_items(int(user["id"]))
    if not samples:
        return False
    ciphertexts = [str(row["ciphertext"]) for row in samples]
    return password_unlocks_samples(
        password,
        kdf_salt=str(user["kdf_salt"]),
        vault_kdf_version=db.user_vault_kdf_version(user),
        ciphertexts=ciphertexts,
    )


def _user_has_vault_samples(user) -> bool:
    return bool(db.get_recovery_sample_item(int(user["id"])))


def _auth_rate_key(endpoint: str, email: str) -> str:
    return f"{auth.client_ip()}:{endpoint}:{email.strip().lower()}"


def _auth_rate_limited(endpoint: str, email: str) -> bool:
    return not auth_rate_allow(_auth_rate_key(endpoint, email))


def _verify_login_password(user, email: str, password: str) -> tuple[bool, bool]:
    """Return (verified, repair_exhausted). repair_exhausted skips slow client SRP."""
    tried_recovery = False
    has_encrypted_notes = _user_has_vault_samples(user)
    if db.user_has_legacy_password(user):
        tried_recovery = True
        if verify_password(user["password_hash"], password):
            return True, False
    if has_encrypted_notes and not strict_zk():
        tried_recovery = True
        if _vault_password_matches(user, password):
            return True, False
    if db.user_has_srp(user):
        tried_recovery = True
        if _srp_verifier_matches(user, email, password):
            return True, False
    can_srp_fallback = db.user_has_srp(user) and not db.user_has_legacy_password(user) and not has_encrypted_notes
    return False, tried_recovery and not can_srp_fallback


def _realign_login_credentials(
    uid: int,
    email: str,
    password: str | None,
    srp_salt: str,
    srp_verifier: str,
) -> None:
    db.update_user_srp_verifier(uid, srp_salt, srp_verifier)
    if not password:
        return
    user = db.get_user_by_id(uid)
    if user and db.user_has_legacy_password(user):
        db.update_user_password(uid, hash_password(password))
    elif user and not strict_zk() and db.user_auth_method(user) != "srp":
        db.update_user_password(uid, hash_password(password))


def _unlock_payload(user) -> dict:
    return {
        "ok": True,
        "email": user["email"],
        "kdf_salt": user["kdf_salt"],
        "kdf_iterations": db.user_kdf_iterations(user),
        "vault_kdf_version": db.user_vault_kdf_version(user),
        "password_changed_at": db.user_password_changed_at(user),
        "auth_method": db.user_auth_method(user),
        "csrf": auth.csrf_token(),
        **account_plan_payload(db.user_plan(user)),
    }


def _login_payload(user, *, totp_required: bool = False) -> dict:
    return {
        "ok": True,
        "user_id": int(user["id"]),
        "email": user["email"],
        "kdf_salt": user["kdf_salt"],
        "kdf_iterations": db.user_kdf_iterations(user),
        "vault_kdf_version": db.user_vault_kdf_version(user),
        "password_changed_at": db.user_password_changed_at(user),
        "auth_method": db.user_auth_method(user),
        "totp_required": totp_required,
        "csrf": auth.csrf_token(),
        **account_plan_payload(db.user_plan(user)),
    }


def _plan_block(user, feature: str):
    if plan_has(db.user_plan(user), feature):
        return None
    payload = plan_required_error(db.user_plan(user), feature)
    return jsonify(payload), 403


def _user_plan_guard(uid: int | None, feature: str):
    if not uid:
        return None, (jsonify({"error": "not found"}), 404)
    user = db.get_user_by_id(uid)
    if not user:
        return None, (jsonify({"error": "not found"}), 404)
    blocked = _plan_block(user, feature)
    if blocked:
        return None, blocked
    return user, None


def _parse_warn_at(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        ts = float(value)
        if ts > 1e12:
            ts /= 1000.0
        return ts if ts > 0 else None
    text = str(value).strip()
    if not text:
        return None
    try:
        ts = float(text)
        if ts > 1e12:
            ts /= 1000.0
        return ts if ts > 0 else None
    except ValueError:
        pass
    iso = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        from datetime import datetime

        parsed = datetime.fromisoformat(iso)
        if parsed.tzinfo is None:
            return None
        ts = parsed.timestamp()
        return ts if ts > 0 else None
    except ValueError:
        return None


def _public_reminder(row: dict) -> dict:
    return {
        "item_uuid": row["item_uuid"],
        "warn_at": row["warn_at"],
        "sent_at": row["sent_at"],
    }


def _deep_link_args() -> dict:
    """Carry a valid `?note=<uuid>` through login/2FA redirects so email links open the note."""
    if request.path not in {"/", app_entry_path(), "/login", "/totp"}:
        return {}
    note = str(request.args.get("note") or "").strip()
    return {"note": note} if ITEM_UUID_RE.match(note) else {}


def _notes_build() -> str:
    env = (os.environ.get("NOTES_BUILD") or "").strip()
    if env:
        return env
    version_path = Path(os.environ.get("NOTES_ROOT", "/opt/deeperguard")) / "VERSION"
    try:
        sha = version_path.read_text(encoding="utf-8").strip()
        if sha:
            return sha[:8]
    except OSError:
        pass
    return "259"


NOTES_BUILD = _notes_build()
DEVICE_REPORT_MAX = 32 * 1024
DEVICE_REPORT_KEEP = 8
SERVER_OCR_DISABLED = (
    "Server-side OCR is disabled. Documents are processed on your device only."
)
# Hostnames/IPs allowed in the HTTP → HTTPS recovery link (prevents Host-header tricks).
_SAFE_HTTPS_HOST = re.compile(
    r"^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$"
)


class _ShellCacheMiddleware:
    """Strip cookies/Vary after Flask saves the session so Safari can cache "/"."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO") or "/"

        def _start(status, headers, exc_info=None):
            if auth.cacheable_shell(path) or path == "/sw.js":
                cleaned = []
                for key, value in headers:
                    if key.lower() == "set-cookie":
                        continue
                    if key.lower() == "vary":
                        parts = [
                            part.strip()
                            for part in value.split(",")
                            if part.strip() and part.strip().lower() != "cookie"
                        ]
                        if parts:
                            cleaned.append((key, ", ".join(parts)))
                        continue
                    cleaned.append((key, value))
                headers = cleaned
            return start_response(status, headers, exc_info)

        return self.wsgi_app(environ, _start)


app.wsgi_app = _ShellCacheMiddleware(app.wsgi_app)


def _drop_set_cookie(response):
    while "Set-Cookie" in response.headers:
        del response.headers["Set-Cookie"]
    vary = response.headers.get("Vary") or ""
    kept = [part.strip() for part in vary.split(",") if part.strip() and part.strip().lower() != "cookie"]
    if kept:
        response.headers["Vary"] = ", ".join(kept)
    elif "Vary" in response.headers:
        del response.headers["Vary"]


@app.after_request
def _headers(response):
    for key, value in auth.security_headers().items():
        response.headers.setdefault(key, value)
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif request.path == "/sw.js":
        # Revalidate every load so marketing/app routing fixes reach phones
        # that already have a service worker.
        response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
        session.accessed = False
        session.modified = False
        _drop_set_cookie(response)
    elif request.path in {"/", "/pricing", "/compare/standard-notes"}:
        # Marketing HTML is public and cookie-free. A short cache keeps repeat
        # visits off the origin. Clear-Site-Data must not be set here: the
        # browser deletes its HTTP cache before painting, and the one-time
        # cookie never stuck because this path strips Set-Cookie.
        response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=86400"
        response.headers.pop("Pragma", None)
        session.accessed = False
        session.modified = False
        _drop_set_cookie(response)
    elif request.path in {app_entry_path(), "/manifest.json"}:
        # Revalidate when the phone is online; keep a stale copy for offline.
        response.headers["Cache-Control"] = (
            "public, max-age=0, stale-while-revalidate=604800, stale-if-error=604800"
        )
        response.headers.pop("Pragma", None)
        session.accessed = False
        session.modified = False
        _drop_set_cookie(response)
    elif auth.cacheable_shell(request.path):
        response.headers["Cache-Control"] = "public, max-age=86400, immutable"
        response.headers.pop("Pragma", None)
        session.accessed = False
        session.modified = False
        _drop_set_cookie(response)
    elif request.path in {"/login", "/register", "/totp"}:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.before_request
def _gate():
    legacy = _legacy_notes_host_redirect()
    if legacy is not None:
        return legacy
    if not auth.client_allowed():
        return ("Deeperguard is limited to the LAN and WireGuard.", 403)
    # Do not create a session on the app shell. A Set-Cookie header makes
    # Safari refuse to keep "/" in its HTTP cache, so the home-screen icon
    # cannot open when the LAN is unreachable.
    if auth.cacheable_shell(request.path):
        skipped = False
    else:
        skipped = auth.ensure_skip_login_session()
    if skipped and request.path in {"/login", "/register", "/totp"}:
        return redirect(url_for("notes_app", **_deep_link_args()))
    if auth.public_path(request.path):
        if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            if not auth.request_is_same_origin():
                return jsonify({"error": "cross-origin request denied"}), 403
        return None
    if not auth.authenticated():
        wipe = auth.session_requires_wipe()
        if wipe:
            auth.logout()
        if auth.bootstrap_path(request.path, request.method):
            if wipe:
                return jsonify({"error": "session revoked", "code": "session_revoked"}), 401
            return None
        if request.path.startswith("/api/"):
            if wipe:
                return jsonify({"error": "session revoked", "code": "session_revoked"}), 401
            return jsonify({"error": "login required"}), 401
        return redirect(url_for("login", **_deep_link_args()))
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if uid and not user:
        auth.logout()
        if request.path.startswith("/api/"):
            return jsonify({"error": "login required"}), 401
        return redirect(url_for("login", **_deep_link_args()))
    if user:
        auth.ensure_device_session()
        try:
            ensure_user_upload_dir(int(user["id"]))
        except OSError:
            pass
    if not skipped and auth.needs_totp() and request.path not in {
        "/totp",
        "/api/totp/verify",
        "/api/account/unlock",
    }:
        if request.path.startswith("/api/"):
            return jsonify({"error": "2FA required"}), 403
        return redirect(url_for("totp_page", **_deep_link_args()))
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if not auth.request_is_same_origin():
            return jsonify({"error": "cross-origin request denied"}), 403
        if not auth.auth_exempt_path(request.path) and not auth.csrf_ok():
            return jsonify({"error": "invalid CSRF token"}), 400
    if not auth.cacheable_shell(request.path):
        auth.slide_session()
    return None


@app.after_request
def _gzip_api_json(response):
    if response.status_code >= 300:
        return response
    if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
        return response
    if not request.path.startswith("/api/"):
        return response
    ctype = (response.content_type or "").lower()
    if "json" not in ctype:
        return response
    data = response.get_data()
    if len(data) < 1024:
        return response
    compressed = gzip.compress(data, compresslevel=6)
    if len(compressed) >= len(data):
        return response
    response.set_data(compressed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(compressed))
    response.headers["Vary"] = "Accept-Encoding"
    return response


_CONTACT_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.post("/api/contact")
def api_contact():
    if not auth.request_is_same_origin():
        return jsonify({"error": "cross-origin request denied"}), 403
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "invalid request"}), 400
    if str(data.get("website") or "").strip():
        return jsonify({"ok": True})
    ip = auth.client_ip()
    if not auth_rate_allow(f"contact:{ip}", limit=6, window=3600.0):
        return jsonify({"error": "Too many messages — try again later."}), 429
    email = str(data.get("email") or "").strip().lower()[:254]
    name = str(data.get("name") or "").strip()[:120]
    subject = str(data.get("subject") or "").strip()[:200] or "Deeperguard website contact"
    message = str(data.get("message") or "").strip()
    if not email or not _CONTACT_EMAIL_RE.match(email):
        return jsonify({"error": "A valid email address is required."}), 400
    if len(message) < 10:
        return jsonify({"error": "Please write at least 10 characters."}), 400
    if len(message) > 5000:
        return jsonify({"error": "Message is too long."}), 400
    lines = [
        "New message from the Deeperguard website contact form.",
        "",
        f"Name: {name or '(not provided)'}",
        f"Email: {email}",
        f"IP: {ip}",
        "",
        message,
    ]
    try:
        send_contact_email(
            CONTACT_EMAIL,
            sender_email=email,
            sender_name=name,
            subject=f"[Contact] {subject}",
            body="\n".join(lines),
        )
    except Exception:
        log.exception("contact form email failed")
        return jsonify({"error": "Could not send your message right now. Please email us directly."}), 503
    return jsonify({"ok": True})


def _health_readiness() -> tuple[bool, bool, bool, int, dict]:
    db_ok = True
    db_bytes = 0
    try:
        db.connection().execute("SELECT 1").fetchone()
        page_count = db.connection().execute("PRAGMA page_count").fetchone()[0]
        page_size = db.connection().execute("PRAGMA page_size").fetchone()[0]
        db_bytes = int(page_count) * int(page_size)
    except Exception:
        db_ok = False
    server = server_info_cache.compute_server()
    disk_free = int(server.get("disk_free_bytes") or 0)
    disk_total = int(server.get("disk_total_bytes") or 0)
    disk_ok = disk_total == 0 or disk_free > disk_total * 0.05
    ready = db_ok and disk_ok
    return ready, db_ok, disk_ok, db_bytes, server


@app.get("/api/health")
def health():
    ready, db_ok, disk_ok, db_bytes, server = _health_readiness()
    payload: dict = {
        "ok": ready,
        "service": "deeperguard",
        "build": NOTES_BUILD,
    }
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if user and user_is_admin(user):
        payload.update({
            "ocr_queue": ocr_jobs.queue_depth(),
            "ocr_ephemeral": ocr_ephemeral(),
            "db_bytes": db_bytes,
            "checks": {
                "database": db_ok,
                "disk": disk_ok,
                "registration_open": allow_register(),
            },
            "server": server,
        })
    status = 200 if ready else 503
    return jsonify(payload), status


@app.get("/api/server/info")
def api_server_info():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if not user_is_admin(user):
        return jsonify({"error": "forbidden"}), 403
    data = server_info_cache.get_or_compute(uid)
    return jsonify({
        **data,
        "build": NOTES_BUILD,
        "cached": True,
        "server": server_info_cache.compute_server(),
    })


def _device_reports_dir(user_id: int) -> Path:
    path = user_upload_dir(int(user_id)) / "device-reports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _rotate_device_reports(reports_dir: Path) -> None:
    files = sorted(
        (p for p in reports_dir.glob("*.txt") if p.name != "latest.txt"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in files[DEVICE_REPORT_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass


def _parse_known_hashes(raw: str) -> dict[str, str]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(k): str(v)
        for k, v in data.items()
        if k and v is not None
    }


def _sync_log_line(line: str) -> None:
    log.info(line)
    try:
        sync_log.write(line)
    except OSError:
        pass


@app.post("/api/device-report")
def api_device_report():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    report = str(body.get("report") or "").strip()
    if not report:
        return jsonify({"error": "report required"}), 400
    if len(report) > DEVICE_REPORT_MAX:
        report = report[:DEVICE_REPORT_MAX]
    reports_dir = _device_reports_dir(int(user["id"]))
    stamp = int(time.time())
    (reports_dir / f"{stamp}.txt").write_text(report, encoding="utf-8")
    (reports_dir / "latest.txt").write_text(report, encoding="utf-8")
    _rotate_device_reports(reports_dir)
    meta = {
        "user_id": uid,
        "email": str(user["email"]),
        "build": NOTES_BUILD,
        "received_at": stamp,
        "bytes": len(report.encode("utf-8")),
    }
    (reports_dir / "latest.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return jsonify({"ok": True})


# Ollama Cloud relay: the browser cannot call ollama.com directly (no CORS), so
# the signed-in client posts here with its own key in X-Ollama-Key. The request
# is forwarded as-is and nothing (key, prompt, answer) is stored or logged.
@app.post("/api/ai/ollama/chat")
def api_ai_ollama_chat():
    if not auth.current_user_id():
        return jsonify({"error": "not found"}), 404
    try:
        status, payload = ai_relay.chat(request.headers.get("X-Ollama-Key", ""), request.get_json(silent=True))
    except ai_relay.RelayError as err:
        return jsonify({"error": err.message}), err.status
    return jsonify(payload), status


@app.get("/api/ai/ollama/<what>")
def api_ai_ollama_info(what: str):
    if not auth.current_user_id():
        return jsonify({"error": "not found"}), 404
    try:
        status, payload = ai_relay.info(request.headers.get("X-Ollama-Key", ""), what)
    except ai_relay.RelayError as err:
        return jsonify({"error": err.message}), err.status
    return jsonify(payload), status


@app.route("/login", methods=["GET", "POST"])
def login():
    # Never bounce an authenticated session back to / — the app needs the
    # account password in the browser to decrypt notes. Redirecting here
    # caused a reload loop when sessionStorage was empty.
    form_error = ""
    if request.method == "POST":
        form_error = "Sign-in did not finish. Reload this page and try again."
    resp = make_response(render_template("login.html", build=NOTES_BUILD, form_error=form_error))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/register", methods=["GET", "POST"])
def register():
    if auth.authenticated():
        return redirect(url_for("notes_app"))
    form_error = ""
    if request.method == "POST":
        form_error = "Account setup did not finish. Reload this page and try again."
    return render_template("register.html", build=NOTES_BUILD, form_error=form_error)


@app.post("/api/auth/register")
def api_register():
    """Legacy registration disabled — all new accounts use SRP zero-knowledge sign-up."""
    return jsonify(
        {
            "error": "legacy registration disabled — use zero-knowledge sign-up",
            "auth_method": "srp",
        }
    ), 410


@app.post("/api/auth/srp/register")
def api_auth_srp_register():
    if not allow_register():
        return jsonify({"error": "registration is closed"}), 403
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid email"}), 400
    if not srp_salt or not srp_verifier:
        return jsonify({"error": "missing srp credentials"}), 400
    if _auth_rate_limited("srp-register", email):
        return jsonify({"error": "too many attempts"}), 429
    if db.get_user_by_email(email):
        return jsonify({"error": "account already exists"}), 409
    kdf_salt = new_kdf_salt()
    user_id = db.create_user_srp(email, kdf_salt, srp_salt, srp_verifier)
    auth.login_user(user_id, totp_ok=True)
    notify_new_user_signup(email)
    user = db.get_user_by_id(user_id)
    return jsonify(_login_payload(user, totp_required=False))


@app.post("/api/auth/srp/challenge")
def api_auth_srp_challenge():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if _auth_rate_limited("srp-challenge", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user or not db.user_has_srp(user):
        return jsonify({"error": "invalid credentials"}), 401
    try:
        sess = SrpServerSession()
        b_hex = sess.step1(email, str(user["srp_salt"]), str(user["srp_verifier"]))
        auth.store_srp_state(email, sess.to_private_state())
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({"srp_salt": str(user["srp_salt"]), "B": b_hex})


@app.post("/api/auth/srp/verify")
def api_auth_srp_verify():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if not email or not a_hex or not m1:
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("srp-verify", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user or not db.user_has_srp(user):
        return jsonify({"error": "invalid credentials"}), 401
    state = auth.pop_srp_state(email)
    if not state:
        return jsonify({"error": "login expired — try again"}), 401
    try:
        sess = SrpServerSession.from_private_state(state)
        m2 = sess.step2(a_hex, m1)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    totp_required = bool(user["totp_enabled"])
    auth.login_user(int(user["id"]), totp_ok=not totp_required)
    payload = _login_payload(user, totp_required=totp_required)
    payload["M2"] = m2
    return jsonify(payload)


@app.post("/api/auth/repair-login/challenge")
def api_auth_repair_login_challenge():
    """SRP step-1 for repair-login: challenge is bound to the account's stored verifier."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("repair-login", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user or not db.user_has_srp(user):
        return jsonify({"error": "invalid credentials"}), 401
    try:
        b_hex = _stored_srp_challenge(email, user)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({"srp_salt": str(user["srp_salt"]), "B": b_hex})


@app.post("/api/auth/repair-login")
def api_auth_repair_login():
    """Realign drifted SRP verifiers after a client SRP proof (password stays on the client)."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("repair-login", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401

    if repair_login_password_enabled() and password:
        if len(password) < min_password_length():
            return jsonify({"error": "invalid credentials"}), 401
        # Password must match stored credentials (legacy hash, vault samples, or stored SRP
        # verifier) — a client-supplied verifier that merely matches the submitted password
        # proves nothing about the account.
        verified, repair_exhausted = _verify_login_password(user, email, password)
        if not verified:
            return jsonify({"error": "invalid credentials", "repair_exhausted": repair_exhausted}), 401
        if not srp_salt or not srp_verifier:
            srp_salt = new_srp_salt_hex()
            srp_verifier = generate_verifier_hex(srp_salt, email, password)
        uid = int(user["id"])
        _realign_login_credentials(uid, email, password, srp_salt, srp_verifier)
        totp_required = bool(user["totp_enabled"])
        auth.login_user(uid, totp_ok=not totp_required)
        user = db.get_user_by_id(uid)
        payload = _login_payload(user, totp_required=totp_required)
        payload["login_repaired"] = True
        return jsonify(payload)

    if not srp_salt or not srp_verifier or not a_hex or not m1:
        return jsonify({"error": "invalid credentials"}), 400
    # The proof must authenticate against the verifier on file; only then may the caller
    # rotate to the freshly generated salt/verifier they submitted.
    if not _verify_stored_srp_proof(email, user, a_hex, m1):
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401
    uid = int(user["id"])
    _realign_login_credentials(uid, email, None, srp_salt, srp_verifier)
    totp_required = bool(user["totp_enabled"])
    auth.login_user(uid, totp_ok=not totp_required)
    user = db.get_user_by_id(uid)
    payload = _login_payload(user, totp_required=totp_required)
    payload["login_repaired"] = True
    return jsonify(payload)


@app.post("/api/auth/srp/resync")
def api_auth_srp_resync():
    """Rebuild SRP verifier when it drifted from the vault/login password (legacy hash still on file)."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    if not EMAIL_RE.match(email) or not password or not srp_salt or not srp_verifier:
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("srp-resync", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user or db.user_auth_method(user) != "srp":
        return jsonify({"error": "invalid credentials"}), 401
    if not db.user_has_legacy_password(user):
        return jsonify({"error": "invalid credentials"}), 401
    if not verify_password(user["password_hash"], password):
        return jsonify({"error": "invalid credentials"}), 401
    uid = int(user["id"])
    _realign_login_credentials(uid, email, password, srp_salt, srp_verifier)
    totp_required = bool(user["totp_enabled"])
    auth.login_user(uid, totp_ok=not totp_required)
    user = db.get_user_by_id(int(user["id"]))
    payload = _login_payload(user, totp_required=totp_required)
    payload["srp_resynced"] = True
    return jsonify(payload)


@app.post("/api/auth/verify-vault")
def api_auth_verify_vault():
    """Disabled in strict zero-knowledge mode — vault passwords stay on the client."""
    if strict_zk():
        return jsonify({
            "error": "server vault verification disabled — use client-side unlock",
            "strict_zk": True,
        }), 410
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    if not EMAIL_RE.match(email) or not password:
        return jsonify({"error": "invalid credentials"}), 401
    if _auth_rate_limited("verify-vault", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials"}), 401
    if not _user_has_vault_samples(user):
        return jsonify({"error": "no encrypted notes to verify against"}), 400
    if not _vault_password_matches(user, password):
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({"ok": True})


@app.post("/api/auth/vault-recovery/challenge")
def api_auth_vault_recovery_challenge():
    """SRP step-1 for strict-ZK vault recovery (session + CSRF; binds to the stored verifier)."""
    if not strict_zk():
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid credentials"}), 400
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "sign in required"}), 401
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    user = db.get_user_by_email(email)
    if not user or int(user["id"]) != int(uid):
        return jsonify({"error": "invalid credentials"}), 401
    if not db.user_has_srp(user):
        return jsonify({"error": "invalid credentials"}), 401
    if _auth_rate_limited("vault-recovery", email):
        return jsonify({"error": "too many attempts"}), 429
    try:
        b_hex = _stored_srp_challenge(email, user)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({"srp_salt": str(user["srp_salt"]), "B": b_hex})


@app.post("/api/auth/vault-recovery")
def api_auth_vault_recovery():
    """Rebuild login credentials from a client-generated SRP verifier (session required)."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if strict_zk():
        if not srp_salt or not srp_verifier or not EMAIL_RE.match(email) or not a_hex or not m1:
            return jsonify({"error": "invalid credentials"}), 400
        uid = auth.current_user_id()
        if not uid:
            return jsonify({"error": "sign in required"}), 401
        if not auth.csrf_ok():
            return jsonify({"error": "invalid CSRF token"}), 400
        user = db.get_user_by_email(email)
        if not user or int(user["id"]) != int(uid):
            return jsonify({"error": "invalid credentials"}), 401
        if _auth_rate_limited("vault-recovery", email):
            return jsonify({"error": "too many attempts"}), 429
        # Stolen session + CSRF cannot rotate SRP without proving the current password
        # against the verifier on file (SRP step2 bound to stored credentials).
        if not _verify_stored_srp_proof(email, user, a_hex, m1):
            return jsonify({"error": "invalid credentials"}), 401
        db.update_user_srp_verifier(int(uid), srp_salt, srp_verifier)
        totp_required = bool(user["totp_enabled"])
        auth.login_user(int(uid), totp_ok=not totp_required)
        user = db.get_user_by_id(int(uid))
        payload = _login_payload(user, totp_required=totp_required)
        payload["vault_recovered"] = True
        return jsonify(payload)
    if not EMAIL_RE.match(email) or not password or not srp_salt or not srp_verifier:
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("vault-recovery", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials"}), 401
    if not _user_has_vault_samples(user):
        return jsonify({"error": "no encrypted notes to verify against"}), 400
    if not _vault_password_matches(user, password):
        return jsonify({"error": "invalid credentials"}), 401
    uid = int(user["id"])
    _realign_login_credentials(uid, email, password, srp_salt, srp_verifier)
    totp_required = bool(user["totp_enabled"])
    auth.login_user(uid, totp_ok=not totp_required)
    user = db.get_user_by_id(uid)
    payload = _login_payload(user, totp_required=totp_required)
    payload["vault_recovered"] = True
    return jsonify(payload)


@app.post("/api/auth/srp/upgrade")
def api_auth_srp_upgrade():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if db.user_has_srp(user):
        return jsonify({"ok": True, "auth_method": "srp"})
    body = request.get_json(silent=True) or {}
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    if not srp_salt or not srp_verifier:
        return jsonify({"error": "missing srp credentials"}), 400
    db.upgrade_user_to_srp(uid, srp_salt, srp_verifier)
    return jsonify({"ok": True, "auth_method": "srp"})


@app.post("/api/auth/login")
def api_login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "").strip()
    if _auth_rate_limited("legacy-login", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if user and db.user_auth_method(user) == "srp":
        return jsonify({"error": "incorrect password", "auth_method": "srp"}), 401
    user_id, totp_required = auth.verify_credentials(email, password)
    if not user_id:
        return jsonify({"error": "invalid credentials"}), 401
    auth.login_user(user_id, totp_ok=not totp_required)
    user = db.get_user_by_id(user_id)
    return jsonify(_login_payload(user, totp_required=totp_required))


@app.post("/api/auth/logout")
def api_logout():
    auth.logout()
    return jsonify({"ok": True})


def _public_session(row, *, current_token: str) -> dict:
    token_match = False
    if current_token:
        stored = db.get_session_by_token(current_token)
        token_match = bool(stored and int(stored["id"]) == int(row["id"]))
    return {
        "id": int(row["id"]),
        "device": str(row["device_label"] or "Unknown device"),
        "ip": str(row["ip"] or ""),
        "ip_location": str(row["ip_location"] or "Unknown"),
        "last_login_at": float(row["last_login_at"] or 0),
        "current": token_match,
    }


@app.get("/api/sessions")
def api_list_sessions():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    db.prune_user_sessions(uid, older_than=time.time() - SESSION_SECONDS)
    db.collapse_duplicate_sessions(uid)
    token = auth.current_session_token()
    rows = db.list_user_sessions(uid, active_since=time.time() - SESSION_SECONDS)
    return jsonify({"sessions": [_public_session(row, current_token=token) for row in rows]})


@app.delete("/api/sessions/<int:session_id>")
def api_revoke_session(session_id: int):
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    row = db.get_user_session(session_id, uid)
    if not row or row["revoked_at"]:
        return jsonify({"error": "not found"}), 404
    current = False
    token = auth.current_session_token()
    if token:
        stored = db.get_session_by_token(token)
        current = bool(stored and int(stored["id"]) == int(row["id"]))
    if not db.revoke_user_session(session_id, uid):
        return jsonify({"error": "not found"}), 404
    if current:
        auth.logout()
    return jsonify({"ok": True, "current": current})


@app.post("/api/auth/webauthn/register/options")
def api_webauthn_register_options():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "passkeys")
    if blocked:
        return blocked
    if not webauthn_mod.WEBAUTHN_AVAILABLE:
        return jsonify({"error": "webauthn not available on server"}), 501
    host_error = webauthn_mod.passkey_host_error()
    if host_error:
        return jsonify({"error": host_error}), 400
    try:
        existing = [str(row["credential_id"]) for row in db.list_webauthn_credentials(uid)]
        options = webauthn_mod.registration_options(uid, user["email"], existing)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "options": options})


@app.post("/api/auth/webauthn/register/verify")
def api_webauthn_register_verify():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "passkeys")
    if blocked:
        return blocked
    if not webauthn_mod.WEBAUTHN_AVAILABLE:
        return jsonify({"error": "webauthn not available on server"}), 501
    body = request.get_json(silent=True) or {}
    credential = body.get("credential")
    if not isinstance(credential, dict):
        return jsonify({"error": "missing credential"}), 400
    try:
        verified = webauthn_mod.verify_registration(credential, user["email"])
        db.add_webauthn_credential(
            uid,
            verified["credential_id"],
            verified["public_key"],
            verified["sign_count"],
            ",".join(credential.get("transports") or []),
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True})


@app.get("/api/auth/webauthn/credentials")
def api_webauthn_list_credentials():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    rows = db.list_webauthn_credentials(uid)
    return jsonify(
        {
            "ok": True,
            "credentials": [
                {
                    "credential_id": str(row["credential_id"]),
                    "created_at": float(row["created_at"] or 0),
                    "transports": str(row["transports"] or ""),
                }
                for row in rows
            ],
        }
    )


@app.post("/api/auth/webauthn/remove")
def api_webauthn_remove_credential():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    credential_id = str(body.get("credential_id") or "").strip()
    if not credential_id:
        return jsonify({"error": "missing credential_id"}), 400
    if not db.delete_webauthn_credential(uid, credential_id):
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/auth/webauthn/login/options")
def api_webauthn_login_options():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if _auth_rate_limited("webauthn-login", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials"}), 401
    creds = db.list_webauthn_credentials(int(user["id"]))
    if not creds:
        return jsonify({"error": "no passkeys registered"}), 404
    if not webauthn_mod.WEBAUTHN_AVAILABLE:
        return jsonify({"error": "webauthn not available on server"}), 501
    host_error = webauthn_mod.passkey_host_error()
    if host_error:
        return jsonify({"error": host_error}), 400
    try:
        options = webauthn_mod.authentication_options([dict(row) for row in creds])
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "options": options})


@app.post("/api/auth/webauthn/login/verify")
def api_webauthn_login_verify():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    credential = body.get("credential")
    if not email or not isinstance(credential, dict):
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("webauthn-login", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials"}), 401
    cred_id = str(credential.get("id") or "")
    stored = db.get_webauthn_credential(cred_id)
    if not stored or int(stored["user_id"]) != int(user["id"]):
        return jsonify({"error": "invalid credentials"}), 401
    if not webauthn_mod.WEBAUTHN_AVAILABLE:
        return jsonify({"error": "webauthn not available on server"}), 501
    try:
        verified = webauthn_mod.verify_authentication(credential, dict(stored))
        db.update_webauthn_sign_count(verified["credential_id"], verified["sign_count"])
    except Exception as exc:
        return jsonify({"error": str(exc)}), 401
    totp_required = bool(user["totp_enabled"])
    auth.login_user(int(user["id"]), totp_ok=not totp_required)
    return jsonify(_login_payload(user, totp_required=totp_required))


@app.route("/totp", methods=["GET", "POST"])
def totp_page():
    if not auth.authenticated():
        return redirect(url_for("login"))
    form_error = ""
    if request.method == "POST":
        form_error = "Verification did not finish. Reload this page and try again."
    return render_template(
        "totp.html",
        csrf_token=auth.csrf_token(),
        build=NOTES_BUILD,
        form_error=form_error,
    )


@app.post("/api/totp/verify")
def api_totp_verify():
    uid = auth.current_user_id()
    if uid and _auth_rate_limited("totp-verify", str(uid)):
        return jsonify({"error": "too many attempts"}), 429
    body = request.get_json(silent=True) or {}
    code = str(body.get("code") or "")
    if not auth.verify_totp_for_current_user(code):
        return jsonify({"error": "invalid code"}), 401
    return jsonify({"ok": True})


@app.post("/api/account/unlock")
def api_account_unlock():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user and skip_login():
        user = db.get_first_user()
        if user:
            auth.login_user(int(user["id"]), totp_ok=not bool(user["totp_enabled"]))
    if not user:
        return jsonify({"error": "sign in required"}), 401
    if not auth.authenticated() or auth.current_user_id() != int(user["id"]):
        return jsonify({"error": "sign in required"}), 401
    return jsonify(_unlock_payload(user))


@app.post("/api/account/password")
def api_account_password():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    current = str(body.get("current_password") or "").strip()
    new = str(body.get("new_password") or "").strip()
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    align = bool(body.get("align_after_vault_rekey"))
    account = str(body.get("account_password") or "").strip()
    email = str(user["email"] or "").strip().lower()
    if db.user_auth_method(user) == "srp":
        if not srp_salt or not srp_verifier:
            return jsonify({"error": "missing srp verifier"}), 400
        login_ok = _account_login_password_ok(user, email, current)
        if not login_ok and align and current and account:
            login_ok = _account_login_password_ok(user, email, account)
        if not login_ok:
            return jsonify({"error": "invalid password"}), 401
        changed_at = db.update_user_srp_verifier(uid, srp_salt, srp_verifier)
        if len(new) >= 8:
            db.update_user_password(uid, hash_password(new))
        return jsonify({"ok": True, "password_changed_at": changed_at, "auth_method": "srp"})
    if len(new) < 8:
        return jsonify({"error": "new password must be at least 8 characters"}), 400
    if not verify_password(user["password_hash"], current):
        account = str(body.get("account_password") or "").strip()
        if not align or not current or not account:
            return jsonify({"error": "invalid password"}), 401
        if not verify_password(user["password_hash"], account):
            return jsonify({"error": "invalid password"}), 401
    changed_at = db.update_user_password(uid, hash_password(new))
    if srp_salt and srp_verifier:
        db.upgrade_user_to_srp(uid, srp_salt, srp_verifier)
    return jsonify({"ok": True, "password_changed_at": changed_at})


@app.post("/api/account/vault-kdf")
def api_account_vault_kdf():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    version = int(body.get("vault_kdf_version") or 0)
    if version != 2:
        return jsonify({"error": "only upgrade to vault_kdf_version 2 is supported"}), 400
    current = db.user_vault_kdf_version(user)
    if current >= version:
        return jsonify({"ok": True, "vault_kdf_version": current})
    db.update_user_vault_kdf_version(uid, version)
    return jsonify({"ok": True, "vault_kdf_version": version})


@app.get("/api/account")
def api_account():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    stats = db.user_vault_stats(uid)
    quota = db.user_storage_quota_bytes(user)
    return jsonify(
        {
            "email": user["email"],
            "kdf_salt": user["kdf_salt"],
            "kdf_iterations": db.user_kdf_iterations(user),
            "vault_kdf_version": db.user_vault_kdf_version(user),
            "totp_enabled": bool(user["totp_enabled"]),
            "backup_email": user["backup_email"] or user["email"],
            "backup_enabled": bool(user["backup_enabled"]),
            "pcloud_enabled": bool(user["pcloud_enabled"]),
            "pcloud_username": user["pcloud_username"] or "",
            "pcloud_remote_path": user["pcloud_remote_path"] or "Deeperguard/backups",
            "pcloud_region": user["pcloud_region"] or "eu",
            "pcloud_password_set": pcloud_password_set(uid),
            "pcloud_token_set": pcloud_token_set(uid),
            "pcloud_last_sync_at": float(user["pcloud_last_sync_at"] or 0),
            "pcloud_last_sync_status": user["pcloud_last_sync_status"] or "",
            "pcloud_last_sync_detail": user["pcloud_last_sync_detail"] or "",
            "password_changed_at": db.user_password_changed_at(user),
            "auth_method": db.user_auth_method(user),
            "webauthn_enabled": len(db.list_webauthn_credentials(uid)) > 0,
            "passkey_host_ok": webauthn_mod.passkey_host_error() is None,
            "passkey_url": f"https://{webauthn_preferred_host()}/",
            "storage_used_bytes": int(stats["storage_bytes"]),
            "storage_quota_bytes": quota,
            "storage_quota_effective": db.user_storage_quota_effective(user),
            "is_admin": user_is_admin(user),
            "csrf": auth.csrf_token(),
            **account_plan_payload(db.user_plan(user)),
        }
    )


@app.post("/api/totp/setup")
def api_totp_setup():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "account_2fa")
    if blocked:
        return blocked
    secret = totp_mod.new_secret()
    db.update_user_totp(uid, secret, enabled=False)
    return jsonify(
        {
            "secret": secret,
            "qr": totp_mod.qr_png_data_uri(secret, user["email"]),
            "uri": totp_mod.provisioning_uri(secret, user["email"]),
        }
    )


@app.post("/api/totp/enable")
def api_totp_enable():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "account_2fa")
    if blocked:
        return blocked
    body = request.get_json(silent=True) or {}
    code = str(body.get("code") or "")
    if not totp_mod.verify(str(user["totp_secret"]), code):
        return jsonify({"error": "invalid code"}), 400
    db.update_user_totp(uid, str(user["totp_secret"]), enabled=True)
    auth.login_user(uid, totp_ok=True)
    return jsonify({"ok": True})


@app.post("/api/totp/disable")
def api_totp_disable():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    password = str(body.get("password") or "")
    code = str(body.get("code") or "")
    if db.user_auth_method(user) != "srp":
        if not verify_password(user["password_hash"], password):
            return jsonify({"error": "invalid password"}), 401
    if user["totp_enabled"] and not totp_mod.verify(str(user["totp_secret"]), code):
        return jsonify({"error": "invalid code"}), 400
    db.update_user_totp(uid, "", enabled=False)
    auth.login_user(uid, totp_ok=True)
    return jsonify({"ok": True})


@app.get("/api/reminders")
def api_reminders_list():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    rows = db.list_reminders(uid)
    return jsonify({"ok": True, "reminders": [_public_reminder(row) for row in rows]})


@app.post("/api/reminders")
def api_reminders_upsert():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    user = db.get_user_by_id(uid)
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    item_uuid = str(body.get("item_uuid") or "").strip()
    if not ITEM_UUID_RE.match(item_uuid):
        return jsonify({"error": "invalid note id"}), 400
    warn_at = _parse_warn_at(body.get("warn_at"))
    if warn_at is None:
        return jsonify({"error": "invalid warn_at"}), 400
    blocked = _plan_block(user, "reminders")
    if blocked:
        return blocked
    if warn_at > time.time() + WARN_AT_MAX_FUTURE:
        return jsonify({"error": "warn_at too far in the future"}), 400
    # Zero-knowledge: only the note id and the time are stored server-side.
    # The title stays inside the encrypted note; the email carries a link only.
    row = db.upsert_reminder(uid, item_uuid, warn_at)
    return jsonify({"ok": True, **_public_reminder(row)})


@app.delete("/api/reminders/<item_uuid>")
def api_reminders_delete(item_uuid: str):
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    item_uuid = str(item_uuid or "").strip()
    if not ITEM_UUID_RE.match(item_uuid):
        return jsonify({"error": "invalid note id"}), 400
    deleted = db.delete_reminder(uid, item_uuid)
    return jsonify({"ok": True, "deleted": deleted})


@app.post("/api/backup/settings")
def api_backup_settings():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    enabled = bool(body.get("enabled"))
    if email and not EMAIL_RE.match(email):
        return jsonify({"error": "invalid email"}), 400
    user = db.get_user_by_id(uid)
    if enabled:
        blocked = _plan_block(user, "email_backup")
        if blocked:
            return blocked
    if not email and user:
        email = str(user["email"])
    db.update_backup_settings(uid, email, enabled)
    return jsonify({"ok": True, "email": email, "enabled": enabled})


@app.post("/api/backup/email")
def api_backup_email():
    uid = auth.current_user_id()
    user, err = _user_plan_guard(uid, "email_backup")
    if err:
        return err
    body = request.get_json(silent=True) or {}
    recipient = str(body.get("email") or user["backup_email"] or user["email"]).strip().lower()
    if not EMAIL_RE.match(recipient):
        return jsonify({"error": "invalid email"}), 400
    try:
        meta = send_user_backup(uid, recipient)
    except Exception as exc:
        db.log_backup(uid, recipient, 0, 0, "error", str(exc))
        return jsonify({"error": f"email failed: {exc}"}), 502
    return jsonify(
        {
            "ok": True,
            "bytes": meta["bytes_size"],
            "items": meta["item_count"],
            "compact": bool(meta.get("compact")),
            "local_path": meta.get("local_path"),
        }
    )


@app.post("/api/backup/pcloud/settings")
def api_backup_pcloud_settings():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    user = db.get_user_by_id(uid)
    if not user:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    username = str(body.get("username") or "").strip()
    remote_path = str(body.get("remote_path") or "Deeperguard/backups").strip()
    region = str(body.get("region") or "eu").strip().lower()
    enabled = bool(body.get("enabled"))
    if enabled:
        blocked = _plan_block(user, "pcloud_backup")
        if blocked:
            return blocked
    password_raw = body.get("password")
    password = str(password_raw).strip() if password_raw is not None else None
    if password == "":
        password = None
    rclone_token = body.get("rclone_token")
    if rclone_token is not None:
        rclone_token = str(rclone_token).strip()
    try:
        save_pcloud_settings(
            uid,
            username=username,
            remote_path=remote_path,
            region=region,
            enabled=enabled,
            password=password,
            rclone_token=rclone_token,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    user = db.get_user_by_id(uid)
    return jsonify(
        {
            "ok": True,
            "enabled": enabled,
            "username": username,
            "remote_path": user["pcloud_remote_path"] if user else remote_path,
            "region": user["pcloud_region"] if user else region,
            "password_set": pcloud_password_set(uid),
            "token_set": pcloud_token_set(uid),
        }
    )


@app.post("/api/backup/pcloud/sync")
def api_backup_pcloud_sync():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    user = db.get_user_by_id(uid)
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "pcloud_backup")
    if blocked:
        return blocked
    if not user["pcloud_username"]:
        return jsonify({"error": "pCloud username is not configured"}), 400
    if not pcloud_credentials_configured(uid):
        return jsonify({"error": "pCloud password or rclone OAuth token is not configured"}), 400
    try:
        meta = sync_user_backup(uid)
    except Exception as exc:
        return jsonify({"error": f"pCloud sync failed: {exc}"}), 502
    return jsonify(meta)


@app.post("/api/ocr")
def api_ocr():
    if not server_ocr_enabled():
        return jsonify({"error": SERVER_OCR_DISABLED}), 403
    uid = auth.current_user_id()
    _, err = _user_plan_guard(uid, "document_ocr")
    if err:
        return err
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"error": "file required"}), 400
    cl = request.content_length
    if cl is not None and cl > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to process on the server."}), 400
    data = uploaded.read()
    if len(data) > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to process on the server."}), 400
    filename = uploaded.filename or "document"
    mime = uploaded.mimetype or ""
    att_id = ocr_index.safe_att_id(
        request.form.get("att_id") or request.form.get("attId") or ""
    )
    # Synchronous fallback for callers that need an immediate response.
    if request.args.get("sync") == "1" or request.form.get("sync") == "1":
        try:
            result = ocr_mod.extract(filename, mime, data)
        except ocr_mod.OcrError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": f"processing failed: {exc}"}), 500
        stored = ocr_index.save_document(uid, att_id, filename, mime, data, result)
        if ocr_ephemeral() and att_id:
            ocr_index.delete_document(uid, att_id)
        return jsonify({"ok": True, **result, "att_id": stored.get("att_id") or ""})
    try:
        job_id = ocr_jobs.submit(uid, filename, mime, data, att_id)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify({"ok": True, "job_id": job_id, "status": "pending"}), 202


@app.get("/api/ocr/jobs/<job_id>")
def api_ocr_job(job_id: str):
    if not server_ocr_enabled():
        return jsonify({"error": SERVER_OCR_DISABLED}), 403
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    job = ocr_jobs.get_job(job_id, uid)
    if not job:
        return jsonify({"error": "job not found"}), 404
    status = job.get("status") or "pending"
    if status in {"pending", "running"}:
        return jsonify(job), 202
    if status == "error":
        return jsonify(job), 400
    return jsonify(job)


@app.post("/api/media/preview")
def api_media_preview():
    """Return a list-sized JPEG preview without running full OCR indexing."""
    if not server_ocr_enabled():
        return jsonify({"error": SERVER_OCR_DISABLED}), 403
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"error": "file required"}), 400
    data = uploaded.read()
    if not data:
        return jsonify({"error": "empty file"}), 400
    if len(data) > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to process on the server."}), 400
    filename = uploaded.filename or "document"
    mime = uploaded.mimetype or ""
    try:
        preview = ocr_mod.render_list_preview(filename, mime, data)
    except ocr_mod.OcrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"processing failed: {exc}"}), 500
    if not preview:
        return jsonify({"error": "Could not render a preview for this file."}), 400
    return jsonify({
        "ok": True,
        "preview_jpeg_b64": base64.b64encode(preview).decode("ascii"),
        "att_id": ocr_index.safe_att_id(
            request.form.get("att_id") or request.form.get("attId") or ""
        ) or "",
    })


@app.post("/api/ocr/store")
def api_ocr_store():
    if not server_ocr_enabled():
        return jsonify({"error": SERVER_OCR_DISABLED}), 403
    uid = auth.current_user_id()
    _, err = _user_plan_guard(uid, "document_ocr")
    if err:
        return err
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify({"error": "file required"}), 400
    att_id = ocr_index.safe_att_id(
        request.form.get("att_id") or request.form.get("attId") or ""
    )
    if not att_id:
        return jsonify({"error": "valid att_id required"}), 400
    data = uploaded.read()
    if not data:
        return jsonify({"error": "empty file"}), 400
    if len(data) > ocr_mod.MAX_BYTES:
        return jsonify({"error": "File too large to store on the server."}), 400
    stored = ocr_index.save_file_only(
        uid,
        att_id,
        uploaded.filename or "document",
        uploaded.mimetype or "",
        data,
    )
    return jsonify({
        "ok": True,
        "att_id": stored["att_id"],
        "stored": bool(stored.get("stored")),
        "bytes": int(stored.get("bytes") or 0),
        "ephemeral": ocr_ephemeral(),
    })


@app.get("/api/ocr/index")
def api_ocr_index():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    if not server_ocr_enabled():
        return jsonify({
            "ok": True,
            "ephemeral": True,
            "client": True,
            "index_version": ocr_index.INDEX_VERSION,
            "count": 0,
            "items": [],
        })
    items = ocr_index.list_index(uid)
    return jsonify({
        "ok": True,
        "ephemeral": ocr_ephemeral(),
        "index_version": ocr_index.INDEX_VERSION,
        "count": len(items),
        "items": items,
    })


@app.delete("/api/ocr/<att_id>")
def api_ocr_delete(att_id: str):
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    deleted = ocr_index.delete_document(uid, att_id)
    return jsonify({"ok": True, "deleted": deleted, "att_id": ocr_index.safe_att_id(att_id)})


@app.post("/api/ocr/reindex")
def api_ocr_reindex():
    uid = auth.current_user_id()
    _, err = _user_plan_guard(uid, "document_ocr")
    if err:
        return err
    return jsonify(ocr_index.reindex_user(uid))


@app.post("/api/media/prepare")
def api_media_prepare():
    if not server_ocr_enabled():
        return jsonify({"error": SERVER_OCR_DISABLED}), 403
    uid = auth.current_user_id()
    _, err = _user_plan_guard(uid, "document_ocr")
    if err:
        return err
    uploads = request.files.getlist("file")
    if not uploads:
        return jsonify({"error": "file required"}), 400
    rows = [
        (item.filename or "photo.jpg", item.mimetype or "", item.read())
        for item in uploads
    ]
    try:
        result = ocr_mod.prepare(rows)
    except ocr_mod.OcrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"prepare failed: {exc}"}), 500
    response = app.response_class(result["data"], mimetype=result["mime"])
    response.headers["X-Notes-Filename"] = result["filename"]
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/sync/watermark")
def api_sync_watermark():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    data = db.get_sync_watermark(uid)
    return jsonify({**data, "server_time": time.time()})


@app.post("/api/sync/refetch")
def api_sync_refetch():
    """Return full ciphertext for specific items (ignores known_hashes)."""
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("uuids") or body.get("item_uuids") or []
    if not isinstance(raw_ids, list):
        return jsonify({"error": "uuids must be a list"}), 400
    uuids = [str(u).strip() for u in raw_ids if str(u).strip()][:50]
    include_blobs = str(body.get("include_blobs", "1")).strip().lower() not in {"0", "false", "no"}
    items = db.list_items_by_uuid(uid, uuids, include_blobs=include_blobs)
    return jsonify({"items": items, "server_time": time.time()})


@app.post("/api/sync/blobs")
def api_sync_blobs():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("uuids") or body.get("item_uuids") or []
    if not isinstance(raw_ids, list):
        return jsonify({"error": "uuids must be a list"}), 400
    uuids = [str(u).strip() for u in raw_ids if str(u).strip()][:50]
    blobs = db.list_item_blobs(uid, uuids)
    return jsonify({"blobs": blobs, "server_time": time.time()})


def _normalize_known_hashes(raw) -> dict[str, str]:
    if isinstance(raw, dict):
        return {
            str(k): str(v)
            for k, v in raw.items()
            if k and v is not None
        }
    if isinstance(raw, str):
        return _parse_known_hashes(raw)
    return {}


# A pull's read snapshot can miss a push that took the write lock (and its
# synced_at) slightly earlier but had not committed yet. Keep the returned
# cursor this far behind "now" so the next incremental pull picks it up; the
# overlap only re-sends rows the client reports as unchanged.
SYNC_CURSOR_SAFETY_SEC = 10.0


def _sync_cursor_kind(raw) -> str:
    return "synced_at" if str(raw or "").strip().lower() in {"synced_at", "synced"} else "updated_at"


def _sync_pull_response(
    uid: int,
    since: float,
    after_uuid: str,
    include_blobs: bool,
    known_hashes: dict[str, str],
    limit: int,
    cursor_kind: str = "updated_at",
):
    started = time.time()
    limit = max(1, min(limit, 50))
    candidates = db.list_items_since(
        uid,
        since,
        after_uuid=after_uuid,
        limit=limit,
        include_blobs=include_blobs,
        known_hashes=known_hashes or None,
        cursor=cursor_kind,
    )
    max_bytes = int(os.environ.get("NOTES_SYNC_PAGE_BYTES", str(3_500_000)))
    items: list = []
    used = 0
    unchanged = 0
    for row in candidates:
        size = len(str(row.get("ciphertext") or "")) + len(str(row.get("blob_ciphertext") or ""))
        if row.get("unchanged"):
            unchanged += 1
        if items and used + size > max_bytes:
            break
        items.append(row)
        used += size
    total_undeleted = db.count_undeleted_items(uid) if not after_uuid else None
    has_more = len(items) < len(candidates) or len(candidates) >= limit
    now = time.time()

    def _row_cursor(row) -> float:
        # Mirror db.list_items_since: rows stuck at synced_at = 0 advance the
        # cursor by updated_at so pages cannot stall or loop on legacy rows.
        if cursor_kind == "synced_at":
            synced = float(row.get("synced_at") or 0)
            if synced > 0:
                return synced
        return float(row.get("updated_at") or 0)

    page_max = max((_row_cursor(row) for row in items), default=0.0)
    if has_more:
        next_cursor = max(since, page_max)
    else:
        next_cursor = max(since, page_max, now - SYNC_CURSOR_SAFETY_SEC)
    elapsed_ms = int((now - started) * 1000)
    line = (
        f"sync pull user={uid} since={since:.3f} after={after_uuid or '-'} kind={cursor_kind} "
        f"items={len(items)} unchanged={unchanged} bytes={used} has_more={has_more} "
        f"total={total_undeleted if total_undeleted is not None else '-'} ms={elapsed_ms}"
    )
    _sync_log_line(line)
    return {
        "items": items,
        "server_time": now,
        "has_more": has_more,
        "limit": limit,
        "total_undeleted": total_undeleted,
        "unchanged": unchanged,
        "cursor_kind": cursor_kind,
        "cursor": next_cursor,
    }


@app.get("/api/sync/items")
def api_sync_list():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    since = float(request.args.get("since") or 0)
    after_uuid = str(request.args.get("after") or "").strip()
    include_blobs = str(request.args.get("include_blobs", "1")).strip().lower() not in {"0", "false", "no"}
    known_hashes = _parse_known_hashes(request.args.get("known_hashes") or "")
    try:
        limit = int(request.args.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    return jsonify(
        _sync_pull_response(
            uid,
            since,
            after_uuid,
            include_blobs,
            known_hashes,
            limit,
            cursor_kind=_sync_cursor_kind(request.args.get("cursor")),
        )
    )


@app.post("/api/sync/pull")
def api_sync_pull():
    """Sync pull with known_hashes in the POST body (avoids URL length limits)."""
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    since = float(body.get("since") or 0)
    after_uuid = str(body.get("after") or "").strip()
    include_blobs = str(body.get("include_blobs", "1")).strip().lower() not in {"0", "false", "no"}
    known_hashes = _normalize_known_hashes(body.get("known_hashes"))
    try:
        limit = int(body.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    return jsonify(
        _sync_pull_response(
            uid,
            since,
            after_uuid,
            include_blobs,
            known_hashes,
            limit,
            cursor_kind=_sync_cursor_kind(body.get("cursor")),
        )
    )


@app.post("/api/sync/items")
def api_sync_push():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(silent=True) or {}
    started = time.time()
    raw_items = body.get("items")
    if not isinstance(raw_items, list):
        return jsonify({"error": "items must be a list"}), 400
    valid_items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        item_uuid = str(item.get("item_uuid") or "").strip()
        ciphertext = str(item.get("ciphertext") or "")
        if not item_uuid or not ciphertext:
            continue
        valid_items.append(item)
    results = db.upsert_items_batch(uid, valid_items)
    accepted = sum(1 for row in results if row.get("status") == "ok")
    unchanged = sum(1 for row in results if row.get("status") == "unchanged")
    stale = sum(1 for row in results if row.get("status") == "stale")
    quota_hits = sum(1 for row in results if row.get("status") == "quota_exceeded")
    body_bytes = int(request.content_length or 0)
    line = (
        f"sync push user={uid} items={len(raw_items)} accepted={accepted} "
        f"unchanged={unchanged} stale={stale} quota={quota_hits} bytes={body_bytes} "
        f"ms={int((time.time() - started) * 1000)}"
    )
    _sync_log_line(line)
    if quota_hits:
        user = db.get_user_by_id(uid)
        quota = db.user_storage_quota_bytes(user) if user else 0
        return jsonify({
            "error": "storage quota exceeded",
            "quota_bytes": quota,
            "results": results,
        }), 413
    return jsonify({
        "ok": True,
        "accepted": accepted,
        "unchanged": unchanged,
        "stale": stale,
        "results": results,
        "server_time": time.time(),
    })


def _lan_https_host() -> str:
    """Hostname for HTTPS links on the plain-HTTP certificate setup page."""
    pinned = (os.environ.get("NOTES_PUBLIC_HOST") or "").strip().lower()
    raw = (request.host or "").split(":", 1)[0].strip("[]").lower()
    if pinned and _SAFE_HTTPS_HOST.fullmatch(pinned):
        return pinned
    if raw and _SAFE_HTTPS_HOST.fullmatch(raw) and ".." not in raw:
        return raw
    return pinned or "127.0.0.1"


def _request_host() -> str:
    return (request.host or "").split(":", 1)[0].strip("[]").lower()


def _legacy_notes_host_redirect():
    """Send notes.* traffic to the canonical public host (www.deeperguard.com)."""
    host = _request_host()
    canonical = normalize_host(NOTES_PUBLIC_HOST)
    if not canonical or is_ip_host(canonical) or host == canonical:
        return None
    if not (host.startswith("notes.") and _SAFE_HTTPS_HOST.fullmatch(host)):
        return None
    base = NOTES_PUBLIC_URL.rstrip("/")
    target = f"{base}{request.full_path}"
    if target.endswith("?"):
        target = target[:-1]
    code = 301 if request.method in {"GET", "HEAD"} else 308
    return redirect(target, code=code)


def _promo_payload() -> dict:
    return notes_promo.promo_payload(
        product_name="Deeperguard",
        public_host=NOTES_PUBLIC_HOST,
        public_url=NOTES_PUBLIC_URL,
        app_path=app_entry_path(),
        contact_email=CONTACT_EMAIL,
        billing_note="Free during public beta",
    )


def _marketing_context() -> dict:
    basic = PLAN_CATALOG[PLAN_BASIC]
    pro = PLAN_CATALOG[PLAN_PRO]
    basic_features = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_BASIC in feat["plans"]]
    pro_features = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_PRO in feat["plans"]]
    pro_only = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_PRO in feat["plans"] and PLAN_BASIC not in feat["plans"]]
    entry = app_entry_path()
    base = NOTES_PUBLIC_URL.rstrip("/")
    promo = _promo_payload()
    return {
        "build": NOTES_BUILD,
        "site_url": f"{base}/",
        "canonical_url": f"{base}/",
        "og_image": f"{base}/static/icons/icon-512.png?v={NOTES_BUILD}",
        "json_ld": promo["structured_data"],
        "app_url": f"{base}{entry}",
        "app_path": entry,
        "register_url": f"{base}/register",
        "login_url": f"{base}/login",
        "basic": basic,
        "pro": pro,
        "basic_features": basic_features,
        "pro_features": pro_features,
        "pro_only_features": pro_only,
        "features": FEATURE_CATALOG,
        "plan_basic": PLAN_BASIC,
        "plan_pro": PLAN_PRO,
        "billing_note": "Free during public beta",
        "contact_email": CONTACT_EMAIL,
    }


def _redirect_app_entry(strip_hard: bool = False) -> str:
    from urllib.parse import urlencode

    q = request.args.to_dict(flat=True)
    if strip_hard:
        q.pop("hard", None)
    target = app_entry_path()
    if q:
        target += "?" + urlencode(q)
    return target


def _render_notes_app():
    host = _request_host()
    if request.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        return render_template("https-setup.html", host=_lan_https_host(), build=NOTES_BUILD)
    return render_template(
        "app.html",
        csrf_token="",
        skip_login=skip_login(),
        build=NOTES_BUILD,
    )


@app.post("/")
def index_post():
    return redirect(url_for("index"))


@app.get("/")
def index():
    host = _request_host()
    # Legacy PWA bookmarks and email deep links pointed at /.
    if request.args.get("hard") == "1" or request.args.get("note"):
        return redirect(_redirect_app_entry(strip_hard=True), code=302)
    if request.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        return render_template("https-setup.html", host=_lan_https_host(), build=NOTES_BUILD)
    response = make_response(render_template("marketing.html", **_marketing_context()))
    return response


@app.post(app_entry_path())
def notes_app_post():
    return redirect(url_for("notes_app"))


@app.get(app_entry_path())
def notes_app():
    if request.args.get("hard") == "1":
        return redirect(_redirect_app_entry(strip_hard=True), code=302)
    return _render_notes_app()


@app.get("/api/app-shell")
def api_app_shell():
    """Current app shell HTML for the in-app Update download.

    Lives under /api/ so the service worker never intercepts it: the worker's
    navigation handler falls back to the *cached* shell on slow networks, which
    made "Update now" silently re-install the build it was trying to replace.
    """
    response = app.make_response(_render_notes_app())
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Notes-Build"] = NOTES_BUILD
    return response


@app.get("/pricing")
def pricing_page():
    ctx = _marketing_context()
    ctx["canonical_url"] = f"{NOTES_PUBLIC_URL.rstrip('/')}/pricing"
    return render_template("marketing.html", **ctx)


@app.get("/compare/standard-notes")
def compare_standard_notes_page():
    host = _request_host()
    if request.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        return render_template("https-setup.html", host=_lan_https_host(), build=NOTES_BUILD)
    ctx = _marketing_context()
    ctx["canonical_url"] = f"{NOTES_PUBLIC_URL.rstrip('/')}/compare/standard-notes"
    return make_response(render_template("compare-standard-notes.html", **ctx))


@app.get("/api/promo")
def api_promo():
    return jsonify(_promo_payload())


@app.get("/robots.txt")
def robots_txt():
    site = NOTES_PUBLIC_URL.rstrip("/")
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Allow: /api/promo\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )
    return app.response_class(body, mimetype="text/plain; charset=utf-8")


@app.get("/sitemap.xml")
def sitemap_xml():
    site = NOTES_PUBLIC_URL.rstrip("/")
    entry = app_entry_path()
    pages = [
        "/",
        "/pricing",
        "/compare/standard-notes",
        entry,
        "/register",
        "/login",
        "/privacy",
        "/terms",
        "/self-host",
        "/api/promo",
    ]
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for page in pages:
        lines.append("  <url>")
        lines.append(f"    <loc>{site}{page}</loc>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return app.response_class("\n".join(lines), mimetype="application/xml; charset=utf-8")


if INDEXNOW_KEY:

    @app.get(f"/{INDEXNOW_KEY}.txt")
    def indexnow_key_file():
        return app.response_class(INDEXNOW_KEY, mimetype="text/plain; charset=utf-8")


@app.get("/ca.crt")
def ca_certificate():
    keys = os.environ.get("NOTES_KEYS") or os.path.join(os.environ.get("NOTES_ROOT", "/opt/deeperguard"), "keys")
    ca_dir = os.path.join(keys, "tls")
    ca_path = os.path.join(ca_dir, "ca.crt")
    if not os.path.isfile(ca_path):
        return ("LAN certificate is not installed on this host.", 404)
    return send_from_directory(
        ca_dir,
        "ca.crt",
        mimetype="application/x-x509-ca-cert",
        as_attachment=True,
        download_name="deeperguard-ca.crt",
    )


@app.get("/manifest.json")
def manifest():
    manifest_path = Path(app.static_folder) / "manifest.json"
    body = manifest_path.read_text(encoding="utf-8").replace("__NOTES_BUILD__", NOTES_BUILD)
    response = app.response_class(body, mimetype="application/manifest+json")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/sw.js")
def service_worker():
    sw_path = Path(app.static_folder) / "sw.js"
    # Do not inject NOTES_BUILD — a changing worker file reloads Safari tabs.
    body = sw_path.read_text(encoding="utf-8")
    response = app.response_class(body, mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


# Initialize DB on import for gunicorn workers.
log_server_ocr_startup_warning()
log_signup_notify_config()
db.init_schema()
from uploads import migrate_email_named_upload_dirs

migrate_email_named_upload_dirs()
server_info_cache.start_refresh_loop()
admin_api.register_admin_routes(app, NOTES_BUILD)
if ocr_ephemeral():
    try:
        ocr_index.purge_legacy_plaintext_indexes()
    except Exception:
        pass
