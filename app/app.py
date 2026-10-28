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
import blog
import ask_ai_provider_pin
import verify_metadata_baseline
import ai_relay
import auth
import client_assets
import db
import email_verify
import ocr as ocr_mod
import ocr_index
import ocr_jobs
import server_info_cache
import sync_log
import totp as totp_mod
from flask.sessions import SecureCookieSessionInterface
from datetime import timedelta

from config import CONTACT_EMAIL, DATA_DIR, INDEXNOW_KEY, NOTES_PUBLIC_HOST, NOTES_PUBLIC_URL, SESSION_SECONDS, app_entry_path, ensure_flask_secret, is_ip_host, log_server_ocr_startup_warning, log_turnstile_startup_warning, log_wan_secure_cookies_startup_warning, normalize_host, ocr_ephemeral, pcloud_password_set, pcloud_token_set, repair_login_password_enabled, register_ip_hourly_cap, serve_ca_crt, server_ocr_enabled, session_cookie_domain, skip_login, strict_zk, allow_register, min_password_length, turnstile_required, turnstile_secret_key, turnstile_site_key, turnstile_unpaired, webauthn_preferred_host, user_is_admin
from uploads import ensure_user_upload_dir, user_upload_dir
import promo as notes_promo
from backup_mail import send_user_backup
from admin_notify import log_signup_notify_config, notify_new_user_signup
from mailer import send_contact_email
from backup_pcloud import pcloud_credentials_configured, save_pcloud_settings, sync_user_backup
from passwords import hash_password, new_kdf_salt, verify_password
from srp_auth import (
    SRP_KDF_V2,
    SrpServerSession,
    fake_srp_challenge,
    generate_verifier_hex,
    new_srp_salt_hex,
    normalize_srp_kdf_version,
)
from vault_crypto import password_unlocks_samples
import passkey_signin
import webauthn_helper as webauthn_mod
from auth_rate_limit import allow as auth_rate_allow
from plans import (
    FEATURE_CATALOG,
    PLAN_BASIC,
    PLAN_CATALOG,
    PLAN_FREE,
    PLAN_PRO,
    account_plan_payload,
    plan_has,
    plan_required_error,
)
from verification_send_limit import (
    VerificationSendLimited,
    backup_attachment_cap_message,
    check_backup_attachment_send,
    record_backup_attachment_send,
    verification_cooldown_remaining,
    verification_retry_after,
)

class HostOnlySessionInterface(SecureCookieSessionInterface):
    """Host-only session cookies; migrate legacy Domain=.deeperguard.com cookies."""

    LEGACY_COOKIE = "session"
    HOST_COOKIE = "__Host-session"

    def get_cookie_domain(self, app: Flask) -> str | None:
        return None

    def get_cookie_name(self, app: Flask) -> str:
        if app.config.get("SESSION_COOKIE_SECURE"):
            return self.HOST_COOKIE
        return self.LEGACY_COOKIE

    def open_session(self, app: Flask, request):  # type: ignore[override]
        name = self.get_cookie_name(app)
        has_host = bool(request.cookies.get(name))
        has_legacy = bool(request.cookies.get(self.LEGACY_COOKIE))
        if not has_host and has_legacy and name != self.LEGACY_COOKIE:
            try:
                from flask import g

                g._dg_migrate_session_cookie = True
            except Exception:
                pass
            previous = app.config.get("SESSION_COOKIE_NAME")
            app.config["SESSION_COOKIE_NAME"] = self.LEGACY_COOKIE
            try:
                return super().open_session(app, request)
            finally:
                app.config["SESSION_COOKIE_NAME"] = previous or name
        return super().open_session(app, request)

    def save_session(self, app, session, response):  # type: ignore[override]
        app.config["SESSION_COOKIE_DOMAIN"] = None
        super().save_session(app, session, response)
        # Always clear legacy Domain cookies when Secure host-only cookies are used.
        if app.config.get("SESSION_COOKIE_SECURE") and self.get_cookie_name(app) == self.HOST_COOKIE:
            for domain in (".deeperguard.com", "deeperguard.com"):
                response.set_cookie(
                    self.LEGACY_COOKIE,
                    "",
                    expires=0,
                    max_age=0,
                    path="/",
                    domain=domain,
                    secure=True,
                    httponly=True,
                    samesite="Lax",
                )


app = Flask(__name__, template_folder="templates", static_folder="static")
app.session_interface = HostOnlySessionInterface()
app.secret_key = ensure_flask_secret()
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("NOTES_SECURE_COOKIES", "0") == "1"
app.config["SESSION_COOKIE_DOMAIN"] = None
app.config["SESSION_COOKIE_PATH"] = "/"
if app.config["SESSION_COOKIE_SECURE"]:
    app.config["SESSION_COOKIE_NAME"] = HostOnlySessionInterface.HOST_COOKIE
else:
    app.config["SESSION_COOKIE_NAME"] = HostOnlySessionInterface.LEGACY_COOKIE
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(seconds=SESSION_SECONDS)
# 50 MB files are stored as base64 inside JSON (~4/3). 48 MB rejected those uploads.
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024


@app.context_processor
def _inject_template_globals():
    csp_report_only = os.environ.get("NOTES_CSP_REPORT_ONLY", "0") == "1"
    return {
        **client_assets.jinja_globals(),
        **ask_ai_provider_pin.template_globals(),
        "csp_nonce": auth.csp_nonce(),
        "csp_policy": "" if csp_report_only else auth.content_security_policy(),
        "client_hash": client_assets.client_hash(),
        "client_hash_short": client_assets.client_hash_short(),
        "release_tag": client_assets.release_tag(),
        "release_url": client_assets.release_url(),
        "release_signed": client_assets.release_is_signed(),
    }


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
        kdf_ver = db.user_srp_kdf_version(user)
        computed = int(
            generate_verifier_hex(str(user["srp_salt"]), email, password, kdf_version=kdf_ver),
            16,
        )
        stored = int(str(user["srp_verifier"]), 16)
    except (TypeError, ValueError):
        return False
    return computed == stored


def _revoke_other_sessions(uid: int, *, reason: str = "security") -> None:
    try:
        db.revoke_other_user_sessions(int(uid), auth.current_session_token(), reason=reason)
    except Exception:
        log.exception("revoke other sessions failed")


def _generic_client_error(log_msg: str, exc: Exception | None = None, *, status: int = 400):
    if exc is not None:
        log.exception("%s: %s", log_msg, exc)
    else:
        log.error("%s", log_msg)
    return jsonify({"error": "request failed"}), status


def _account_login_password_ok(user, email: str, password: str) -> bool:
    """True when password matches the stored SRP verifier and/or leftover login hash."""
    if not password:
        return False
    if db.user_has_srp(user) and _srp_verifier_matches(user, email, password):
        return True
    if db.user_has_legacy_password(user) and verify_password(user["password_hash"], password):
        return True
    return False


def _stored_srp_challenge(email: str, user, purpose: str) -> str:
    """SRP step-1 bound to the account's *stored* salt/verifier.

    Repair-login, vault-recovery, and SRP KDF-upgrade proofs must authenticate
    against the credentials on file — never against client-supplied ones, which
    would let a caller swap in a self-made verifier (SECURITY-REVIEW-2026-10-07
    H-1/M-1; SECURITY-REVIEW-2026-10-22 M-3).
    """
    sess = SrpServerSession()
    srp_salt = str(user["srp_salt"])
    srp_verifier = str(user["srp_verifier"])
    b_hex = sess.step1(email, srp_salt, srp_verifier)
    auth.store_srp_credential_challenge(
        email,
        srp_salt,
        srp_verifier,
        sess.to_private_state(),
        purpose,
        int(user["id"]),
    )
    return b_hex


def _complete_stored_srp_proof(email: str, user, a_hex: str, m1: str, purpose: str) -> str | None:
    """Return M2 when A/M1 complete an SRP exchange against the stored verifier."""
    if not db.user_has_srp(user):
        return None
    state = auth.pop_srp_credential_challenge(
        email,
        str(user["srp_salt"]),
        str(user["srp_verifier"]),
        purpose,
        int(user["id"]),
    )
    if not state:
        return None
    try:
        sess = SrpServerSession.from_private_state(state)
        return sess.step2(a_hex, m1)
    except ValueError:
        return None


def _verify_stored_srp_proof(email: str, user, a_hex: str, m1: str, purpose: str) -> bool:
    """True when A/M1 complete an SRP exchange against the stored verifier (password never sent)."""
    return _complete_stored_srp_proof(email, user, a_hex, m1, purpose) is not None


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
    *,
    srp_kdf_version: int = SRP_KDF_V2,
) -> None:
    db.update_user_srp_verifier(
        uid, srp_salt, srp_verifier, srp_kdf_version=normalize_srp_kdf_version(srp_kdf_version),
    )
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


