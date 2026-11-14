"""Deliver due agenda reminders (email; push when VAPID configured).

Delivery rules:
- A reminder more than MAX_LATE_SEC overdue is closed without sending: "you have an
  event coming up soon" is wrong hours later.
- Email text is generic: no event time (see agenda_email_body).
- A reminder that cannot be delivered at all (push not configured, no subscription,
  unverified address) is closed at once, so it can never sit at the head of the queue
  and hold back other accounts.
- Reminders of an account whose plan no longer includes them are deleted, not sent.
- A transient failure is released and retried on the next run until it becomes overdue.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import email_verify  # noqa: E402
from mailer import send_plain_email  # noqa: E402
from plans import plan_has  # noqa: E402

log = logging.getLogger("deeperguard.agenda_reminders")

EMAIL_SUBJECT = "Deeperguard: upcoming event"
UNSUB_HINT = "Turn off agenda email reminders in Deeperguard → Calendar settings."
DEFAULT_MAX_LATE_SEC = 30 * 60.0

# Push services browsers actually hand out. The endpoint is user-supplied, so the server
# only ever posts to these hosts.
PUSH_ENDPOINT_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
PUSH_ENDPOINT_HOST_SUFFIXES = (".notify.windows.com", ".push.apple.com", ".push.services.mozilla.com")


def max_late_sec() -> float:
    try:
        return max(60.0, float(os.environ.get("NOTES_AGENDA_REMINDER_MAX_LATE_SEC", DEFAULT_MAX_LATE_SEC)))
    except (TypeError, ValueError):
        return DEFAULT_MAX_LATE_SEC


def push_configured() -> bool:
    return bool(
        os.environ.get("NOTES_VAPID_PUBLIC_KEY", "").strip()
        and os.environ.get("NOTES_VAPID_PRIVATE_KEY", "").strip()
    )


def push_endpoint_allowed(endpoint: str) -> bool:
    try:
        parts = urlsplit(str(endpoint or "").strip())
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    if parts.port not in (None, 443):
        return False
    host = (parts.hostname or "").lower()
    return host in PUSH_ENDPOINT_HOSTS or any(host.endswith(sfx) for sfx in PUSH_ENDPOINT_HOST_SUFFIXES)


def agenda_reminder_line(local_time_label: str) -> str:
    label = str(local_time_label or "").strip()
    if db.AGENDA_REMINDER_LABEL_RE.match(label):
        return f"You have an event at {label}."
    return "You have an upcoming event."


EMAIL_REMINDER_LINE = "You have an event coming up soon."


def agenda_email_body(local_time_label: str = "") -> str:
    """Generic text only: no event time, title or date. Any stored label is ignored.

    The mail relay and the recipient's mail provider read and keep this text, so it says
    nothing beyond "a reminder arrived around now" (docs/design/calendar-multi.md §5.2).
    """
    return (
        f"{EMAIL_REMINDER_LINE}\n\n"
        "Open Deeperguard to see what it is. Event details are encrypted on your device.\n"
        "This reminder can arrive up to 15 minutes early.\n\n"
        f"{UNSUB_HINT}\n"
    )


def try_send_push(user_id: int, title: str, body: str, reminder_id: str) -> str:
    """Return "sent", "retry" (transient failure) or "drop" (cannot be delivered)."""
    if not push_configured():
        log.info("drop push user=%s reminder=%s (VAPID not configured)", user_id, reminder_id)
        return "drop"
    try:
        from pywebpush import webpush, WebPushException  # type: ignore
    except ImportError:
        log.warning("pywebpush not installed; cannot send push")
        return "drop"
    subs = db.list_web_push_subscriptions(user_id)
    if not subs:
        return "drop"
    payload = json.dumps({
        "title": title,
        "body": body,
        "url": "/app",
        "reminder_id": reminder_id,
    })
    sent = False
    transient = False
    for row in subs:
        endpoint = str(row.get("endpoint") or "")
        try:
            info = json.loads(row["subscription_json"])
            if not push_endpoint_allowed(endpoint) or info.get("endpoint") != endpoint:
                db.delete_web_push_subscription(user_id, endpoint)
                continue
            webpush(
                subscription_info=info,
                data=payload,
                vapid_private_key=os.environ.get("NOTES_VAPID_PRIVATE_KEY", "").strip(),
                vapid_claims={"sub": "mailto:notes@deeperguard.com"},
            )
            sent = True
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                db.delete_web_push_subscription(user_id, endpoint)
            else:
                transient = True
            log.error("push failed user=%s status=%s", user_id, status)
        except Exception as exc:
            transient = True
            log.error("push error user=%s: %s", user_id, type(exc).__name__)
    if sent:
        return "sent"
    return "retry" if transient else "drop"


def run_agenda_reminders(now_ts: float | None = None) -> int:
    when = float(now_ts if now_ts is not None else time.time())
    expired = db.expire_overdue_agenda_reminders(when - max_late_sec(), when)
    if expired:
        log.info("closed %s overdue agenda reminder(s) without sending", expired)
    db.prune_sent_agenda_reminders(when)
    delivered = 0
    for row in db.claim_due_agenda_reminders(when):
        uid = int(row["user_id"])
        rid = str(row["id"])
        user = db.get_user_by_id(uid)
        if not user:
            db.mark_agenda_reminder_sent(uid, rid, when)
            continue
        if not plan_has(db.user_plan(user), "agenda_reminders"):
            # Plan changed without going through update_user_plan: drop everything still queued.
            dropped = db.delete_pending_agenda_reminders(uid)
            log.info("drop %s agenda reminder(s) user=%s (plan has no reminders)", dropped, uid)
            continue
        channel = str(row["channel"])
        label = str(row.get("local_time_label") or "")
        try:
            if channel == "email":
                recipient = str(user["email"] or "").strip()
                if not recipient or not email_verify.account_verified(user):
                    log.info("drop email reminder user=%s id=%s (no verified address)", uid, rid)
                    db.mark_agenda_reminder_sent(uid, rid, when)
                    continue
                send_plain_email(recipient, EMAIL_SUBJECT, agenda_email_body(label))
                db.mark_agenda_reminder_sent(uid, rid, when)
                delivered += 1
            elif channel == "push":
                outcome = try_send_push(uid, "Deeperguard", agenda_reminder_line(label), rid)
                if outcome == "sent":
                    db.mark_agenda_reminder_sent(uid, rid, when)
                    delivered += 1
                elif outcome == "drop":
                    db.mark_agenda_reminder_sent(uid, rid, when)
                else:
                    db.release_agenda_reminder_claim(uid, rid)
            else:
                db.mark_agenda_reminder_sent(uid, rid, when)
        except Exception as exc:
            log.error("agenda reminder deliver failed user=%s id=%s: %s", uid, rid, type(exc).__name__)
            db.release_agenda_reminder_claim(uid, rid)
    return delivered


def run_push_windows(now_ts: float | None = None) -> int:
    """Send an empty push for each due window, then delete the row (no sent flag is kept).

    The push has no payload or topic: the service worker shows its own text. A window more
    than max_late_sec() overdue is deleted unsent.
    """
    when = float(now_ts if now_ts is not None else time.time())
    delivered = 0
    for row in db.due_push_windows(when):
        uid, rid, endpoint = int(row["user_id"]), str(row["id"]), str(row["endpoint"])
        user = db.get_user_by_id(uid)
        late = when - float(row["window_start"]) > max_late_sec()
        if not user or late or not plan_has(db.user_plan(user), "agenda_reminders"):
            db.delete_push_windows(uid, [rid])
            continue
        outcome = "drop"
        try:
            from pywebpush import webpush, WebPushException  # type: ignore

            info = json.loads(row["subscription_json"])
            if push_configured() and push_endpoint_allowed(endpoint) and info.get("endpoint") == endpoint:
                try:
                    webpush(
                        subscription_info=info,
                        data=None,
                        vapid_private_key=os.environ.get("NOTES_VAPID_PRIVATE_KEY", "").strip(),
                        vapid_claims={"sub": "mailto:notes@deeperguard.com"},
                    )
                    outcome = "sent"
                except WebPushException as exc:
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if status in (404, 410):
                        db.delete_web_push_subscription(uid, endpoint)
                    else:
                        outcome = "retry"
                    log.error("push window failed user=%s status=%s", uid, status)
        except Exception as exc:
            outcome = "retry"
            log.error("push window error user=%s: %s", uid, type(exc).__name__)
        if outcome == "retry":
            continue  # transient: keep the row until it becomes overdue
        db.delete_push_windows(uid, [rid])
        if outcome == "sent":
            delivered += 1
    return delivered


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(f"delivered {run_agenda_reminders()} agenda reminder(s)")
    print(f"delivered {run_push_windows()} push window reminder(s)")
