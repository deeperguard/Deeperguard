"""Scheduled encrypted backup emails and pCloud sync."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import email_verify  # noqa: E402
from backup_mail import send_user_backup  # noqa: E402
from backup_pcloud import notify_managed_results, run_managed_backups, run_pcloud_backups, run_pending_cleanups  # noqa: E402
from maintenance_lock import maintenance_lock  # noqa: E402

log = logging.getLogger("deeperguard.backup")

# Result of the last managed pCloud run (one dict per user); read by the mail task.
LAST_MANAGED_RESULTS: list[dict] = []


def run_backups() -> tuple[int, int]:
    try:
        with maintenance_lock(blocking=False):
            return _run_backups_locked()
    except RuntimeError:
        log.warning("backup skipped — maintenance lock held")
        return 0, 0


def _run_backups_locked() -> tuple[int, int]:
    db.wal_checkpoint("PASSIVE")
    # pCloud first: it streams the full vault. Email used to load the vault into
    # RAM and OOM-kill this process before pCloud ran.
    synced = run_pcloud_backups()
    try:
        run_pending_cleanups()
    except Exception as exc:
        log.error("pcloud cleanup run failed: %s", type(exc).__name__)
    try:
        LAST_MANAGED_RESULTS[:] = run_managed_backups()
    except Exception as exc:
        log.error("managed pcloud run failed: %s", type(exc).__name__)
    notify_managed_results(LAST_MANAGED_RESULTS)
    synced += sum(1 for r in LAST_MANAGED_RESULTS if r["ok"])
    sent = 0
    for user in db.users_with_backup_enabled():
        recipient = str(user["backup_email"] or user["email"])
        if not email_verify.recipient_verified(user, recipient):
            db.log_backup(int(user["id"]), recipient, 0, 0, "skipped", "email not verified")
            continue
        try:
            send_user_backup(int(user["id"]), recipient)
            sent += 1
        except Exception as exc:
            db.log_backup(int(user["id"]), recipient, 0, 0, "error", str(exc))
            log.error("backup failed user=%s: %s", user["email"], exc)
    db.wal_checkpoint("PASSIVE")
    return sent, synced


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    email_count, pcloud_count = run_backups()
    print(f"sent {email_count} email backup(s), synced {pcloud_count} pCloud backup(s)")
