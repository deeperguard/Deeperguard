"""pCloud OAuth connect flow: authorize URL, code exchange, token storage, revoke.

The access token is stored in the database only as AES-256-GCM ciphertext
(``pcloud_credentials.encrypt_at_rest``); the key comes from the environment
(NOTES_PCLOUD_CREDENTIALS_KEY). Token, code and client secret are never logged.

pCloud has no scope parameter on the authorize URL: whether the token is limited
to the app folder is decided by the "Folder access" setting of the registered
pCloud app, not by this code.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

import pcloud_credentials as pc

log = logging.getLogger("deeperguard.pcloud.oauth")

ENV_CLIENT_ID = "NOTES_PCLOUD_OAUTH_CLIENT_ID"
ENV_CLIENT_SECRET = "NOTES_PCLOUD_OAUTH_CLIENT_SECRET"
AUTHORIZE_URL = "https://my.pcloud.com/oauth2/authorize"
CALLBACK_PATH = "/api/backup/pcloud/oauth/callback"
# The callback names the API host of the user's region. Only these are ever contacted.
API_BASE_URLS = {
    "api.pcloud.com": "https://api.pcloud.com",
    "eapi.pcloud.com": "https://eapi.pcloud.com",
}
STATE_TTL_SECONDS = 600
HTTP_TIMEOUT_SECONDS = 15


class PcloudOAuthError(Exception):
    """Carries a fixed category only, so it is safe to log and to return."""


def client_id() -> str:
    return os.environ.get(ENV_CLIENT_ID, "").strip()


def client_secret() -> str:
    return os.environ.get(ENV_CLIENT_SECRET, "").strip()


def configured() -> bool:
    if not client_id() or not client_secret():
        return False
    try:
        return pc.credentials_encryption_key() is not None
    except ValueError:
        return False


def redirect_uri() -> str:
    from config import NOTES_PUBLIC_URL

    return NOTES_PUBLIC_URL.rstrip("/") + CALLBACK_PATH


def new_state() -> dict:
    return {"value": secrets.token_urlsafe(32), "exp": time.time() + STATE_TTL_SECONDS}


def state_matches(saved, supplied: str) -> bool:
    if not isinstance(saved, dict) or not supplied:
        return False
    expected = str(saved.get("value") or "")
    try:
        expires = float(saved.get("exp") or 0)
    except (TypeError, ValueError):
        return False
    if not expected or expires < time.time():
        return False
    return hmac.compare_digest(expected.encode("utf-8"), str(supplied).encode("utf-8"))


def authorize_url(state: str) -> str:
    query = urllib.parse.urlencode(
        {
            "client_id": client_id(),
            "response_type": "code",
            "redirect_uri": redirect_uri(),
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _api_post(api_host: str, method: str, params: dict, *, bearer: str = "") -> dict:
    """POST form parameters so no secret ends up in a URL. Errors carry no upstream text."""
    base = API_BASE_URLS.get(api_host)
    if not base:
        raise PcloudOAuthError("unknown_host")
    req = urllib.request.Request(
        f"{base}/{method}",
        data=urllib.parse.urlencode(params).encode("ascii"),
        method="POST",
    )
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as res:  # noqa: S310 - allowlisted host
            payload = json.loads(res.read(65536).decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise PcloudOAuthError("unreachable") from None
    if not isinstance(payload, dict):
        raise PcloudOAuthError("bad_response")
    return payload


def exchange_code(code: str, api_host: str) -> str:
    payload = _api_post(
        api_host,
        "oauth2_token",
        {"client_id": client_id(), "client_secret": client_secret(), "code": code},
    )
    token = payload.get("access_token")
    if payload.get("result") != 0 or not isinstance(token, str) or not token:
        raise PcloudOAuthError("exchange_rejected")
    return token


def revoke_token(token: str, api_host: str) -> bool:
    """Ask pCloud to invalidate the token (``logout``). False when that could not be confirmed."""
    try:
        payload = _api_post(api_host, "logout", {}, bearer=token)
    except PcloudOAuthError:
        return False
    return payload.get("result") == 0 and bool(payload.get("auth_deleted"))


def store_token(user_id: int, token: str, api_host: str) -> None:
    import db

    if api_host not in API_BASE_URLS:
        raise PcloudOAuthError("unknown_host")
    db.set_pcloud_oauth_token(int(user_id), pc.encrypt_at_rest(token), api_host)


def stored_token(user_id: int) -> str:
    """Decrypted token, or '' when there is none or it cannot be decrypted with the env key."""
    import db

    row = db.get_pcloud_oauth_token(int(user_id))
    if not row:
        return ""
    stored = str(row["token_enc"] or "")
    if not pc.stored_token_is_encrypted(stored):
        return ""
    try:
        return pc.decrypt_at_rest(stored)
    except Exception:
        return ""


def status(user_id: int) -> str:
    """'connected', 'reconnect' (a token is stored but unusable) or 'not_connected'."""
    import db

    if not db.get_pcloud_oauth_token(int(user_id)):
        return "not_connected"
    return "connected" if stored_token(user_id) else "reconnect"


def disconnect(user_id: int) -> bool:
    """Delete the stored token; revoke it at pCloud first when it is still readable.

    Returns True only when pCloud confirmed the revocation.
    """
    import db

    row = db.get_pcloud_oauth_token(int(user_id))
    if not row:
        return False
    token = stored_token(user_id)
    revoked = revoke_token(token, str(row["api_host"])) if token else False
    db.delete_pcloud_oauth_token(int(user_id))
    log.info("pCloud OAuth disconnected user_id=%s revoked=%s", int(user_id), revoked)
    return revoked
