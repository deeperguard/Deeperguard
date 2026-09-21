"""Optional WebAuthn passkey support for account login."""
from __future__ import annotations

import base64
import json
import secrets
from typing import Any

from flask import request, session

import config

try:
    from webauthn import (
        generate_authentication_options,
        generate_registration_options,
        verify_authentication_response,
        verify_registration_response,
    )
    from webauthn.helpers import bytes_to_base64url, base64url_to_bytes, options_to_json_dict
    from webauthn.helpers.structs import (
        AuthenticatorSelectionCriteria,
        PublicKeyCredentialDescriptor,
        ResidentKeyRequirement,
        UserVerificationRequirement,
    )

    WEBAUTHN_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    WEBAUTHN_AVAILABLE = False

SESSION_WEBAUTHN_REG = "webauthn_reg"
SESSION_WEBAUTHN_AUTH = "webauthn_auth"


def _request_host() -> str:
    return config.normalize_host(request.host or "")


def _rp_id() -> str:
    return config.webauthn_rp_id(_request_host())


def _rp_origin() -> str:
    scheme = "https" if request.is_secure else "http"
    host = _request_host()
    if not host:
        return f"{scheme}://localhost"
    if request.host and ":" in request.host:
        _, port = request.host.split(":", 1)
        if port and port not in ("80", "443"):
            return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def passkey_host_error() -> str | None:
    """Return a user-facing error when the browser host cannot use passkeys."""
    host = _request_host()
    if config.passkey_host_ok(host):
        return None
    preferred = config.webauthn_preferred_host()
    if config.is_ip_host(host):
        return (
            f"Passkeys require a hostname, not an IP address. Add a DNS record for "
            f"{preferred} → this server, then open https://{preferred}/"
        )
    return (
        f"Passkeys are not available on {host or 'this address'}. "
        f"Open https://{preferred}/ instead."
    )


def registration_options(user_id: int, email: str, existing_ids: list[str]) -> dict[str, Any]:
    if not WEBAUTHN_AVAILABLE:
        raise RuntimeError("webauthn package not installed")
    exclude = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(cid))
        for cid in existing_ids
        if cid
    ]
    options = generate_registration_options(
        rp_id=_rp_id(),
        rp_name="Deeperguard",
        user_id=str(user_id).encode("utf-8"),
        user_name=email,
        user_display_name=email,
        exclude_credentials=exclude,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    session[SESSION_WEBAUTHN_REG] = bytes_to_base64url(options.challenge)
    return options_to_json_dict(options)


def verify_registration(credential: dict[str, Any], email: str) -> dict[str, Any]:
    if not WEBAUTHN_AVAILABLE:
        raise RuntimeError("webauthn package not installed")
    challenge = session.pop(SESSION_WEBAUTHN_REG, None)
    if not challenge:
        raise ValueError("registration expired")
    verification = verify_registration_response(
        credential=credential,
        expected_challenge=base64url_to_bytes(challenge),
        expected_rp_id=_rp_id(),
        expected_origin=_rp_origin(),
    )
    return {
        "credential_id": bytes_to_base64url(verification.credential_id),
        "public_key": bytes_to_base64url(verification.credential_public_key),
        "sign_count": int(verification.sign_count),
    }


def authentication_options(credentials: list[dict[str, Any]]) -> dict[str, Any]:
    if not WEBAUTHN_AVAILABLE:
        raise RuntimeError("webauthn package not installed")
    allow = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(str(row["credential_id"])))
        for row in credentials
        if row.get("credential_id")
    ]
    options = generate_authentication_options(
        rp_id=_rp_id(),
        allow_credentials=allow,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    session[SESSION_WEBAUTHN_AUTH] = bytes_to_base64url(options.challenge)
    return options_to_json_dict(options)


def verify_authentication(credential: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    if not WEBAUTHN_AVAILABLE:
        raise RuntimeError("webauthn package not installed")
    challenge = session.pop(SESSION_WEBAUTHN_AUTH, None)
    if not challenge:
        raise ValueError("authentication expired")
    verification = verify_authentication_response(
        credential=credential,
        expected_challenge=base64url_to_bytes(challenge),
        expected_rp_id=_rp_id(),
        expected_origin=_rp_origin(),
        credential_public_key=base64url_to_bytes(str(stored["public_key"])),
        credential_current_sign_count=int(stored.get("sign_count") or 0),
    )
    return {
        "credential_id": str(stored["credential_id"]),
        "sign_count": int(verification.new_sign_count),
    }


def random_challenge_token() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
