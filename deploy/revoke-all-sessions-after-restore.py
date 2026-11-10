#!/usr/bin/env python3
"""Revoke every active user_sessions row after restoring notes.db from a snapshot.

Prevents pre-restore session cookies from authenticating once traffic is reopened.
Safe to run multiple times (already-revoked rows are skipped).

  NOTES_ROOT=/opt/deeperguard \\
    NOTES_REVOKE_ALL_SESSIONS_AFTER_RESTORE_CONFIRM=1 \\
    python3 deploy/revoke-all-sessions-after-restore.py

Or pass --confirm (same safety as the env var).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

CONFIRM_ENV = "NOTES_REVOKE_ALL_SESSIONS_AFTER_RESTORE_CONFIRM"


def _confirmed(*, flag: bool) -> bool:
    if flag:
        return True
    return os.environ.get(CONFIRM_ENV) == "1"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help=f"Run the revoke (or set {CONFIRM_ENV}=1).",
    )
    parser.add_argument(
        "--reason",
        default="db-restore",
        help="revoke_reason stored on each row (default: db-restore).",
    )
    args = parser.parse_args()

    if not os.environ.get("NOTES_ROOT"):
        os.environ.setdefault("NOTES_ROOT", "/opt/deeperguard")

    if not _confirmed(flag=bool(args.confirm)):
        print(
            f"Refusing: pass --confirm or set {CONFIRM_ENV}=1.",
            file=sys.stderr,
        )
        return 2

    import db

    before = db.count_active_user_sessions()
    revoked = db.revoke_all_active_user_sessions(reason=str(args.reason))
    after = db.count_active_user_sessions()
    print(f"active_sessions_before={before}")
    print(f"revoked={revoked}")
    print(f"active_sessions_after={after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
