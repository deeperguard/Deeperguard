"""Send encrypted backup attachments via LAN SMTP relay."""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage

from config import SMTP_FROM, SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_USER, smtp_password


def smtp_timeout_sec() -> float:
    """Socket timeout for every SMTP step (NOTES_SMTP_TIMEOUT_SEC, default 20 s).

    Kept short so a hanging mail server cannot hold the cron flock for long.
    """
    try:
        value = float(os.environ.get("NOTES_SMTP_TIMEOUT_SEC", "20"))
    except (TypeError, ValueError):
        return 20.0
    return value if value > 0 else 20.0


def _send_message(msg: EmailMessage) -> None:
    if SMTP_TLS:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=smtp_timeout_sec()) as smtp:
            smtp.starttls(context=context)
            if SMTP_USER:
                smtp.login(SMTP_USER, smtp_password())
            smtp.send_message(msg)
        return

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=smtp_timeout_sec()) as smtp:
        if SMTP_USER:
            smtp.login(SMTP_USER, smtp_password())
        smtp.send_message(msg)


def send_plain_email(recipient: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["Sender"] = SMTP_FROM
    msg["To"] = recipient
    msg.set_content(body)
    _send_message(msg)


def send_contact_email(
    recipient: str,
    *,
    sender_email: str,
    sender_name: str,
    subject: str,
    body: str,
) -> None:
    """Deliver a website contact form message; Reply-To points at the visitor."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["Sender"] = SMTP_FROM
    msg["To"] = recipient
    if sender_name:
        msg["Reply-To"] = f"{sender_name} <{sender_email}>"
    else:
        msg["Reply-To"] = sender_email
    msg.set_content(body)
    _send_message(msg)


def send_backup_email(
    recipient: str,
    subject: str,
    body: str,
    attachment_name: str,
    attachment_bytes: bytes,
    *,
    html_body: str | None = None,
) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["Sender"] = SMTP_FROM
    msg["To"] = recipient
    msg.set_content(body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")
    msg.add_attachment(
        attachment_bytes,
        maintype="application",
        subtype="octet-stream",
        filename=attachment_name,
    )
    _send_message(msg)
