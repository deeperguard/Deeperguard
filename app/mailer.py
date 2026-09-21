"""Send encrypted backup attachments via LAN SMTP relay."""
from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage

from config import SMTP_FROM, SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_USER, smtp_password


def _send_message(msg: EmailMessage) -> None:
    if SMTP_TLS:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=120) as smtp:
            smtp.starttls(context=context)
            if SMTP_USER:
                smtp.login(SMTP_USER, smtp_password())
            smtp.send_message(msg)
        return

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=120) as smtp:
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
) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["Sender"] = SMTP_FROM
    msg["To"] = recipient
    msg.set_content(body)
    msg.add_attachment(
        attachment_bytes,
        maintype="application",
        subtype="octet-stream",
        filename=attachment_name,
    )
    _send_message(msg)
