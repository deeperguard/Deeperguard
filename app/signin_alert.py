"""Best-effort new-device sign-in email alerts (Round 78).

Never blocks or slows sign-in. No links in the email body. Country comes only
from Cloudflare's CF-IPCountry header (else Unknown). Browser/OS comes only
from server-side User-Agent parsing — never a client-reported device name.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from flask import has_request_context, request

from db import claim_signin_alert, get_user_by_id, normalize_device_id
from mailer import send_plain_email

log = logging.getLogger("deeperguard.signin_alert")

THROTTLE_SECONDS = 24 * 60 * 60
_AMSTERDAM = ZoneInfo("Europe/Amsterdam")


def request_country() -> str:
    """Country the server sees via Cloudflare, else Unknown. Never the full IP."""
    if not has_request_context():
        return "Unknown"
    country = str(request.headers.get("CF-IPCountry") or "").strip().upper()
    if country in {"", "XX", "T1"}:
        return "Unknown"
    # Cloudflare uses two-letter ISO codes; reject anything else.
    if len(country) != 2 or not country.isalpha():
        return "Unknown"
    return country


def device_key(*, device_id: str = "", ip: str = "", device_label: str = "") -> str:
    """Stable throttle key matching session reuse identity."""
    did = normalize_device_id(device_id)
    if did:
        return f"d:{did}"
    ip_part = str(ip or "").strip()[:80]
    label = str(device_label or "").strip()[:80]
    if ip_part and label:
        return f"f:{ip_part}|{label}"
    if label:
        return f"l:{label}"
    return ""


def format_signin_times(when: float | None = None) -> tuple[str, str]:
    ts = float(when if when is not None else time.time())
    utc_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    ams_dt = utc_dt.astimezone(_AMSTERDAM)
    utc_s = utc_dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    ams_s = ams_dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    return utc_s, ams_s


def build_signin_alert_body(
    *,
    when: float | None = None,
    country: str = "Unknown",
    browser_os: str = "",
) -> str:
    utc_s, ams_s = format_signin_times(when)
    loc = str(country or "Unknown").strip() or "Unknown"
    agent = str(browser_os or "").strip() or "Unknown"
    return (
        "New sign-in to your Deeperguard account\n"
        "\n"
        f"Time (UTC): {utc_s}\n"
        f"Time (Europe/Amsterdam): {ams_s}\n"
        f"Approximate location: {loc}\n"
        f"Browser / OS: {agent}\n"
        "\n"
        "Wasn't you? Open deeperguard.com yourself (type it in your browser) "
        "and go to Settings > Devices to sign that device out, then change your password.\n"
    )


def _deliver(user_id: int, subject: str, body: str) -> None:
    user = get_user_by_id(int(user_id))
    if not user:
        return
    recipient = str(user["email"] or "").strip()
    if not recipient:
        return
    try:
        send_plain_email(recipient, subject, body)
    except Exception as exc:
        # Never log the address.
        log.error("signin alert email not sent user_id=%s: %s", int(user_id), exc)


def send_signin_alert(
    user_id: int,
    *,
    device_key_value: str,
    country: str,
    browser_os: str,
    when: float | None = None,
    async_send: bool = True,
) -> bool:
    """Claim throttle slot and send. Returns True if a send was scheduled/attempted."""
    key = str(device_key_value or "").strip()
    if not key:
        return False
    try:
        if not claim_signin_alert(int(user_id), key, window_seconds=THROTTLE_SECONDS):
            return False
    except Exception as exc:
        log.error("signin alert throttle failed user_id=%s: %s", int(user_id), exc)
        return False
    subject = "Deeperguard: new sign-in to your account"
    body = build_signin_alert_body(when=when, country=country, browser_os=browser_os)
    if async_send:
        threading.Thread(
            target=_deliver,
            args=(int(user_id), subject, body),
            name="signin-alert",
            daemon=True,
        ).start()
        return True
    _deliver(int(user_id), subject, body)
    return True


def maybe_alert_after_login(
    user_id: int,
    *,
    was_known_device: bool,
    device_id: str = "",
    ip: str = "",
    device_label: str = "",
    country: str = "Unknown",
    when: float | None = None,
    async_send: bool = True,
) -> bool:
    """Hook after a successful sign-in. Never raises."""
    try:
        if was_known_device:
            return False
        key = device_key(device_id=device_id, ip=ip, device_label=device_label)
        if not key:
            return False
        return send_signin_alert(
            int(user_id),
            device_key_value=key,
            country=country,
            browser_os=str(device_label or "").strip(),
            when=when,
            async_send=async_send,
        )
    except Exception as exc:
        log.error("signin alert hook failed user_id=%s: %s", int(user_id), exc)
        return False

