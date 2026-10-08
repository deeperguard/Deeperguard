"""Per-user server directories, keyed by stable user_id."""
from __future__ import annotations

import logging
import re
import shutil
from collections import defaultdict
from pathlib import Path

from config import DATA_DIR

log = logging.getLogger("deeperguard.uploads")

_UNSAFE = re.compile(r"[^a-z0-9._-]+")
UPLOADS_ROOT = DATA_DIR / "uploads"
_migration_done = False


def email_fs_name(email: str) -> str:
    """Legacy on-disk folder name derived from email (used only for migration)."""
    raw = str(email or "").strip().lower()
    if "@" in raw:
        local, domain = raw.rsplit("@", 1)
        raw = f"{local}_at_{domain}"
    safe = _UNSAFE.sub("_", raw).strip("._")
    return (safe or "user")[:180]


def _user_id_dir_name(user_id: int) -> str:
    uid = int(user_id)
    if uid <= 0:
        raise ValueError("invalid user id")
    return str(uid)


def user_upload_dir(user_id: int) -> Path:
    path = UPLOADS_ROOT / _user_id_dir_name(user_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _ensure_writable(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if path.stat().st_mode & 0o200:
        return
    path.chmod(path.stat().st_mode | 0o700)


def ensure_user_upload_dir(user_id: int) -> Path:
    root = user_upload_dir(user_id)
    for path in (UPLOADS_ROOT, root, root / "device-reports", root / "ocr"):
        _ensure_writable(path)
    return root


def remove_user_upload_dir(user_id: int) -> None:
    path = UPLOADS_ROOT / _user_id_dir_name(user_id)
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


def migrate_email_named_upload_dirs() -> None:
    """Move legacy email-named upload folders to user_id keys (idempotent)."""
    global _migration_done
    if _migration_done:
        return
    _migration_done = True
    if not UPLOADS_ROOT.is_dir():
        return
    try:
        import db as notes_db
    except Exception:
        return

    by_legacy_name: dict[str, list[int]] = defaultdict(list)
    for row in notes_db.list_users():
        email = str(row.get("email") or "").strip().lower()
        if not email:
            continue
        by_legacy_name[email_fs_name(email)].append(int(row["id"]))

    for entry in list(UPLOADS_ROOT.iterdir()):
        if not entry.is_dir():
            continue
        legacy_name = entry.name
        if legacy_name.isdigit():
            continue
        user_ids = by_legacy_name.get(legacy_name, [])
        if len(user_ids) != 1:
            if len(user_ids) > 1:
                log.warning(
                    "legacy upload dir %s matches multiple accounts (%s); leaving in place",
                    legacy_name,
                    ", ".join(str(uid) for uid in sorted(user_ids)),
                )
            continue
        uid = user_ids[0]
        target = UPLOADS_ROOT / str(uid)
        if target.exists():
            log.warning(
                "legacy upload dir %s not migrated: user %s dir already exists",
                legacy_name,
                uid,
            )
            continue
        try:
            entry.rename(target)
            log.info("migrated upload dir %s -> %s", legacy_name, target.name)
        except OSError as exc:
            log.warning("could not migrate upload dir %s: %s", legacy_name, exc)
