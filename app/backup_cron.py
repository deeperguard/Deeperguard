"""Scheduled encrypted backup emails and pCloud sync."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
from backup_mail import send_user_backup  # noqa: E402
from backup_pcloud import run_pcloud_backups  # noqa: E402
from maintenance_lock import maintenance_lock  # noqa: E402

log = logging.getLogger("deeperguard.backup")


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
    sent = 0
    for user in db.users_with_backup_enabled():
        recipient = str(user["backup_email"] or user["email"])
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
