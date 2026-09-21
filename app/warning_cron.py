"""Send due note time-warning emails."""
from __future__ import annotations

import fcntl
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
from config import DATA_DIR, NOTES_PUBLIC_URL  # noqa: E402
from mailer import send_plain_email  # noqa: E402

log = logging.getLogger("deeperguard.warnings")


def note_link(item_uuid: str) -> str:
    return f"{NOTES_PUBLIC_URL.rstrip('/')}/?note={item_uuid}"


EMAIL_SUBJECT = "Deeperguard: time warning"


def _local_zone():
    """Zone used to render the reminder time in the email (NOTES_EMAIL_TZ, default Europe/Amsterdam)."""
    name = (os.environ.get("NOTES_EMAIL_TZ") or "Europe/Amsterdam").strip()
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def format_warn_time(warn_at: float) -> str:
    at = datetime.fromtimestamp(float(warn_at), tz=timezone.utc)
    local = at.astimezone(_local_zone())
    local_text = local.strftime("%A %d %B %Y, %H:%M %Z")
    if local.utcoffset() == at.utcoffset():
        return local_text
    return f"{local_text} ({at.strftime('%H:%M UTC')})"


def warning_email_body(warn_at: float, item_uuid: str) -> str:
    # Zero-knowledge: the server never sees the title or body, so the email only
    # carries the time and a link that opens the note after unlock.
    return (
        "A time warning you set on one of your notes is due.\n\n"
        f"When: {format_warn_time(warn_at)}\n\n"
        f"Open the note: {note_link(item_uuid)}\n\n"
        "Sign in and unlock your vault to read it. The note title and contents are\n"
        "encrypted end-to-end, so they cannot be included in this email.\n"
    )


def _lock_path() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / "warning-cron.lock"


def _run_claimed(now_ts: float) -> int:
    sent = 0
    for row in db.claim_due_reminders(now_ts):
        rid = int(row["id"])
        uid = int(row["user_id"])
        user = db.get_user_by_id(uid)
        if not user:
            db.mark_reminder_sent(rid, now_ts)
            continue
        recipient = str(user["backup_email"] or user["email"])
        if db.item_is_deleted(uid, row["item_uuid"]):
            db.mark_reminder_sent(rid, now_ts)
            db.log_reminder(uid, row["item_uuid"], recipient, "skipped", "note deleted")
            log.info("skip deleted note user=%s uuid=%s", user["email"], row["item_uuid"])
            continue
        try:
            send_plain_email(
                recipient,
                EMAIL_SUBJECT,
                warning_email_body(float(row["warn_at"]), row["item_uuid"]),
            )
            db.mark_reminder_sent(rid, now_ts, warn_at=float(row["warn_at"]))
            db.log_reminder(uid, row["item_uuid"], recipient, "ok")
            sent += 1
        except Exception as exc:
            db.release_reminder_claim(rid)
            db.log_reminder(uid, row["item_uuid"], recipient, "error", str(exc))
            log.error("warning failed user=%s uuid=%s: %s", user["email"], row["item_uuid"], exc)
    db.prune_reminder_log()
    return sent


def run_warnings(now_ts: float | None = None) -> int:
    when = float(now_ts if now_ts is not None else time.time())
    lock_path = _lock_path()
    with open(lock_path, "a+", encoding="utf-8") as lockf:
        try:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.info("warning cron already running")
            return 0
        try:
            return _run_claimed(when)
        finally:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    count = run_warnings()
    print(f"sent {count} note warning(s)")
