"""Passkey-only account sign-in: recovery codes and password-login toggle."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import Any

import db
from config import ensure_flask_secret

RECOVERY_CODE_COUNT = 10
WAIT_FLOOR_SECONDS = 72 * 3600
WAIT_CHOICES_SECONDS = (
    WAIT_FLOOR_SECONDS,
    7 * 24 * 3600,
    14 * 24 * 3600,
)

_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_CODE_SEGMENT = 4
_CODE_SEGMENTS = 3
_CODE_RE = re.compile(
    r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$"
)


def _pepper() -> bytes:
    return ensure_flask_secret().encode("utf-8")


def _normalize_code(raw: str) -> str:
    cleaned = str(raw or "").strip().upper().replace(" ", "")
    if len(cleaned) == _CODE_SEGMENT * _CODE_SEGMENTS and "-" not in cleaned:
        cleaned = "-".join(
            cleaned[i : i + _CODE_SEGMENT] for i in range(0, len(cleaned), _CODE_SEGMENT)
        )
    return cleaned


def _hash_code(user_id: int, batch_id: int, code: str) -> str:
    msg = f"{int(user_id)}:recovery:{int(batch_id)}:{code}"
    return hmac.new(_pepper(), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def _generate_code() -> str:
    parts = []
    for _ in range(_CODE_SEGMENTS):
        segment = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_SEGMENT))
        parts.append(segment)
    return "-".join(parts)


def normalize_wait_seconds(wait_seconds: int | float | None) -> int:
    try:
        value = int(wait_seconds or 0)
    except (TypeError, ValueError):
        value = WAIT_FLOOR_SECONDS
    return max(WAIT_FLOOR_SECONDS, value)


def passkey_count(user_id: int) -> int:
    return len(db.list_webauthn_credentials(int(user_id)))


def password_login_disabled(user) -> bool:
    try:
        return int(user["password_login_disabled"] or 0) == 1
    except (KeyError, TypeError, ValueError):
        return False


def recovery_batch_row(user_id: int):
    return db.get_latest_recovery_batch(int(user_id))


def _batch_state(batch, now: float) -> str:
    if not batch:
        return "none"
    if float(batch["cancelled_at"] or 0) > 0:
        return "cancelled"
    activates = float(batch["activates_at"] or 0)
    if activates > now:
        return "pending"
    return "active"


def recovery_login_ready(user_id: int, *, now: float | None = None) -> bool:
    ts = float(now if now is not None else time.time())
    batch = recovery_batch_row(user_id)
    return _batch_state(batch, ts) == "active"


def has_issued_recovery(user_id: int) -> bool:
    batch = recovery_batch_row(user_id)
    if not batch:
        return False
    return float(batch["cancelled_at"] or 0) <= 0


def can_disable_password_login(user_id: int) -> tuple[bool, str]:
    if passkey_count(user_id) < 2:
        return False, "Register at least two passkeys first."
    if not has_issued_recovery(user_id):
        return False, "Generate recovery codes first (they can be pending during the wait)."
    return True, ""


def passkey_removal_allowed(user_id: int) -> tuple[bool, str]:
    if not db.user_password_login_disabled_by_id(int(user_id)):
        return True, ""
    if passkey_count(user_id) - 1 < 2:
        return False, "Passkey-only sign-in needs at least two passkeys. Re-enable password sign-in or add another passkey first."
    return True, ""


def sign_in_methods_for_user(user) -> dict[str, bool]:
    uid = int(user["id"])
    creds = db.list_webauthn_credentials(uid)
    now = time.time()
    return {
        "password": not password_login_disabled(user),
        "passkey": len(creds) > 0,
        "recovery": recovery_login_ready(uid, now=now),
    }


def sign_in_methods_unknown() -> dict[str, bool]:
    return {"password": True, "passkey": False, "recovery": False}


def public_status(user) -> dict[str, Any]:
    uid = int(user["id"])
    now = time.time()
    batch = recovery_batch_row(uid)
    state = _batch_state(batch, now)
    if state == "cancelled":
        state = "none"
    can_disable, disable_reason = can_disable_password_login(uid)
    return {
        "passkey_count": passkey_count(uid),
        "password_login_disabled": password_login_disabled(user),
        "recovery": {
            "state": state,
            "activates_at": float(batch["activates_at"] or 0) if batch and state != "none" else 0,
            "wait_seconds": int(batch["wait_seconds"] or 0) if batch and state != "none" else 0,
            "can_cancel": state == "pending",
            "issued": has_issued_recovery(uid),
        },
        "can_disable_password_login": can_disable,
        "disable_password_login_reason": disable_reason if not can_disable else "",
        "wait_floor_seconds": WAIT_FLOOR_SECONDS,
        "wait_choices_seconds": list(WAIT_CHOICES_SECONDS),
    }


def issue_recovery_codes(user_id: int, wait_seconds: int) -> dict[str, Any]:
    wait = normalize_wait_seconds(wait_seconds)
    now = time.time()
    activates_at = now + wait
    db.cancel_all_recovery_batches(int(user_id), cancelled_at=now)
    batch_id = db.create_recovery_batch(int(user_id), now, activates_at, wait)
    plain_codes = []
    hashes = []
    for _ in range(RECOVERY_CODE_COUNT):
        code = _generate_code()
        plain_codes.append(code)
        hashes.append(_hash_code(int(user_id), batch_id, code))
    db.insert_recovery_code_hashes(int(user_id), batch_id, hashes)
    if db.user_password_login_disabled_by_id(int(user_id)) and not has_issued_recovery(int(user_id)):
        db.set_password_login_disabled(int(user_id), False)
    return {
        "codes": plain_codes,
        "activates_at": activates_at,
        "wait_seconds": wait,
        "state": "pending",
    }


def cancel_pending_recovery(user_id: int) -> bool:
    batch = recovery_batch_row(user_id)
    now = time.time()
    if not batch or _batch_state(batch, now) != "pending":
        return False
    db.cancel_recovery_batch(int(batch["id"]), now)
    if db.user_password_login_disabled_by_id(int(user_id)):
        if passkey_count(int(user_id)) < 2 or not has_issued_recovery(int(user_id)):
            db.set_password_login_disabled(int(user_id), False)
    return True


def set_password_login_disabled(user_id: int, disabled: bool) -> tuple[bool, str]:
    if disabled:
        ok, reason = can_disable_password_login(int(user_id))
        if not ok:
            return False, reason
    db.set_password_login_disabled(int(user_id), bool(disabled))
    return True, ""


def verify_recovery_login(email: str, code: str) -> tuple[int | None, str]:
    user = db.get_user_by_email(email)
    if not user:
        return None, "invalid"
    uid = int(user["id"])
    now = time.time()
    batch = recovery_batch_row(uid)
    if _batch_state(batch, now) != "active":
        return None, "not_ready"
    normalized = _normalize_code(code)
    if not _CODE_RE.match(normalized):
        return None, "invalid"
    digest = _hash_code(uid, int(batch["id"]), normalized)
    if not db.consume_recovery_code(int(batch["id"]), uid, digest, used_at=now):
        return None, "invalid"
    return uid, "ok"