def _login_user(user_id: int, *, totp_ok: bool, check_cap: bool = True):
    """Establish a session or return a 403 session_cap response (never auto-revokes).

    When TOTP is still required (``totp_ok`` is False) and the soft-cap is full,
    return a plain ``session_cap`` + ``totp_required`` message with no session
    list and no revoke token. The client must complete ``/api/totp/verify``
    before listing or revoking devices.
    """
    try:
        auth.login_user(int(user_id), totp_ok=totp_ok, check_cap=check_cap)
        auth.clear_session_cap_revoke()
        return None
    except auth.SessionCapExceeded as exc:
        if not totp_ok:
            auth.begin_session_cap_totp(exc.user_id)
            return jsonify({
                "error": auth.session_cap_message(
                    limit=int(exc.payload.get("limit") or 0),
                    plan=str(exc.payload.get("plan") or ""),
                    totp_required=True,
                ),
                "code": "session_cap",
                "totp_required": True,
                "limit": exc.payload.get("limit"),
                "plan": exc.payload.get("plan") or "",
                "csrf": auth.csrf_token(),
            }), 403
        revoke_token = auth.issue_session_cap_revoke(exc.user_id)
        body = dict(exc.payload)
        body["revoke_token"] = revoke_token
        return jsonify(body), 403


def _complete_session_cap_after_totp():
    """Finish a cap-pending login after TOTP, or return the session list + revoke token."""
    try:
        auth.finish_session_cap_pending()
        auth.clear_session_cap_revoke()
        return None
    except auth.SessionCapExceeded as exc:
        revoke_token = auth.issue_session_cap_revoke_exclusive(exc.user_id)
        body = dict(exc.payload)
        body["revoke_token"] = revoke_token
        return jsonify(body), 403


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
NOTES_CLIENT_HASH = client_assets.client_hash()
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
    elif request.path in {
        "/", "/pricing", "/compare/standard-notes", "/compare/notesnook",
        "/compare/joplin", "/evernote-alternative", "/for/freelancers",
        "/contact", "/download", "/privacy", "/terms", "/verify",
        "/blog", "/blog/feed.xml",
    } or request.path.startswith("/blog/"):
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
        # must-revalidate: do not paint a previous deploy's HTML while
        # revalidation is in flight (that left fresh sessions on an old build).
        # stale-if-error still covers a dead origin.
        response.headers["Cache-Control"] = (
            "public, max-age=0, must-revalidate, stale-if-error=604800"
        )
        response.headers.pop("Pragma", None)
        session.accessed = False
        session.modified = False
        _drop_set_cookie(response)
    elif client_assets.resolve_hashed_static(request.path):
        # Content-hashed filenames are immutable; HTML always points at a new name.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
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
def _serve_hashed_static():
    """Serve /static/js/app.<sha16>.js from app/static/js/app.js when the hash matches."""
    logical = client_assets.resolve_hashed_static(request.path)
    if not logical:
        return None
    if request.method not in {"GET", "HEAD"}:
        return None
    if not auth.client_allowed():
        return ("Deeperguard is limited to the LAN and WireGuard.", 403)
    return send_from_directory(Path(app.static_folder), logical)


@app.before_request
def _gate():
    legacy = _legacy_notes_host_redirect()
    if legacy is not None:
        return legacy
    if not auth.client_allowed():
        return ("Deeperguard is limited to the LAN and WireGuard.", 403)
    # Unmatched URLs must not bounce to the sign-in page.
    if request.url_rule is None:
        if request.path.startswith("/api/"):
            return jsonify({"error": "not found"}), 404
        return render_template("not-found.html", **_marketing_context()), 404
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
        if request.path == "/api/boot-account" and request.method == "GET":
            # Signed-out shell probe. 200 so the console does not log a 401.
            # A revoked session still has to surface so this device can wipe.
            if wipe:
                return jsonify({"error": "session revoked", "code": "session_revoked"}), 401
            return jsonify({"signed_out": True})
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
        "/api/account/unlock/challenge",
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


def _signed_in_user():
    if not auth.authenticated():
        return None
    uid = auth.current_user_id()
    return db.get_user_by_id(uid) if uid else None


@app.errorhandler(404)
def not_found(_err):
    if request.path.startswith("/api/"):
        return jsonify({"error": "not found"}), 404
    return render_template("not-found.html", **_marketing_context()), 404


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


