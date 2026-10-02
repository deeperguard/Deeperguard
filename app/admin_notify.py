"""Email admins when a new account is created."""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from mailer import send_plain_email

log = logging.getLogger("deeperguard.admin_notify")

DEFAULT_SIGNUP_NOTIFY_RECIPIENTS = ("dennisschutten@protonmail.com",)


def admin_notification_recipients() -> list[str]:
    raw = os.environ.get("NOTES_SIGNUP_NOTIFY_EMAILS", "").strip()
    if raw:
        return [part.strip() for part in raw.split(",") if part.strip()]
    return list(DEFAULT_SIGNUP_NOTIFY_RECIPIENTS)


def _signup_notify_subject(email: str) -> str:
    return f"Deeperguard: new user subscribed — {email}"


def _signup_notify_body(email: str, created_at: float) -> str:
    when = datetime.fromtimestamp(created_at, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return (
        "A new user subscribed on Deeperguard.\n\n"
        f"Email: {email}\n"
        f"Time: {when}\n"
    )


def notify_new_user_signup(email: str, created_at: float | None = None) -> None:
    """Tell configured recipients about a new account. Never raises."""
    recipients = admin_notification_recipients()
    if not recipients:
        return
    when = float(created_at if created_at is not None else time.time())
    subject = _signup_notify_subject(email)
    body = _signup_notify_body(email, when)
    for recipient in recipients:
        try:
            send_plain_email(recipient, subject, body)
        except Exception as exc:
            log.error(
                "signup notify email not sent recipient=%s new_user=%s: %s",
                recipient,
                email,
                exc,
            )
