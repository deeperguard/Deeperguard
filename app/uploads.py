"""Per-user server directories, keyed by email address."""
from __future__ import annotations

import re
from pathlib import Path

from config import DATA_DIR

_UNSAFE = re.compile(r"[^a-z0-9._-]+")
UPLOADS_ROOT = DATA_DIR / "uploads"


def email_fs_name(email: str) -> str:
    raw = str(email or "").strip().lower()
    if "@" in raw:
        local, domain = raw.rsplit("@", 1)
        raw = f"{local}_at_{domain}"
    safe = _UNSAFE.sub("_", raw).strip("._")
    return (safe or "user")[:180]


def user_upload_dir(email: str) -> Path:
    path = UPLOADS_ROOT / email_fs_name(email)
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_user_upload_dir(email: str) -> Path:
    root = user_upload_dir(email)
    (root / "device-reports").mkdir(parents=True, exist_ok=True)
    (root / "ocr").mkdir(parents=True, exist_ok=True)
    return root


def remove_user_upload_dir(email: str) -> None:
    import shutil

    path = UPLOADS_ROOT / email_fs_name(email)
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