@app.get("/.well-known/security.txt")
def security_txt():
    contact = CONTACT_EMAIL or "security@deeperguard.com"
    body = (
        f"Contact: mailto:{contact}\n"
        "Preferred-Languages: en, nl\n"
        "Canonical: https://www.deeperguard.com/.well-known/security.txt\n"
        "Policy: https://www.deeperguard.com/privacy\n"
    )
    resp = make_response(body)
    resp.mimetype = "text/plain"
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.get("/api/health")
def health():
    ready, db_ok, disk_ok, db_bytes, server = _health_readiness()
    payload: dict = {
        "ok": ready,
        "service": "deeperguard",
        "build": NOTES_BUILD,
        "client_hash": NOTES_CLIENT_HASH or client_assets.client_hash(),
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
    user = _signed_in_user()
    resp = make_response(render_template(
        "login.html",
        build=NOTES_BUILD,
        form_error=form_error,
        signed_in_email=(user["email"] if user else ""),
        csrf_token=(auth.csrf_token() if user else ""),
    ))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/register", methods=["GET", "POST"])
def register():
    user = _signed_in_user()
    form_error = ""
    if request.method == "POST" and not user:
        form_error = "Account setup did not finish. Reload this page and try again."
    resp = make_response(render_template(
        "register.html",
        build=NOTES_BUILD,
        form_error=form_error,
        signed_in_email=(user["email"] if user else ""),
        csrf_token=(auth.csrf_token() if user else ""),
        turnstile_site_key=turnstile_site_key(),
    ))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/auth/register")
def api_register():
    """Legacy registration disabled — all new accounts use SRP zero-knowledge sign-up."""
    return jsonify(
        {
            "error": "legacy registration disabled — use zero-knowledge sign-up",
            "auth_method": "srp",
        }
    ), 410


def _register_soft_fail():
    return jsonify({
        "error": "Could not complete sign-up. If you already have an account, sign in instead.",
    }), 400


def _verify_turnstile_token(token: str) -> str:
    """Validate Cloudflare Turnstile when NOTES_TURNSTILE_SECRET_KEY is set.

    Returns one of: ``ok``, ``missing``, ``invalid``, ``unavailable``.
    Never logs the token or secret. Fail closed — do not create accounts on error.
    Both keys unset: skip (disabled). Exactly one key: refuse (L-21).
    """
    if turnstile_unpaired():
        log_turnstile_startup_warning()
        log.error("turnstile keys unpaired — refusing register (L-21)")
        return "unavailable"
    secret = turnstile_secret_key()
    if not secret:
        return "ok"
    value = str(token or "").strip()
    if not value:
        return "missing"
    try:
        import urllib.parse
        import urllib.request

        data = urllib.parse.urlencode({
            "secret": secret,
            "response": value,
            "remoteip": auth.client_ip(),
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data=data,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        if bool(payload.get("success")):
            return "ok"
        return "invalid"
    except Exception:
        # Do not log request body / token / secret.
        log.exception("turnstile siteverify unreachable or failed")
        return "unavailable"


def _turnstile_register_error(status: str):
    """Friendly Turnstile errors that do not enumerate accounts."""
    if status == "unavailable":
        return jsonify({
            "error": "Security check is temporarily unavailable. Please try again.",
            "code": "turnstile_unavailable",
        }), 503
    if status == "missing":
        return jsonify({
            "error": "Please complete the security check and try again.",
            "code": "turnstile_required",
        }), 400
    return jsonify({
        "error": "Security check failed. Please try again.",
        "code": "turnstile_failed",
    }), 400


@app.post("/api/auth/srp/register")
def api_auth_srp_register():
    if not allow_register():
        return jsonify({"error": "registration is closed"}), 403
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    # Honeypot (M3): bots that fill hidden fields get the soft-fail response.
    if str(body.get("company") or body.get("website") or "").strip():
        return _register_soft_fail()
    if turnstile_required():
        ts_status = _verify_turnstile_token(
            str(body.get("cf_turnstile_response") or body.get("turnstile_token") or "")
        )
        if ts_status != "ok":
            return _turnstile_register_error(ts_status)
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid email"}), 400
    if not srp_salt or not srp_verifier:
        return jsonify({"error": "missing srp credentials"}), 400
    # Per-IP sign-up cap (default 3/hour) in addition to IP+email bucket.
    if not auth_rate_allow(
        f"srp-register-ip:{auth.client_ip()}",
        limit=register_ip_hourly_cap(),
        window=3600.0,
    ):
        return jsonify({"error": "too many attempts"}), 429
    if _auth_rate_limited("srp-register", email):
        return jsonify({"error": "too many attempts"}), 429
    if db.get_user_by_email(email):
        # Avoid distinct 409 enumeration; same message as a soft failure.
        return _register_soft_fail()
    if srp_kdf_version < SRP_KDF_V2:
        return jsonify({"error": "srp_kdf_version 2 required for new accounts"}), 400
    kdf_salt = new_kdf_salt()
    user_id = db.create_user_srp(
        email,
        kdf_salt,
        srp_salt,
        srp_verifier,
        srp_kdf_version=SRP_KDF_V2,
    )
    blocked = _login_user(user_id, totp_ok=True)
    if blocked:
        return blocked
    notify_new_user_signup(email)
    user = db.get_user_by_id(user_id)
    try:
        email_verify.send_account_code(user)
    except Exception:
        log.exception("signup verification email failed")
    return jsonify(_login_payload(user, totp_required=False))


@app.post("/api/auth/srp/challenge")
def api_auth_srp_challenge():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if _auth_rate_limited("srp-challenge", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user or not db.user_has_srp(user):
        # Deterministic fake salt+B so unknown emails look like a real challenge (M5).
        # Report the current signup default (v2) so v1/v2 accounts are not enumerable (L-20).
        salt_hex, b_hex = fake_srp_challenge(email, app.secret_key)
        return jsonify({"srp_salt": salt_hex, "B": b_hex, "srp_kdf_version": SRP_KDF_V2})
    if passkey_signin.password_login_disabled(user):
        salt_hex, b_hex = fake_srp_challenge(email, app.secret_key)
        return jsonify({"srp_salt": salt_hex, "B": b_hex, "srp_kdf_version": SRP_KDF_V2})
    try:
        sess = SrpServerSession()
        b_hex = sess.step1(email, str(user["srp_salt"]), str(user["srp_verifier"]))
        auth.store_srp_state(
            email,
            sess.to_private_state(),
            str(user["srp_salt"]),
            str(user["srp_verifier"]),
        )
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


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
    if passkey_signin.password_login_disabled(user):
        return jsonify({"error": "invalid credentials"}), 401
    state = auth.pop_srp_state(email, str(user["srp_salt"]), str(user["srp_verifier"]))
    if not state:
        # Same wording as a failed proof so missing-challenge is not enumerable (M1).
        return jsonify({"error": "invalid credentials"}), 401
    try:
        sess = SrpServerSession.from_private_state(state)
        m2 = sess.step2(a_hex, m1)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    totp_required = bool(user["totp_enabled"])
    blocked = _login_user(int(user["id"]), totp_ok=not totp_required)
    if blocked:
        return blocked
    payload = _login_payload(user, totp_required=totp_required)
    payload["M2"] = m2
    kdf_ver = db.user_srp_kdf_version(user)
    payload["srp_kdf_version"] = kdf_ver
    payload["srp_kdf_upgrade"] = kdf_ver < SRP_KDF_V2
    return jsonify(payload)


@app.post("/api/auth/srp/kdf-upgrade/challenge")
def api_auth_srp_kdf_upgrade_challenge():
    """SRP step-1 for v1→v2 verifier upgrade (session + CSRF; binds to stored verifier)."""
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user or not db.user_has_srp(user):
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("srp-kdf-upgrade", email):
        return jsonify({"error": "too many attempts"}), 429
    if db.user_srp_kdf_version(user) >= SRP_KDF_V2:
        return jsonify({"error": "already upgraded"}), 400
    try:
        b_hex = _stored_srp_challenge(email, user, auth.SRP_PURPOSE_KDF_UPGRADE)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


@app.post("/api/auth/srp/kdf-upgrade")
def api_auth_srp_kdf_upgrade():
    """Install a v2 verifier only after a fresh SRP proof of the current password (M-3)."""
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user or not db.user_has_srp(user):
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("srp-kdf-upgrade", email):
        return jsonify({"error": "too many attempts"}), 429
    body = request.get_json(silent=True) or {}
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if srp_kdf_version < SRP_KDF_V2 or not srp_salt or not srp_verifier:
        return jsonify({"error": "invalid upgrade"}), 400
    if db.user_srp_kdf_version(user) >= SRP_KDF_V2:
        return jsonify({"error": "already upgraded"}), 400
    if not a_hex or not m1:
        return jsonify({"error": "missing srp proof"}), 400
    m2 = _complete_stored_srp_proof(email, user, a_hex, m1, auth.SRP_PURPOSE_KDF_UPGRADE)
    if not m2:
        return jsonify({"error": "invalid credentials"}), 403
    # Verifier-format upgrade only — do not bump password_changed_at (that would
    # clear the post-login boot password and surface a false vault unlock error).
    db.update_user_srp_verifier(
        uid,
        srp_salt,
        srp_verifier,
        srp_kdf_version=SRP_KDF_V2,
        touch_password_changed=False,
    )
    return jsonify({"ok": True, "srp_kdf_version": SRP_KDF_V2, "M2": m2})


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
        # Same shape as login challenge for unknown emails (M1).
        salt_hex, b_hex = fake_srp_challenge(email, app.secret_key)
        return jsonify({"srp_salt": salt_hex, "B": b_hex, "srp_kdf_version": SRP_KDF_V2})
    if passkey_signin.password_login_disabled(user):
        salt_hex, b_hex = fake_srp_challenge(email, app.secret_key)
        return jsonify({"srp_salt": salt_hex, "B": b_hex, "srp_kdf_version": SRP_KDF_V2})
    try:
        b_hex = _stored_srp_challenge(email, user, auth.SRP_PURPOSE_REPAIR_LOGIN)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


@app.post("/api/auth/repair-login")
def api_auth_repair_login():
    """Prove the current password against the stored verifier and open a session.

    Prove-only (C1): never rotates salt/verifier here. Credential rotation requires
    a totp_ok session via /api/account/password (or vault-recovery after 2FA).
    Submitted srp_salt/srp_verifier are ignored.

    Round 73: plaintext password is never accepted for SRP accounts (even when
    NOTES_REPAIR_LOGIN_PASSWORD=1). Legacy Argon2-only accounts may get
    code=legacy_login so the client can use /api/auth/login without guessing.
    """
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if not EMAIL_RE.match(email):
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("repair-login", email):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401
    if passkey_signin.password_login_disabled(user):
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401

    is_srp = db.user_has_srp(user) or db.user_auth_method(user) == "srp"

    # Round 73: never verify plaintext against an SRP verifier.
    if repair_login_password_enabled() and password and not is_srp:
        if len(password) < min_password_length():
            return jsonify({"error": "invalid credentials"}), 401
        verified, repair_exhausted = _verify_login_password(user, email, password)
        if not verified:
            return jsonify({"error": "invalid credentials", "repair_exhausted": repair_exhausted}), 401
        uid = int(user["id"])
        totp_required = bool(user["totp_enabled"])
        blocked = _login_user(uid, totp_ok=not totp_required)
        if blocked:
            return blocked
        user = db.get_user_by_id(uid)
        payload = _login_payload(user, totp_required=totp_required)
        payload["login_repaired"] = True
        return jsonify(payload)

    if not is_srp:
        # Point leftover Argon2 accounts at /api/auth/login; never invite this for SRP.
        if db.user_has_legacy_password(user):
            return jsonify({"error": "invalid credentials", "code": "legacy_login"}), 401
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401

    if not a_hex or not m1:
        return jsonify({"error": "invalid credentials"}), 400
    if not _verify_stored_srp_proof(email, user, a_hex, m1, auth.SRP_PURPOSE_REPAIR_LOGIN):
        return jsonify({"error": "invalid credentials", "repair_exhausted": True}), 401
    uid = int(user["id"])
    totp_required = bool(user["totp_enabled"])
    blocked = _login_user(uid, totp_ok=not totp_required)
    if blocked:
        return blocked
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
    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    if not EMAIL_RE.match(email) or not password or not srp_salt or not srp_verifier:
        return jsonify({"error": "invalid credentials"}), 400
    if srp_kdf_version < SRP_KDF_V2:
        return jsonify({"error": "srp_kdf_version 2 required"}), 400
    # Pre-login leftover-hash repair stays public, but a password-only
    # (TOTP-pending) session must not rotate the verifier (L-22).
    if auth.authenticated() and auth.needs_totp():
        return jsonify({"error": "2FA required"}), 403
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
    _realign_login_credentials(
        uid, email, password, srp_salt, srp_verifier, srp_kdf_version=SRP_KDF_V2,
    )
    totp_required = bool(user["totp_enabled"])
    blocked = _login_user(uid, totp_ok=not totp_required)
    if blocked:
        return blocked
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
    if auth.needs_totp():
        return jsonify({"error": "2FA required"}), 403
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
        b_hex = _stored_srp_challenge(email, user, auth.SRP_PURPOSE_VAULT_RECOVERY)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


@app.post("/api/auth/vault-recovery")
def api_auth_vault_recovery():
    """Rebuild login credentials from a client-generated SRP verifier (session required)."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    if srp_salt and srp_verifier and srp_kdf_version < SRP_KDF_V2:
        return jsonify({"error": "srp_kdf_version 2 required"}), 400
    if strict_zk():
        if not srp_salt or not srp_verifier or not EMAIL_RE.match(email) or not a_hex or not m1:
            return jsonify({"error": "invalid credentials"}), 400
        uid = auth.current_user_id()
        if not uid:
            return jsonify({"error": "sign in required"}), 401
        if auth.needs_totp():
            return jsonify({"error": "2FA required"}), 403
        if not auth.csrf_ok():
            return jsonify({"error": "invalid CSRF token"}), 400
        user = db.get_user_by_email(email)
        if not user or int(user["id"]) != int(uid):
            return jsonify({"error": "invalid credentials"}), 401
        if _auth_rate_limited("vault-recovery", email):
            return jsonify({"error": "too many attempts"}), 429
        # Stolen session + CSRF cannot rotate SRP without proving the current password
        # against the verifier on file (SRP step2 bound to stored credentials).
        if not _verify_stored_srp_proof(email, user, a_hex, m1, auth.SRP_PURPOSE_VAULT_RECOVERY):
            return jsonify({"error": "invalid credentials"}), 401
        db.update_user_srp_verifier(
            int(uid), srp_salt, srp_verifier, srp_kdf_version=SRP_KDF_V2,
        )
        # Session + TOTP already passed the gate (L-22). Re-login would clear
        # totp_ok / CSRF and bounce a just-verified 2FA user back to /totp.
        user = db.get_user_by_id(int(uid))
        payload = _login_payload(user, totp_required=False)
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
    _realign_login_credentials(
        uid, email, password, srp_salt, srp_verifier, srp_kdf_version=SRP_KDF_V2,
    )
    user = db.get_user_by_id(uid)
    payload = _login_payload(user, totp_required=False)
    payload["vault_recovered"] = True
    return jsonify(payload)


@app.post("/api/auth/srp/upgrade")
def api_auth_srp_upgrade():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if auth.needs_totp():
        return jsonify({"error": "2FA required"}), 403
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("srp-upgrade", email):
        return jsonify({"error": "too many attempts"}), 429
    if db.user_has_srp(user):
        return jsonify({"ok": True, "auth_method": "srp"})
    body = request.get_json(silent=True) or {}
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    current = str(body.get("current_password") or body.get("password") or "").strip()
    if not srp_salt or not srp_verifier:
        return jsonify({"error": "missing srp credentials"}), 400
    if srp_kdf_version < SRP_KDF_V2:
        return jsonify({"error": "srp_kdf_version 2 required"}), 400
    if not db.user_has_legacy_password(user):
        return jsonify({"error": "invalid credentials"}), 401
    if not current or not verify_password(user["password_hash"], current):
        return jsonify({"error": "invalid credentials"}), 401
    db.upgrade_user_to_srp(uid, srp_salt, srp_verifier, srp_kdf_version=SRP_KDF_V2)
    return jsonify({"ok": True, "auth_method": "srp"})


@app.post("/api/auth/login")
def api_login():
    """Legacy Argon2 password login only. SRP accounts must use A/M1 proofs."""
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "").strip()
    if _auth_rate_limited("legacy-login", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    # Round 73: refuse before any password check when the account is SRP.
    if user and (db.user_auth_method(user) == "srp" or db.user_has_srp(user)):
        return jsonify({"error": "invalid credentials"}), 401
    user_id, totp_required = auth.verify_credentials(email, password)
    if not user_id:
        return jsonify({"error": "invalid credentials"}), 401
    blocked = _login_user(user_id, totp_ok=not totp_required)
    if blocked:
        return blocked
    user = db.get_user_by_id(user_id)
    return jsonify(_login_payload(user, totp_required=totp_required))


@app.post("/api/auth/logout")
def api_logout():
    auth.logout()
    return jsonify({"ok": True})


_SESSION_INACTIVE_SECONDS = 30 * 24 * 60 * 60


def _device_id_suffix(device_id: str) -> str:
    raw = str(device_id or "").strip()
    if not raw:
        return ""
    # Short stable hint for the signed-in devices list (not a secret).
    return raw.replace("-", "")[:4].lower()


def _public_session(row, *, current_token: str, now: float | None = None) -> dict:
    token_match = False
    if current_token:
        stored = db.get_session_by_token(current_token)
        token_match = bool(stored and int(stored["id"]) == int(row["id"]))
    last_seen = float(row["last_seen_at"] or 0)
    device_id = str(row["device_id"] or "")
    at = float(now if now is not None else time.time())
    inactive = bool(last_seen > 0 and (at - last_seen) >= _SESSION_INACTIVE_SECONDS)
    trusted = db.session_is_trusted(row)
    return {
        "id": int(row["id"]),
        "device": str(row["device_label"] or "Unknown device"),
        "device_id_suffix": _device_id_suffix(device_id),
        "ip": str(row["ip"] or ""),
        "ip_location": str(row["ip_location"] or "Unknown"),
        "last_login_at": float(row["last_login_at"] or 0),
        "last_seen_at": last_seen,
        "inactive": inactive,
        "current": token_match,
        "pending": not trusted,
        "trusted": trusted,
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


@app.post("/api/auth/session-cap/revoke")
def api_session_cap_revoke():
    """Revoke one device while blocked at the plan session soft-cap (no new session)."""
    if not auth_rate_allow(
        f"{auth.client_ip()}:session-cap-revoke",
        limit=12,
        window=300.0,
    ):
        return jsonify({"error": "too many attempts"}), 429
    body = request.get_json(silent=True) or {}
    revoke_token = str(body.get("revoke_token") or "").strip()
    try:
        session_id = int(body.get("session_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid session"}), 400
    uid = auth.session_cap_revoke_uid(revoke_token)
    if not uid:
        return jsonify({"error": "sign in again to manage devices"}), 401
    row = db.get_user_session(session_id, uid)
    if not row or row["revoked_at"]:
        return jsonify({"error": "not found"}), 404
    if not db.revoke_user_session(session_id, uid, reason="user"):
        return jsonify({"error": "not found"}), 404
    # Refresh the listed sessions for the login UI (still no auto-login).
    db.prune_user_sessions(uid, older_than=time.time() - SESSION_SECONDS)
    rows = db.list_user_sessions(uid, active_since=time.time() - SESSION_SECONDS)
    limit = None
    plan = ""
    user = db.get_user_by_id(uid)
    if user:
        from plans import plan_active_session_limit

        plan = db.user_plan(user)
        limit = plan_active_session_limit(plan)
    sessions = [auth.session_cap_public_row(row) for row in rows]
    return jsonify({
        "ok": True,
        "sessions": sessions,
        "limit": limit,
        "plan": plan,
        "can_sign_in": limit is None or len(sessions) < int(limit),
    })


@app.post("/api/sessions/<int:session_id>/approve")
def api_approve_session(session_id: int):
    """Mark a pending device session as trusted (optional post-sign-in hardening)."""
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    row = db.get_user_session(session_id, uid)
    if not row or row["revoked_at"]:
        return jsonify({"error": "not found"}), 404
    if db.session_is_trusted(row):
        return jsonify({"ok": True, "id": int(session_id), "pending": False})
    if not db.approve_user_session(session_id, uid):
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True, "id": int(session_id), "pending": False})


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
        return _generic_client_error("webauthn register options failed", exc, status=400)
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
        return _generic_client_error("webauthn register verify failed", exc, status=400)
    _revoke_other_sessions(uid, reason="passkey")
    return jsonify({"ok": True})


@app.post("/api/account/passkey-signin/recovery-codes")
def api_account_passkey_signin_recovery_codes():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "passkeys")
    if blocked:
        return blocked
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    if passkey_signin.passkey_count(uid) < 2:
        return jsonify({"error": "Register at least two passkeys before generating recovery codes."}), 400
    body = request.get_json(silent=True) or {}
    wait_seconds = passkey_signin.normalize_wait_seconds(body.get("wait_seconds"))
    try:
        payload = passkey_signin.issue_recovery_codes(uid, wait_seconds)
    except Exception as exc:
        return _generic_client_error("recovery codes failed", exc, status=400)
    _revoke_other_sessions(uid, reason="recovery-codes")
    return jsonify({"ok": True, **payload, "passkey_signin": passkey_signin.public_status(user)})


@app.post("/api/account/passkey-signin/recovery-codes/cancel")
def api_account_passkey_signin_recovery_cancel():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    if not passkey_signin.cancel_pending_recovery(uid):
        return jsonify({"error": "No pending recovery codes to cancel"}), 400
    user = db.get_user_by_id(uid)
    return jsonify({"ok": True, "passkey_signin": passkey_signin.public_status(user)})


@app.post("/api/account/passkey-signin/password-login")
def api_account_passkey_signin_password_login():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    blocked = _plan_block(user, "passkeys")
    if blocked:
        return blocked
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    body = request.get_json(silent=True) or {}
    disabled = bool(body.get("disabled"))
    ok, reason = passkey_signin.set_password_login_disabled(uid, disabled)
    if not ok:
        return jsonify({"error": reason}), 400
    if disabled:
        _revoke_other_sessions(uid, reason="passkey-only")
    user = db.get_user_by_id(uid)
    return jsonify({"ok": True, "passkey_signin": passkey_signin.public_status(user)})


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
    allowed, reason = passkey_signin.passkey_removal_allowed(uid)
    if not allowed:
        return jsonify({"error": reason}), 400
    if not db.delete_webauthn_credential(uid, credential_id):
        return jsonify({"error": "not found"}), 404
    _revoke_other_sessions(uid, reason="passkey")
    return jsonify({"ok": True})


@app.post("/api/auth/webauthn/login/options")
def api_webauthn_login_options():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if _auth_rate_limited("webauthn-login", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email)
    # Indistinguishable response for unknown / no-passkey accounts (M5).
    if not webauthn_mod.WEBAUTHN_AVAILABLE:
        return jsonify({"error": "webauthn not available on server"}), 501
    host_error = webauthn_mod.passkey_host_error()
    if host_error:
        return jsonify({"error": host_error}), 400
    creds = db.list_webauthn_credentials(int(user["id"])) if user else []
    try:
        if creds:
            options = webauthn_mod.authentication_options([dict(row) for row in creds])
        else:
            options = webauthn_mod.authentication_options_empty()
    except Exception as exc:
        return _generic_client_error("webauthn login options failed", exc, status=400)
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
        return _generic_client_error("webauthn login verify failed", exc, status=401)
    totp_required = bool(user["totp_enabled"])
    blocked = _login_user(int(user["id"]), totp_ok=not totp_required)
    if blocked:
        return blocked
    return jsonify(_login_payload(user, totp_required=totp_required))


@app.post("/api/auth/sign-in/methods")
def api_auth_sign_in_methods():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if _auth_rate_limited("sign-in-methods", email or auth.client_ip()):
        return jsonify({"error": "too many attempts"}), 429
    user = db.get_user_by_email(email) if email else None
    methods = (
        passkey_signin.sign_in_methods_for_user(user)
        if user
        else passkey_signin.sign_in_methods_unknown()
    )
    return jsonify({"ok": True, **methods})


@app.post("/api/auth/recovery-code")
def api_auth_recovery_code_login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    code = str(body.get("code") or "")
    if not email or not code:
        return jsonify({"error": "invalid credentials"}), 400
    if _auth_rate_limited("recovery-code-login", email):
        return jsonify({"error": "too many attempts"}), 429
    uid, status = passkey_signin.verify_recovery_login(email, code)
    if status == "not_ready":
        return jsonify({"error": "Recovery codes are not active yet"}), 403
    if not uid:
        return jsonify({"error": "invalid credentials"}), 401
    user = db.get_user_by_id(uid)
    if not user:
        return jsonify({"error": "invalid credentials"}), 401
    totp_required = bool(user["totp_enabled"])
    blocked = _login_user(int(uid), totp_ok=not totp_required)
    if blocked:
        return blocked
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
    pending_cap = auth.session_cap_pending()
    if not auth.verify_totp_for_current_user(code):
        return jsonify({"error": "invalid code"}), 401
    if pending_cap:
        blocked = _complete_session_cap_after_totp()
        if blocked:
            return blocked
    return jsonify({"ok": True})


def _account_unlock_user():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user and skip_login():
        user = db.get_first_user()
        if user:
            try:
                auth.login_user(
                    int(user["id"]), totp_ok=not bool(user["totp_enabled"])
                )
            except auth.SessionCapExceeded:
                return None
    if not user:
        return None
    if not auth.authenticated() or auth.current_user_id() != int(user["id"]):
        return None
    return user


@app.post("/api/account/unlock/challenge")
def api_account_unlock_challenge():
    """SRP step-1 for vault unlock. Binds to the stored verifier; does not rotate it."""
    user = _account_unlock_user()
    if not user:
        return jsonify({"error": "sign in required"}), 401
    if not db.user_has_srp(user):
        return jsonify({"error": "not applicable"}), 404
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("account-unlock", email):
        return jsonify({"error": "too many attempts"}), 429
    try:
        b_hex = _stored_srp_challenge(email, user, auth.SRP_PURPOSE_UNLOCK)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


@app.post("/api/account/unlock")
def api_account_unlock():
    """Prove the typed password. A live session cookie is not a password."""
    user = _account_unlock_user()
    if not user:
        return jsonify({"error": "sign in required"}), 401
    body = request.get_json(silent=True) or {}
    email = str(user["email"] or "").strip().lower()
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    current = str(body.get("current_password") or "")
    if _auth_rate_limited("account-unlock", email):
        return jsonify({"error": "too many attempts"}), 429
    if db.user_has_srp(user):
        if current and strict_zk():
            return jsonify({"error": "password must not be sent to the server"}), 400
        if not a_hex or not m1:
            return jsonify({"error": "missing srp proof"}), 401
        if not _verify_stored_srp_proof(email, user, a_hex, m1, auth.SRP_PURPOSE_UNLOCK):
            return jsonify({"error": "invalid credentials"}), 401
    elif db.user_has_legacy_password(user):
        if a_hex or m1:
            return jsonify({"error": "invalid credentials"}), 400
        if not current or not verify_password(user["password_hash"], current):
            return jsonify({"error": "invalid password"}), 401
    else:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify(_unlock_payload(user))


def _password_rotation_seconds() -> int:
    from auth import PASSWORD_ROTATION_SECONDS

    return int(PASSWORD_ROTATION_SECONDS)


@app.post("/api/account/password/challenge")
def api_account_password_challenge():
    """SRP step-1 for vault password change (session + CSRF; binds to stored verifier)."""
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("account-password", email):
        return jsonify({"error": "too many attempts"}), 429
    if not db.user_has_srp(user):
        return jsonify({"error": "not applicable"}), 404
    try:
        b_hex = _stored_srp_challenge(email, user, auth.SRP_PURPOSE_PASSWORD_CHANGE)
    except ValueError:
        return jsonify({"error": "invalid credentials"}), 401
    return jsonify({
        "srp_salt": str(user["srp_salt"]),
        "B": b_hex,
        "srp_kdf_version": db.user_srp_kdf_version(user),
    })


@app.post("/api/account/password/prove")
def api_account_password_prove():
    """Verify current login password (SRP proof or legacy hash) before vault re-key."""
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    body = request.get_json(silent=True) or {}
    current = str(body.get("current_password") or "").strip()
    account = str(body.get("account_password") or "").strip()
    align = bool(body.get("align_after_vault_rekey"))
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("account-password", email):
        return jsonify({"error": "too many attempts"}), 429

    if db.user_auth_method(user) == "srp":
        if current or account:
            return jsonify({"error": "password must not be sent to the server"}), 400
        if not a_hex or not m1:
            return jsonify({"error": "missing srp proof"}), 400
        if not _verify_stored_srp_proof(email, user, a_hex, m1, auth.SRP_PURPOSE_PASSWORD_CHANGE):
            return jsonify({"error": "invalid password"}), 401
    else:
        if a_hex or m1:
            return jsonify({"error": "invalid credentials"}), 400
        if len(current) < min_password_length() and not (align and account):
            return jsonify({"error": "invalid password"}), 401
        if not db.user_has_legacy_password(user):
            return jsonify({"error": "invalid password"}), 401
        login_ok = verify_password(user["password_hash"], current)
        if not login_ok and align and account:
            login_ok = verify_password(user["password_hash"], account)
        if not login_ok:
            return jsonify({"error": "invalid password"}), 401

    token = auth.issue_password_rotation_token(uid)
    return jsonify({
        "ok": True,
        "rotation_token": token,
        "expires_in": _password_rotation_seconds(),
    })


@app.post("/api/account/password")
def api_account_password():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if not auth.csrf_ok():
        return jsonify({"error": "invalid CSRF token"}), 400
    body = request.get_json(silent=True) or {}
    current = str(body.get("current_password") or "").strip()
    new = str(body.get("new_password") or "").strip()
    srp_salt = str(body.get("srp_salt") or "").strip().lower()
    srp_verifier = str(body.get("srp_verifier") or "").strip().lower()
    a_hex = str(body.get("A") or "").strip().lower()
    m1 = str(body.get("M1") or "").strip().lower()
    align = bool(body.get("align_after_vault_rekey"))
    account = str(body.get("account_password") or "").strip()
    rotation_token = str(body.get("rotation_token") or "").strip()
    email = str(user["email"] or "").strip().lower()
    if _auth_rate_limited("account-password", email):
        return jsonify({"error": "too many attempts"}), 429

    if not rotation_token or not auth.consume_password_rotation_token(uid, rotation_token):
        if a_hex and m1 and db.user_auth_method(user) == "srp":
            return jsonify({
                "error": "password rotation not committed — prove current password first",
            }), 400
        return jsonify({"error": "invalid or expired rotation token"}), 401

    srp_kdf_version = normalize_srp_kdf_version(body.get("srp_kdf_version") or SRP_KDF_V2)
    if srp_salt and srp_verifier and srp_kdf_version < SRP_KDF_V2:
        return jsonify({"error": "srp_kdf_version 2 required"}), 400
    if db.user_auth_method(user) == "srp":
        if current or new or account or a_hex or m1:
            return jsonify({"error": "password must not be sent to the server"}), 400
        if not srp_salt or not srp_verifier:
            return jsonify({"error": "missing srp verifier"}), 400
        changed_at = db.update_user_srp_verifier(
            uid, srp_salt, srp_verifier, srp_kdf_version=SRP_KDF_V2,
        )
        db.clear_user_legacy_password(uid)
        _revoke_other_sessions(uid, reason="password")
        return jsonify({"ok": True, "password_changed_at": changed_at, "auth_method": "srp"})

    if len(new) < 8:
        return jsonify({"error": "new password must be at least 8 characters"}), 400
    changed_at = db.update_user_password(uid, hash_password(new))
    if srp_salt and srp_verifier:
        db.upgrade_user_to_srp(uid, srp_salt, srp_verifier, srp_kdf_version=srp_kdf_version)
        if strict_zk():
            db.clear_user_legacy_password(uid)
    _revoke_other_sessions(uid, reason="password")
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


def _pcloud_path_for_client(user) -> str:
    """Leave the remote-folder field empty until pCloud is turned on.

    Older databases defaulted new rows to HomelabNotes/backups. That string,
    and the current Deeperguard/backups default, should stay a placeholder
    until the account actually enables pCloud.
    """
    path = str(user["pcloud_remote_path"] or "").strip()
    if not user["pcloud_enabled"] and path in {"", "HomelabNotes/backups", "Deeperguard/backups"}:
        return ""
    return path


@app.get("/api/boot-account")
def api_boot_account():
    """Account payload for the shell, or a quiet signed-out marker."""
    if not auth.authenticated():
        return jsonify({"signed_out": True})
    return api_account()


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
            "email_verified": email_verify.account_verified(user),
            "email_verify_retry_after": (
                0
                if email_verify.account_verified(user)
                else verification_cooldown_remaining(uid, str(user["email"] or ""))
            ),
            "backup_recipient_verified": email_verify.recipient_verified(
                user, user["backup_email"] or user["email"]
            ),
            "backup_verify_retry_after": (
                0
                if email_verify.recipient_verified(user, user["backup_email"] or user["email"])
                else verification_cooldown_remaining(uid, str(user["backup_email"] or user["email"] or ""))
            ),
            "pcloud_enabled": bool(user["pcloud_enabled"]),
            "pcloud_username": user["pcloud_username"] or "",
            "pcloud_remote_path": _pcloud_path_for_client(user),
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
            "passkey_signin": passkey_signin.public_status(user),
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
    body = request.get_json(silent=True) or {}
    code = str(body.get("code") or "")
    if user["totp_enabled"]:
        if not code:
            return jsonify({"error": "current 2FA code required"}), 403
        ok, step = totp_mod.verify_and_step(
            str(user["totp_secret"]), code, last_step=db.user_totp_last_step(user),
        )
        if not ok:
            return jsonify({"error": "invalid code"}), 400
        if step:
            db.set_user_totp_last_step(uid, step)
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
    ok, step = totp_mod.verify_and_step(
        str(user["totp_secret"]), code, last_step=db.user_totp_last_step(user),
    )
    if not ok:
        return jsonify({"error": "invalid code"}), 400
    if step:
        db.set_user_totp_last_step(uid, step)
    db.update_user_totp(uid, str(user["totp_secret"]), enabled=True)
    # Already signed in on this device — never block re-login on the session soft-cap.
    blocked = _login_user(uid, totp_ok=True, check_cap=False)
    if blocked:
        return blocked
    _revoke_other_sessions(uid, reason="totp")
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
    # Round 73: SRP accounts prove with the session + TOTP code only — ignore password.
    if db.user_auth_method(user) != "srp":
        if not verify_password(user["password_hash"], password):
            return jsonify({"error": "invalid password"}), 401
    if user["totp_enabled"]:
        if not code:
            return jsonify({"error": "current 2FA code required"}), 403
        ok, step = totp_mod.verify_and_step(
            str(user["totp_secret"]), code, last_step=db.user_totp_last_step(user),
        )
        if not ok:
            return jsonify({"error": "invalid code"}), 400
        if step:
            db.set_user_totp_last_step(uid, step)
    db.update_user_totp(uid, "", enabled=False)
    # Already signed in on this device — never block re-login on the session soft-cap.
    blocked = _login_user(uid, totp_ok=True, check_cap=False)
    if blocked:
        return blocked
    _revoke_other_sessions(uid, reason="totp")
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
    verified = email_verify.recipient_verified(user, email) if user else False
    previous = str((user["backup_email"] if user else "") or "").strip().lower()
    account_email = str((user["email"] if user else "") or "").strip().lower()
    if email != previous and not (email == account_email and email_verify.account_verified(user)):
        verified = False
    db.update_backup_settings(uid, email, enabled, backup_email_verified=1 if verified else 0)
    if user and email and not verified:
        try:
            if email == account_email:
                email_verify.send_account_code(db.get_user_by_id(uid))
            else:
                fresh = db.get_user_by_id(uid)
                email_verify.send_backup_code(fresh, email)
        except VerificationSendLimited as exc:
            return jsonify({"error": exc.message}), 429
    return jsonify({
        "ok": True,
        "email": email,
        "enabled": enabled,
        "verified": verified,
        "email_verified": email_verify.account_verified(db.get_user_by_id(uid)),
    })


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
    if not email_verify.recipient_verified(user, recipient):
        try:
            # strict=True so a second click within the cooldown returns 429
            # instead of silently skipping and still claiming "We sent a code".
            if recipient == str(user["email"] or "").strip().lower():
                email_verify.send_account_code(user, strict=True)
            else:
                email_verify.send_backup_code(user, recipient, strict=True)
        except VerificationSendLimited as exc:
            wait = int(getattr(exc, "retry_after", 0) or 0)
            msg = (
                f"Code already sent — resend in {wait}s"
                if wait > 0
                else (exc.message or "Please wait before requesting another code")
            )
            limited = VerificationSendLimited(msg, retry_after=wait or None, code=getattr(exc, "code", "") or "cooldown")
            return _verification_limited_response(limited)
        return jsonify({
            "error": "Verify this email before backups can be sent. We sent a code.",
            "code": "email_unverified",
        }), 403
    if not check_backup_attachment_send(uid):
        return jsonify({"error": backup_attachment_cap_message()}), 429
    try:
        meta = send_user_backup(uid, recipient)
    except Exception as exc:
        db.log_backup(uid, recipient, 0, 0, "error", str(exc))
        log.exception("backup email failed")
        return jsonify({"error": "email failed"}), 502
    record_backup_attachment_send(uid, recipient)
    return jsonify(
        {
            "ok": True,
            "bytes": meta["bytes_size"],
            "items": meta["item_count"],
            "compact": bool(meta.get("compact")),
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
        log.warning("pcloud settings rejected: %s", exc)
        return jsonify({"error": "invalid pCloud settings"}), 400
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
        return _generic_client_error("pCloud sync failed", exc, status=502)
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
            return _generic_client_error("ocr sync failed", exc, status=400)
        except Exception as exc:
            return _generic_client_error("ocr sync processing failed", exc, status=500)
        stored = ocr_index.save_document(uid, att_id, filename, mime, data, result)
        if ocr_ephemeral() and att_id:
            ocr_index.delete_document(uid, att_id)
        return jsonify({"ok": True, **result, "att_id": stored.get("att_id") or ""})
    try:
        job_id = ocr_jobs.submit(uid, filename, mime, data, att_id)
    except RuntimeError as exc:
        return _generic_client_error("ocr job submit failed", exc, status=503)
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
        return _generic_client_error("media preview failed", exc, status=400)
    except Exception as exc:
        return _generic_client_error("media preview processing failed", exc, status=500)
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
        return _generic_client_error("media prepare failed", exc, status=400)
    except Exception as exc:
        return _generic_client_error("media prepare processing failed", exc, status=500)
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


@app.get("/api/sync/item/<item_uuid>")
def api_sync_item(item_uuid):
    """Read-only raw server row for one owned item (View server copy).

    Returns the same fields sync pull/refetch expose. Never logs ciphertext.
    """
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "not found"}), 404
    uuid = str(item_uuid or "").strip()
    if not uuid or len(uuid) > 80:
        return jsonify({"error": "not found"}), 404
    include_blobs = str(request.args.get("include_blobs", "1")).strip().lower() not in {
        "0", "false", "no",
    }
    items = db.list_items_by_uuid(uid, [uuid], include_blobs=include_blobs)
    if not items:
        return jsonify({"error": "not found"}), 404
    return jsonify({"item": items[0], "server_time": time.time()})


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
    # Current clients send partial=1 and read per-item statuses from a 200.
    # Older clients treat any non-2xx as "nothing saved", so for them a quota
    # hit still answers 413 (the acceptable items are written either way).
    partial = str(body.get("partial", "0")).strip().lower() in {"1", "true", "yes"}
    results = db.upsert_items_batch(uid, valid_items)
    accepted = sum(1 for row in results if row.get("status") == "ok")
    unchanged = sum(1 for row in results if row.get("status") == "unchanged")
    stale = sum(1 for row in results if row.get("status") == "stale")
    conflicts = sum(1 for row in results if row.get("status") == "conflict")
    quota_hits = sum(1 for row in results if row.get("status") == "quota_exceeded")
    too_large = sum(1 for row in results if row.get("status") == "too_large")
    body_bytes = int(request.content_length or 0)
    line = (
        f"sync push user={uid} items={len(raw_items)} accepted={accepted} "
        f"unchanged={unchanged} stale={stale} conflict={conflicts} quota={quota_hits} "
        f"too_large={too_large} bytes={body_bytes} partial={int(partial)} "
        f"ms={int((time.time() - started) * 1000)}"
    )
    _sync_log_line(line)
    quota_bytes = 0
    if quota_hits:
        user = db.get_user_by_id(uid)
        quota_bytes = db.user_storage_quota_bytes(user) if user else 0
        if not partial:
            return jsonify({
                "error": "storage quota exceeded",
                "quota_bytes": quota_bytes,
                "results": results,
            }), 413
    response = {
        "ok": True,
        "accepted": accepted,
        "unchanged": unchanged,
        "stale": stale,
        "conflicts": conflicts,
        "quota_exceeded": quota_hits,
        "too_large": too_large,
        "results": results,
        "server_time": time.time(),
    }
    if quota_hits:
        response["quota_bytes"] = quota_bytes
    return jsonify(response)


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
    free = PLAN_CATALOG[PLAN_FREE]
    basic = PLAN_CATALOG[PLAN_BASIC]
    pro = PLAN_CATALOG[PLAN_PRO]
    free_features = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_FREE in feat["plans"]]
    basic_features = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_BASIC in feat["plans"]]
    pro_features = [feat["label"] for key, feat in FEATURE_CATALOG.items() if PLAN_PRO in feat["plans"]]
    pro_only = [
        feat["label"]
        for key, feat in FEATURE_CATALOG.items()
        if PLAN_PRO in feat["plans"] and PLAN_BASIC not in feat["plans"] and PLAN_FREE not in feat["plans"]
    ]
    entry = app_entry_path()
    base = NOTES_PUBLIC_URL.rstrip("/")
    promo = _promo_payload()
    return {
        "build": NOTES_BUILD,
        "client_hash": NOTES_CLIENT_HASH or client_assets.client_hash(),
        "client_hash_short": client_assets.client_hash_short(),
        "release_tag": client_assets.release_tag(),
        "release_url": client_assets.release_url(),
        "release_signed": client_assets.release_is_signed(),
        "site_url": f"{base}/",
        "canonical_url": f"{base}/",
        "og_image": f"{base}/static/icons/icon-512.png?v={NOTES_BUILD}",
        "json_ld": promo["structured_data"],
        "app_url": f"{base}{entry}",
        "app_path": entry,
        "register_url": f"{base}/register",
        "login_url": f"{base}/login",
        "free": free,
        "basic": basic,
        "pro": pro,
        "free_features": free_features,
        "basic_features": basic_features,
        "pro_features": pro_features,
        "pro_only_features": pro_only,
        "features": FEATURE_CATALOG,
        "plan_free": PLAN_FREE,
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
    from config import cidr_gate_enabled

    from config import DROPBOX_APP_KEY, GOOGLE_OAUTH_CLIENT_ID

    return render_template(
        "app.html",
        csrf_token="",
        skip_login=skip_login(),
        build=NOTES_BUILD,
        self_host=cidr_gate_enabled(),
        google_oauth_client_id=GOOGLE_OAUTH_CLIENT_ID,
        dropbox_app_key=DROPBOX_APP_KEY,
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


@app.post("/api/account/email/verify")
def api_account_email_verify():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if _auth_rate_limited("email-verify", str(user["email"])):
        return jsonify({"error": "too many attempts"}), 429
    body = request.get_json(silent=True) or {}
    if not email_verify.check_code(uid, "account", str(body.get("code") or "")):
        return jsonify({"error": "That code is wrong or expired."}), 400
    return jsonify({"ok": True, "email_verified": True})


def _verification_sent_response(user, recipient: str | None = None):
    """Successful explicit resend. retry_after is the server cooldown the button should show."""
    target = str(recipient or (user["email"] if user else "") or "").strip().lower()
    uid = int(user["id"]) if user else 0
    wait = verification_retry_after(uid, target) if uid and target else 60
    return jsonify({"ok": True, "sent": True, "retry_after": wait})


def _verification_limited_response(exc: VerificationSendLimited):
    payload = {"error": exc.message}
    code = getattr(exc, "code", "") or ""
    if code:
        payload["code"] = code
    retry_after = getattr(exc, "retry_after", None)
    if retry_after:
        seconds = max(1, int(retry_after))
        payload["retry_after"] = seconds
    response = jsonify(payload)
    response.status_code = 429
    if retry_after:
        response.headers["Retry-After"] = str(max(1, int(retry_after)))
    return response


@app.post("/api/account/email/resend")
def api_account_email_resend():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    if email_verify.account_verified(user):
        return jsonify({"ok": True, "email_verified": True})
    if _auth_rate_limited("email-verify-resend", str(user["email"])):
        return jsonify({"error": "too many attempts"}), 429
    try:
        email_verify.send_account_code(user, strict=True)
    except VerificationSendLimited as exc:
        return _verification_limited_response(exc)
    return _verification_sent_response(user)


@app.post("/api/backup/email/verify")
def api_backup_email_verify():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    recipient = str(user["backup_email"] or user["email"]).strip().lower()
    if _auth_rate_limited("backup-verify", recipient):
        return jsonify({"error": "too many attempts"}), 429
    body = request.get_json(silent=True) or {}
    if not email_verify.check_code(uid, "backup", str(body.get("code") or "")):
        return jsonify({"error": "That code is wrong or expired."}), 400
    return jsonify({"ok": True, "backup_recipient_verified": True})


@app.post("/api/backup/email/resend")
def api_backup_email_resend():
    uid = auth.current_user_id()
    user = db.get_user_by_id(uid) if uid else None
    if not user:
        return jsonify({"error": "not found"}), 404
    recipient = str(user["backup_email"] or user["email"]).strip().lower()
    if email_verify.recipient_verified(user, recipient):
        return jsonify({"ok": True, "verified": True})
    if _auth_rate_limited("backup-verify-resend", recipient):
        return jsonify({"error": "too many attempts"}), 429
    try:
        if recipient == str(user["email"]).strip().lower():
            email_verify.send_account_code(user, strict=True)
        else:
            email_verify.send_backup_code(user, recipient, strict=True)
    except VerificationSendLimited as exc:
        return _verification_limited_response(exc)
    return _verification_sent_response(user, recipient)


# --- D2 Secure Send -----------------------------------------------------------------

@app.post("/api/secure-send")
def api_secure_send_create():
    """Authenticated: store opaque ciphertext blob + length; key stays in the fragment."""
    import secure_send as ss
    from plans import (
        plan_secure_send_daily_limit,
        secure_send_daily_cap_message,
        secure_send_over_daily_limit,
        utc_day_start_timestamp,
    )

    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    user = db.get_user_by_id(int(uid))
    plan = db.user_plan(user) if user else None
    daily_limit = plan_secure_send_daily_limit(plan)
    if daily_limit is not None:
        creates_today = db.count_secure_sends_for_user_since(int(uid), utc_day_start_timestamp())
        if secure_send_over_daily_limit(plan, creates_today):
            return jsonify(
                {
                    "error": secure_send_daily_cap_message(plan),
                    "code": "secure_send_daily_cap",
                }
            ), 429
    ip = auth.client_ip()
    # Separate buckets: per IP and per sender (Dennis D2 rate-limit rule).
    if not auth_rate_allow(f"secure-send-create-ip:{ip}", limit=20, window=3600.0):
        return jsonify({"error": "rate limited"}), 429
    if not auth_rate_allow(f"secure-send-create-user:{uid}", limit=30, window=3600.0):
        return jsonify({"error": "rate limited"}), 429
    body = request.get_json(silent=True) or {}
    # Reject key material and any plaintext file metadata (name/MIME/size belong inside ciphertext).
    for forbidden in (
        "key",
        "fragment",
        "passphrase",
        "password",
        "wrapping_key",
        "content_key",
        "filename",
        "file_name",
        "mime",
        "content_type",
        "file_size",
    ):
        if forbidden in body:
            return jsonify({"error": "invalid payload"}), 400
    ciphertext = body.get("ciphertext")
    if not isinstance(ciphertext, dict) or not ciphertext.get("iv") or not ciphertext.get("data"):
        return jsonify({"error": "ciphertext required"}), 400
    # Ignore client has_file / has_passphrase / byte_size hints — server stores opaque blob length only.
    expires_in = ss.clamp_expires_in(body.get("expires_in", ss.DEFAULT_EXPIRES_SECONDS))
    max_views = ss.clamp_max_views(body.get("max_views", ss.DEFAULT_MAX_VIEWS))
    open_verifier = str(body.get("open_verifier") or "").strip()
    if open_verifier and not ss.valid_open_verifier(open_verifier):
        return jsonify({"error": "invalid payload"}), 400
    db.prune_secure_sends()
    send_id = ss.new_send_id()
    try:
        written = ss.write_ciphertext(send_id, ciphertext)
    except ValueError:
        return jsonify({"error": "too large"}), 413
    except OSError:
        log.exception("secure-send write failed")
        return jsonify({"error": "store failed"}), 500
    expires_at = time.time() + expires_in
    db.create_secure_send(
        send_id,
        int(uid),
        ciphertext_len=written,
        max_views=max_views,
        expires_at=expires_at,
        open_verifier=open_verifier,
    )
    return jsonify(
        {
            "ok": True,
            "id": send_id,
            "expires_at": expires_at,
            "max_views": max_views,
            "ciphertext_len": written,
            "receive_path": f"/receive/{send_id}",
        }
    )


@app.get("/api/secure-send/sent")
def api_secure_send_list():
    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    db.prune_secure_sends()
    return jsonify({"items": db.list_secure_sends_for_user(int(uid))})


@app.post("/api/secure-send/<send_id>/cancel")
def api_secure_send_cancel(send_id: str):
    import secure_send as ss

    uid = auth.current_user_id()
    if not uid:
        return jsonify({"error": "login required"}), 401
    if not ss.valid_id(send_id):
        return jsonify({"error": "not found"}), 404
    if not db.cancel_secure_send(send_id, int(uid)):
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True, "message": ss.LINK_STOPPED})


@app.post("/api/secure-send/<send_id>/open")
def api_secure_send_open(send_id: str):
    """Consume one view and return opaque ciphertext. Preview bots must not call this.

    Passphrase links require ``open_verifier`` (HMAC of contentKey) before a view
    is counted — wrong guesses return 401 with attempts_left.
    """
    import secure_send as ss

    if not ss.valid_id(send_id):
        return jsonify({"error": "not found"}), 404
    ip = auth.client_ip()
    if not auth_rate_allow(f"secure-send-open-ip:{ip}", limit=60, window=300.0):
        return jsonify({"error": "rate limited"}), 429
    row = db.get_secure_send(send_id)
    if row is not None:
        sender_id = int(row["sender_user_id"])
        if not auth_rate_allow(f"secure-send-open-sender:{sender_id}", limit=120, window=300.0):
            return jsonify({"error": "rate limited"}), 429
    body = request.get_json(silent=True) or {}
    for forbidden in (
        "key",
        "fragment",
        "passphrase",
        "password",
        "wrapping_key",
        "content_key",
        "filename",
        "file_name",
        "mime",
    ):
        if forbidden in body:
            return jsonify({"error": "invalid payload"}), 400
    open_verifier = str(body.get("open_verifier") or body.get("verifier") or "").strip()
    result = db.open_secure_send(send_id, open_verifier=open_verifier)
    if not result:
        return jsonify({"error": "not found"}), 404
    if result.get("error") == "wrong_passphrase":
        return jsonify({
            "error": "wrong_passphrase",
            "message": "Wrong passphrase",
            "attempts_left": int(result.get("attempts_left") or 0),
        }), 401
    if result.get("error") == "stopped":
        return jsonify({"error": "not found"}), 404
    resp = jsonify(
        {
            "ok": True,
            "ciphertext": result["ciphertext"],
            "views_remaining": result["views_remaining"],
        }
    )
    # Never attach a real filename — downloads are assembled client-side after decrypt.
    resp.headers["Content-Disposition"] = "inline"
    return resp


def _receive_page_response(
    send_id: str,
    *,
    stopped: bool,
    views_remaining: int | None = None,
):
    import secure_send as ss

    remaining = int(views_remaining) if views_remaining is not None else 0
    ctx = {
        "build": NOTES_BUILD,
        "client_hash": client_assets.client_hash(),
        "release_tag": client_assets.release_tag(),
        "csp_nonce": auth.csp_nonce(),
        "send_id": send_id,
        "link_stopped_copy": ss.LINK_STOPPED_FRIENDLY,
        "link_stopped": stopped,
        "views_remaining": remaining,
        "receive_intro": ss.receive_opens_intro(remaining) if not stopped else "",
    }
    resp = make_response(render_template("receive.html", **ctx), 200 if not stopped else 404)
    resp.headers["Content-Disposition"] = "inline"
    return resp


@app.route("/receive/<send_id>", methods=["GET", "HEAD"])
def receive_secure_send(send_id: str):
    """Receive shell only — does NOT count a view or download ciphertext.

    Inactive links keep HTTP 404 but render the same friendly stopped copy
    (no enumeration of expired vs opened vs revoked vs locked out).
    Active pages include remaining opens in the boot JSON (still no view burn).
    """
    import secure_send as ss

    if not ss.valid_id(send_id):
        return _receive_page_response(send_id, stopped=True)
    row = db.get_secure_send(send_id)
    ts = time.time()
    if not row:
        return _receive_page_response(send_id, stopped=True)
    has_blob = ss.blob_path(send_id).is_file()
    try:
        locked_out = float(row["locked_out_at"]) if row["locked_out_at"] else None
    except (KeyError, IndexError, TypeError, ValueError):
        locked_out = None
    status = ss.status_label(
        canceled_at=float(row["canceled_at"]) if row["canceled_at"] else None,
        expires_at=float(row["expires_at"]),
        views_used=int(row["views_used"]),
        max_views=int(row["max_views"]),
        has_blob=has_blob,
        now_ts=ts,
        locked_out_at=locked_out,
    )
    if status != "active":
        if status == "expired":
            ss.purge_ciphertext(send_id)
        return _receive_page_response(send_id, stopped=True)
    remaining = max(0, int(row["max_views"]) - int(row["views_used"]))
    if request.method == "HEAD":
        resp = make_response(("", 200))
        resp.headers["Content-Disposition"] = "inline"
        return resp
    return _receive_page_response(send_id, stopped=False, views_remaining=remaining)


@app.get("/contact")
def contact_page():
    return render_template("contact.html", **_marketing_context())


@app.get("/download")
def download_page():
    return render_template("download.html", **_marketing_context())


@app.get("/verify")
def verify_page():
    """Public guide: inspect login/sync traffic and confirm zero-knowledge claims."""
    ctx = {**_marketing_context(), **verify_metadata_baseline.template_context()}
    return render_template("verify.html", **ctx)


def _render_blog_page(template: str, canonical_path: str, **extra):
    host = _request_host()
    if request.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        return render_template("https-setup.html", host=_lan_https_host(), build=NOTES_BUILD)
    ctx = {**_marketing_context(), **extra}
    base = NOTES_PUBLIC_URL.rstrip("/")
    ctx["canonical_url"] = f"{base}{canonical_path}"
    return make_response(render_template(template, **ctx))


@app.get("/blog")
def blog_index_page():
    posts = blog.published_posts()
    return _render_blog_page(
        "blog-index.html",
        "/blog",
        posts=posts,
        show_drafts=blog.show_drafts(),
    )


@app.get("/blog/feed.xml")
def blog_feed():
    site = NOTES_PUBLIC_URL.rstrip("/")
    body = blog.rss_xml(site, blog.listed_posts())
    return app.response_class(body, mimetype="application/rss+xml; charset=utf-8")


@app.get("/blog/<slug>")
def blog_post_page(slug: str):
    post = blog.get_published_post(slug)
    if not post:
        return render_template("not-found.html", **_marketing_context()), 404
    og = f"{NOTES_PUBLIC_URL.rstrip('/')}{post.cover_image or '/static/icons/icon-512.png'}"
    if post.cover_image and "?v=" not in post.cover_image:
        og = f"{og}?v={NOTES_BUILD}"
    return _render_blog_page(
        "blog-post.html",
        f"/blog/{post.slug}",
        post=post,
        og_image=og,
        show_drafts=blog.show_drafts(),
    )


@app.get("/pricing")
def pricing_page():
    # Canonical content lives on the homepage pricing section.
    return redirect("/#pricing", code=302)


def _render_marketing_page(template: str, canonical_path: str):
    host = _request_host()
    if request.scheme != "https" and host not in {"localhost", "127.0.0.1", "::1"}:
        return render_template("https-setup.html", host=_lan_https_host(), build=NOTES_BUILD)
    ctx = _marketing_context()
    ctx["canonical_url"] = f"{NOTES_PUBLIC_URL.rstrip('/')}{canonical_path}"
    return make_response(render_template(template, **ctx))


@app.get("/compare/standard-notes")
def compare_standard_notes_page():
    return _render_marketing_page("compare-standard-notes.html", "/compare/standard-notes")


@app.get("/compare/notesnook")
def compare_notesnook_page():
    return _render_marketing_page("compare-notesnook.html", "/compare/notesnook")


@app.get("/compare/joplin")
def compare_joplin_page():
    return _render_marketing_page("compare-joplin.html", "/compare/joplin")


@app.get("/evernote-alternative")
def evernote_alternative_page():
    return _render_marketing_page("evernote-alternative.html", "/evernote-alternative")


@app.get("/for/freelancers")
def for_freelancers_page():
    return _render_marketing_page("for-freelancers.html", "/for/freelancers")


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
        "/compare/notesnook",
        "/compare/joplin",
        "/evernote-alternative",
        "/for/freelancers",
        entry,
        "/register",
        "/login",
        "/privacy",
        "/terms",
        "/contact",
        "/download",
        "/self-host",
        "/help/recovery",
        "/verify",
        "/blog",
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
    for post in blog.listed_posts():
        lines.append("  <url>")
        lines.append(f"    <loc>{site}/blog/{post.slug}</loc>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return app.response_class("\n".join(lines), mimetype="application/xml; charset=utf-8")


if INDEXNOW_KEY:

    @app.get(f"/{INDEXNOW_KEY}.txt")
    def indexnow_key_file():
        return app.response_class(INDEXNOW_KEY, mimetype="text/plain; charset=utf-8")


@app.get("/ca.crt")
def ca_certificate():
    # Off by default on public www; enable NOTES_SERVE_CA_CRT=1 for LAN TLS hosts (L6).
    if not serve_ca_crt():
        return ("Not found", 404)
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


@app.get("/favicon.ico")
def favicon():
    """Browsers request /favicon.ico even when a PNG icon link is present."""
    response = send_from_directory(
        Path(app.static_folder) / "icons",
        "favicon-32.png",
        mimetype="image/png",
    )
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


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
    # Origin wants revalidate-every-load; Cloudflare may still rewrite (L5).
    response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
    return response


# Initialize DB on import for gunicorn workers.
log_server_ocr_startup_warning()
log_wan_secure_cookies_startup_warning()
log_turnstile_startup_warning()
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
