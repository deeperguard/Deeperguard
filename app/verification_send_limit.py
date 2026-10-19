"""SQLite-backed limits for outbound verification and backup emails."""
from __future__ import annotations

import os
import time

import db

KIND_VERIFY = "verify_code"
KIND_BACKUP_ATTACHMENT = "backup_attachment"

_COOLDOWN_SECONDS = 60
_DAILY_CAP = 5
_BACKUP_ATTACHMENT_DAILY_CAP = 12


class VerificationSendLimited(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _cooldown_seconds() -> float:
    try:
        return max(1.0, float(os.environ.get("NOTES_VERIFY_SEND_COOLDOWN", str(_COOLDOWN_SECONDS))))
    except (TypeError, ValueError):
        return float(_COOLDOWN_SECONDS)


def _daily_cap() -> int:
    try:
        return max(1, int(os.environ.get("NOTES_VERIFY_SEND_DAILY_CAP", str(_DAILY_CAP))))
    except (TypeError, ValueError):
        return _DAILY_CAP


def _backup_attachment_daily_cap() -> int:
    try:
        return max(
            1,
            int(os.environ.get("NOTES_BACKUP_EMAIL_DAILY_CAP", str(_BACKUP_ATTACHMENT_DAILY_CAP))),
        )
    except (TypeError, ValueError):
        return _BACKUP_ATTACHMENT_DAILY_CAP


def _day_window() -> float:
    return 86400.0


def daily_cap_message() -> str:
    return (
        "Too many verification emails sent today. "
        "Try again tomorrow or use the code already emailed."
    )


def backup_attachment_cap_message() -> str:
    return "Too many encrypted backup emails sent today. Try again tomorrow."


def check_verification_send(user_id: int, recipient: str) -> str:
    """Return 'send', 'skip' (cooldown), or 'blocked' (daily cap)."""
    target = str(recipient or "").strip().lower()
    if not target:
        return "send"
    now = time.time()
    since = now - _day_window()
    last = db.last_email_send(user_id, target, KIND_VERIFY)
    if last and now - last < _cooldown_seconds():
        return "skip"
    cap = _daily_cap()
    if db.count_email_sends_for_user(user_id, KIND_VERIFY, since) >= cap:
        return "blocked"
    if db.count_email_sends_for_recipient(target, KIND_VERIFY, since) >= cap:
        return "blocked"
    return "send"


def record_verification_send(user_id: int, recipient: str) -> None:
    db.log_email_send(int(user_id), str(recipient or "").strip().lower(), KIND_VERIFY)


def assert_verification_send_allowed(user_id: int, recipient: str) -> str:
    """Raise VerificationSendLimited on cap; return 'send' or 'skip'."""
    status = check_verification_send(user_id, recipient)
    if status == "blocked":
        raise VerificationSendLimited(daily_cap_message())
    return status


def check_backup_attachment_send(user_id: int) -> bool:
    since = time.time() - _day_window()
    return db.count_email_sends_for_user(int(user_id), KIND_BACKUP_ATTACHMENT, since) < _backup_attachment_daily_cap()


def record_backup_attachment_send(user_id: int, recipient: str) -> None:
    db.log_email_send(
        int(user_id),
        str(recipient or "").strip().lower(),
        KIND_BACKUP_ATTACHMENT,
    )
