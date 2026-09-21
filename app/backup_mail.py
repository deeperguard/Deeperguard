"""Build email-sized encrypted backups and keep a full local copy."""
from __future__ import annotations

import gzip
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import db
from config import DATA_DIR
from mailer import send_backup_email

log = logging.getLogger("deeperguard.backup")

# Raw attachment budget before base64 (~4/3) and MIME headers; stay under 10MB SMTP.
EMAIL_ATTACHMENT_MAX = int(os.environ.get("NOTES_BACKUP_EMAIL_MAX_BYTES", str(6_500_000)))
# Prefer dropping large ciphertext blobs (documents) when the vault is too big to email.
LARGE_CIPHERTEXT_BYTES = int(os.environ.get("NOTES_BACKUP_LARGE_ITEM_BYTES", str(200_000)))
LOCAL_KEEP = int(os.environ.get("NOTES_BACKUP_LOCAL_KEEP", "14"))


def backups_dir() -> Path:
    path = DATA_DIR / "backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def gzip_json(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return gzip.compress(raw, compresslevel=9)


def prune_local_backups(user_id: int) -> None:
    prefix = f"user-{user_id}-"
    files = sorted(
        backups_dir().glob(f"{prefix}*.enc.json.gz"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in files[LOCAL_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass


def latest_local_full(user_id: int) -> Path | None:
    files = sorted(
        backups_dir().glob(f"user-{int(user_id)}-*-full.enc.json.gz"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return files[0] if files else None


def ensure_local_full_backup(user_id: int, *, max_age: int = 7200) -> tuple[Path, int, int]:
    """Reuse a recent streaming full backup so cron does not write two copies."""
    latest = latest_local_full(user_id)
    if latest is not None:
        age = time.time() - latest.stat().st_mtime
        if 0 <= age <= max_age:
            return latest, 0, latest.stat().st_size
    return write_local_full_backup_streaming(user_id)


def write_local_full_backup_streaming(user_id: int) -> tuple[Path, int, int]:
    """Write a full vault gzip backup without loading all items into memory."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise RuntimeError("user not found")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    path = backups_dir() / f"user-{user_id}-{stamp}-full.enc.json.gz"
    exported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    item_count = 0
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as gz:
        gz.write("{")
        gz.write('"format":"deeperguard-backup-v1",')
        gz.write(f'"user_email":{json.dumps(user["email"])},')
        gz.write(f'"kdf_salt":{json.dumps(user["kdf_salt"])},')
        gz.write(f'"exported_at":{json.dumps(exported_at)},')
        gz.write('"items":[')
        first = True
        for item in db.iter_backup_items(user_id):
            if not first:
                gz.write(",")
            gz.write(json.dumps(item, separators=(",", ":"), sort_keys=True))
            first = False
            item_count += 1
        gz.write("],")
        gz.write(f'"item_count":{item_count}')
        gz.write("}")
    prune_local_backups(user_id)
    return path, item_count, path.stat().st_size


def compact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop oversized ciphertext items so the email stays under SMTP limits."""
    items = list(payload.get("items") or [])
    kept = [item for item in items if len(str(item.get("ciphertext") or "")) < LARGE_CIPHERTEXT_BYTES]
    omitted = len(items) - len(kept)
    # If still too large, drop biggest remaining items until under budget.
    kept.sort(key=lambda item: len(str(item.get("ciphertext") or "")))
    out_items = list(kept)
    while out_items:
        candidate = {
            **payload,
            "items": out_items,
            "item_count": len(out_items),
            "email_compact": True,
            "attachments_omitted": omitted + (len(kept) - len(out_items)),
        }
        if len(gzip_json(candidate)) <= EMAIL_ATTACHMENT_MAX:
            return candidate
        out_items.pop()  # drop largest
        omitted += 1
    return {
        **payload,
        "items": [],
        "item_count": 0,
        "email_compact": True,
        "attachments_omitted": len(items),
    }


def compact_payload_streaming(user_id: int) -> dict[str, Any]:
    """Build a compact email payload without loading large document ciphertext."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise RuntimeError("user not found")
    kept: list[dict[str, Any]] = []
    omitted = 0
    for item in db.iter_backup_items(user_id):
        if len(str(item.get("ciphertext") or "")) >= LARGE_CIPHERTEXT_BYTES:
            omitted += 1
            continue
        kept.append(item)
    return compact_payload(
        {
            "format": "deeperguard-backup-v1",
            "user_email": user["email"],
            "kdf_salt": user["kdf_salt"],
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "items": kept,
            "item_count": len(kept),
            "email_compact": True,
            "attachments_omitted": omitted,
        }
    )


def prepare_email_backup(user_id: int) -> dict[str, Any]:
    """Return bytes + metadata for SMTP without loading the full vault into RAM."""
    local_path, item_count, full_bytes = ensure_local_full_backup(user_id)
    if full_bytes <= EMAIL_ATTACHMENT_MAX:
        attachment = local_path.read_bytes()
        return {
            "attachment_bytes": attachment,
            "attachment_name": "deeperguard-backup.enc.json.gz",
            "item_count": item_count,
            "bytes_size": len(attachment),
            "compact": False,
            "omitted": 0,
            "local_path": str(local_path),
        }
    compact = compact_payload_streaming(user_id)
    compact_gz = gzip_json(compact)
    return {
        "attachment_bytes": compact_gz,
        "attachment_name": "deeperguard-backup-notes.enc.json.gz",
        "item_count": int(compact.get("item_count") or 0),
        "bytes_size": len(compact_gz),
        "compact": True,
        "omitted": int(compact.get("attachments_omitted") or 0),
        "local_path": str(local_path),
        "full_bytes": full_bytes,
    }


def email_body_for(meta: dict[str, Any]) -> str:
    lines = [
        "Attached is your encrypted Deeperguard backup.",
        "",
        "The server cannot read these notes. Restore with your account password",
        "in Settings → Import backup (gzip .enc.json.gz is supported).",
        "",
        f"Items in this email: {meta['item_count']}",
        f"Attachment size: {meta['bytes_size']} bytes",
        f"Full vault copy on the notes server: {meta['local_path']}",
    ]
    if meta.get("compact"):
        lines.extend(
            [
                "",
                f"This email is a compact backup (omitted {meta.get('omitted', 0)} large "
                f"document item(s); full gzip was {meta.get('full_bytes', 0)} bytes).",
                "Large scanned documents remain on the notes server sync database and in the "
                "local full backup file above.",
            ]
        )
    return "\n".join(lines) + "\n"


def send_user_backup(user_id: int, recipient: str) -> dict[str, Any]:
    meta = prepare_email_backup(user_id)
    send_backup_email(
        recipient=recipient,
        subject=(
            "Deeperguard encrypted backup (compact)"
            if meta.get("compact")
            else "Deeperguard encrypted backup"
        ),
        body=email_body_for(meta),
        attachment_name=str(meta["attachment_name"]),
        attachment_bytes=bytes(meta["attachment_bytes"]),
    )
    db.log_backup(
        user_id,
        recipient,
        int(meta["item_count"]),
        int(meta["bytes_size"]),
        "ok",
        detail=("compact" if meta.get("compact") else "full"),
    )
    log.info(
        "backup emailed user=%s items=%s bytes=%s compact=%s local=%s",
        user_id,
        meta["item_count"],
        meta["bytes_size"],
        meta.get("compact"),
        meta.get("local_path"),
    )
    return meta
