"""Email verification codes for account sign-up and backup recipients."""
from __future__ import annotations

import hashlib
import logging
import secrets
import time

import db
import mailer

log = logging.getLogger("deeperguard.email_verify")

CODE_TTL_SECONDS = 30 * 60
MAX_ATTEMPTS = 8


def _hash(user_id: int, purpose: str, code: str) -> str:
    return hashlib.sha256(f"{int(user_id)}:{purpose}:{code}".encode("utf-8")).hexdigest()


def _row_has(row, key: str) -> bool:
    if isinstance(row, dict):
        return key in row
    try:
        return key in row.keys()
    except Exception:
        return False


def _flag(row, key: str, default: int = 1) -> int:
    if row is None or not _row_has(row, key):
        return default
    try:
        return int(row[key] or 0)
    except (TypeError, ValueError):
        return default


def issue_code(user_id: int, purpose: str) -> str:
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = time.time() + CODE_TTL_SECONDS
    digest = _hash(user_id, purpose, code)
    if purpose == "backup":
        db.set_backup_verification(user_id, digest, expires)
    else:
        db.set_email_verification(user_id, digest, expires)
    return code


def check_code(user_id: int, purpose: str, code: str) -> bool:
    user = db.get_user_by_id(user_id)
    if not user:
        return False
    digits = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(digits) != 6:
        return False
    if purpose == "backup":
        attempts = _flag(user, "backup_verify_attempts", 0)
        expires = float(user["backup_verify_expires"] or 0) if _row_has(user, "backup_verify_expires") else 0
        stored = str(user["backup_verify_hash"] or "") if _row_has(user, "backup_verify_hash") else ""
    else:
        attempts = _flag(user, "email_verify_attempts", 0)
        expires = float(user["email_verify_expires"] or 0) if _row_has(user, "email_verify_expires") else 0
        stored = str(user["email_verify_hash"] or "") if _row_has(user, "email_verify_hash") else ""
    if not stored or attempts >= MAX_ATTEMPTS or time.time() > expires:
        return False
    if _hash(user_id, purpose, digits) != stored:
        if purpose == "backup":
            db.bump_backup_verify_attempts(user_id)
        else:
            db.bump_email_verify_attempts(user_id)
        return False
    if purpose == "backup":
        db.mark_backup_email_verified(user_id)
    else:
        db.mark_email_verified(user_id)
    return True


def account_verified(user) -> bool:
    return _flag(user, "email_verified", 1) == 1


def recipient_verified(user, recipient: str) -> bool:
    """True when this address may receive an encrypted backup."""
    if user is None:
        return False
    target = str(recipient or "").strip().lower()
    account = str(user["email"] or "").strip().lower() if _row_has(user, "email") else ""
    if not target:
        return False
    if target == account:
        return account_verified(user)
    stored = str(user["backup_email"] or "").strip().lower() if _row_has(user, "backup_email") else ""
    if target != stored:
        return False
    if not _row_has(user, "backup_email_verified"):
        return True
    return _flag(user, "backup_email_verified", 0) == 1


def _send(recipient: str, subject: str, body: str) -> None:
    try:
        mailer.send_plain_email(recipient, subject, body)
    except Exception as exc:
        log.warning("verification email failed recipient=%s: %s", recipient, exc)


def send_account_code(user) -> str:
    code = issue_code(int(user["id"]), "account")
    email = str(user["email"] or "").strip().lower()
    _send(
        email,
        "Verify your Deeperguard email",
        "\n".join([
            "Enter this code in Deeperguard to verify your email address.",
            "",
            code,
            "",
            "The code expires in 30 minutes. Encrypted backups are not sent to this address until it is verified.",
            "",
            "If you did not create a Deeperguard account, you can ignore this message.",
        ]),
    )
    return code


def send_backup_code(user, recipient: str) -> str:
    code = issue_code(int(user["id"]), "backup")
    target = str(recipient or "").strip().lower()
    _send(
        target,
        "Verify your Deeperguard backup email",
        "\n".join([
            "Enter this code in Deeperguard Settings to receive encrypted vault backups at this address.",
            "",
            code,
            "",
            "The code expires in 30 minutes. Backups are not sent until you confirm the code.",
        ]),
    )
    return code
