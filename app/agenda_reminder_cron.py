"""Deliver due agenda reminders (email; push when VAPID configured)."""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
from mailer import send_plain_email  # noqa: E402

log = logging.getLogger("deeperguard.agenda_reminders")

EMAIL_SUBJECT = "Deeperguard: upcoming event"
UNSUB_HINT = "Turn off agenda email reminders in Deeperguard → Calendar settings."


def agenda_email_body(local_time_label: str) -> str:
    label = str(local_time_label or "").strip()
    if label:
        line = f"You have an event at {label}."
    else:
        line = "You have an upcoming event."
    return (
        f"{line}\n\n"
        "Open Deeperguard to view your calendar. Event details are encrypted on your device.\n\n"
        f"{UNSUB_HINT}\n"
    )


def try_send_push(user_id: int, title: str, body: str, reminder_id: str) -> bool:
    pub = os.environ.get("NOTES_VAPID_PUBLIC_KEY", "").strip()
    priv = os.environ.get("NOTES_VAPID_PRIVATE_KEY", "").strip()
    if not pub or not priv:
        log.info("skip push user=%s reminder=%s (VAPID not configured)", user_id, reminder_id)
        return False
    try:
        from pywebpush import webpush, WebPushException  # type: ignore
    except ImportError:
        log.warning("pywebpush not installed; cannot send push")
        return False
    subs = db.list_web_push_subscriptions(user_id)
    if not subs:
        return False
    payload = json.dumps({
        "title": title,
        "body": body,
        "url": "/app",
        "reminder_id": reminder_id,
    })
    sent = False
    for row in subs:
        try:
            info = json.loads(row["subscription_json"])
            webpush(
                subscription_info=info,
                data=payload,
                vapid_private_key=priv,
                vapid_claims={"sub": "mailto:notes@deeperguard.com"},
            )
            sent = True
        except WebPushException as exc:
            log.error("push failed user=%s: %s", user_id, exc)
        except Exception as exc:
            log.error("push error user=%s: %s", user_id, exc)
    return sent


def run_agenda_reminders(now_ts: float | None = None) -> int:
    when = float(now_ts if now_ts is not None else time.time())
    delivered = 0
    for row in db.claim_due_agenda_reminders(when):
        uid = int(row["user_id"])
        rid = str(row["id"])
        user = db.get_user_by_id(uid)
        if not user:
            db.mark_agenda_reminder_sent(uid, rid, when)
            continue
        channel = str(row["channel"])
        label = str(row.get("local_time_label") or "")
        body = agenda_email_body(label)
        title = "Deeperguard"
        try:
            if channel == "email":
                recipient = str(user["email"] or "").strip()
                if not recipient:
                    db.mark_agenda_reminder_sent(uid, rid, when)
                    continue
                send_plain_email(recipient, EMAIL_SUBJECT, body)
                db.mark_agenda_reminder_sent(uid, rid, when)
                delivered += 1
            elif channel == "push":
                if try_send_push(uid, title, body.replace("\n\n", " "), rid):
                    db.mark_agenda_reminder_sent(uid, rid, when)
                    delivered += 1
                else:
                    db.release_agenda_reminder_claim(uid, rid)
            else:
                db.mark_agenda_reminder_sent(uid, rid, when)
        except Exception as exc:
            log.error("agenda reminder deliver failed user=%s id=%s: %s", uid, rid, exc)
            db.release_agenda_reminder_claim(uid, rid)
    return delivered


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(f"delivered {run_agenda_reminders()} agenda reminder(s)")
