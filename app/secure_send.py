"""D2 Secure Send — server-side constants and helpers (ciphertext only; no keys)."""
from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any

from config import DATA_DIR

# Defaults / hard caps (Dennis D2 decisions).
DEFAULT_MAX_VIEWS = 1
DEFAULT_EXPIRES_SECONDS = 7 * 24 * 3600
MAX_EXPIRES_SECONDS = 7 * 24 * 3600
MIN_EXPIRES_SECONDS = 5 * 60
MAX_VIEWS_CAP = 50
MAX_FILE_BYTES = 50 * 1024 * 1024
# Ciphertext envelope JSON (note + optional file) after client encryption.
MAX_CIPHERTEXT_BYTES = 80 * 1024 * 1024

ID_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")

# Copy rule: never tell the user the payload was removed — say the link stopped.
LINK_STOPPED = "This link has stopped working."


def blob_dir() -> Path:
    path = DATA_DIR / "secure_send"
    path.mkdir(parents=True, exist_ok=True)
    return path


def blob_path(send_id: str) -> Path:
    return blob_dir() / f"{send_id}.bin"


def new_send_id() -> str:
    # 32 bytes → 43 urlsafe chars; fits ID_RE.
    return secrets.token_urlsafe(32)


def valid_id(send_id: str) -> bool:
    return bool(ID_RE.match(str(send_id or "")))


def clamp_expires_in(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_EXPIRES_SECONDS
    return max(MIN_EXPIRES_SECONDS, min(MAX_EXPIRES_SECONDS, value))


def clamp_max_views(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_MAX_VIEWS
    return max(1, min(MAX_VIEWS_CAP, value))


def write_ciphertext(send_id: str, payload: dict) -> int:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if len(raw) > MAX_CIPHERTEXT_BYTES:
        raise ValueError("ciphertext too large")
    path = blob_path(send_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(raw)
    tmp.replace(path)
    return len(raw)


def read_ciphertext(send_id: str) -> dict | None:
    path = blob_path(send_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None


def purge_ciphertext(send_id: str) -> None:
    path = blob_path(send_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    for stale in (path.with_suffix(".tmp"),):
        try:
            stale.unlink(missing_ok=True)
        except OSError:
            pass


def status_label(
    *,
    canceled_at: float | None,
    expires_at: float,
    views_used: int,
    max_views: int,
    has_blob: bool,
    now_ts: float,
) -> str:
    if canceled_at:
        return "canceled"
    if now_ts >= float(expires_at):
        return "expired"
    if views_used >= max_views or not has_blob:
        return "used"
    return "active"
