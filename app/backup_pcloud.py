"""Sync encrypted local backups to pCloud via rclone."""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import db
import pcloud_credentials as pc
from backup_mail import backups_dir, ensure_local_full_backup
from config import KEYS_DIR, pcloud_token, pcloud_token_path, pcloud_token_set, write_pcloud_token
from mailer import send_plain_email

log = logging.getLogger("deeperguard.backup.pcloud")

RCLONE_REMOTE = "deeperguard"
DEFAULT_REMOTE_PATH = "Deeperguard/backups"
RCLONE_TIMEOUT_SECONDS = int(os.environ.get("NOTES_PCLOUD_RCLONE_TIMEOUT", "7200"))
PCLOUD_RETENTION_DAYS = int(os.environ.get("NOTES_PCLOUD_RETENTION_DAYS", "7"))
PCLOUD_LOCAL_MAX_AGE = int(os.environ.get("NOTES_PCLOUD_LOCAL_MAX_AGE", "7200"))
DEFAULT_PCLOUD_REGION = "eu"
PCLOUD_API_HOSTS = {
    "us": "api.pcloud.com",
    "eu": "eapi.pcloud.com",
}


def rclone_bin() -> str:
    path = shutil.which("rclone")
    if not path:
        raise RuntimeError("rclone is not installed on the notes server")
    return path


def default_remote_path() -> str:
    return DEFAULT_REMOTE_PATH


def normalize_remote_path(path: str) -> str:
    cleaned = str(path or "").strip().strip("/")
    return cleaned or DEFAULT_REMOTE_PATH


def normalize_pcloud_region(region: str) -> str:
    key = str(region or "").strip().lower()
    return key if key in PCLOUD_API_HOSTS else DEFAULT_PCLOUD_REGION


def pcloud_hostname(region: str) -> str:
    return PCLOUD_API_HOSTS[normalize_pcloud_region(region)]


def backup_include_pattern(user_id: int) -> str:
    return f"user-{int(user_id)}-*.enc.json.gz"


def pcloud_credentials_configured(user_id: int) -> bool:
    return pcloud_token_set(user_id)


def normalize_pcloud_token(raw: str) -> str:
    cleaned = str(raw or "").strip()
    if not cleaned:
        return ""
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError("rclone token must be JSON from: rclone authorize pcloud") from exc
    if not isinstance(data, dict) or not str(data.get("access_token") or "").strip():
        raise ValueError("rclone token JSON must include access_token")
    return json.dumps(data, separators=(",", ":"))


def pcloud_failure_recipient(user: Any) -> str:
    return str(user["backup_email"] or user["email"] or "").strip()


def notify_pcloud_backup_failure(user: Any, detail: str) -> None:
    recipient = pcloud_failure_recipient(user)
    if not recipient:
        log.warning("pcloud failure email skipped — no address user=%s", user.get("email"))
        return
    body = (
        "Your scheduled Deeperguard pCloud backup did not complete.\n\n"
        f"Account: {user['email']}\n"
        f"Detail: {detail}\n\n"
        "Paste an rclone OAuth token in Settings → pCloud backup. On your computer run "
        '"rclone authorize pcloud" (EU accounts: add --pcloud-hostname eapi.pcloud.com). '
        "Check the EU/US region matches your account.\n"
    )
    try:
        send_plain_email(recipient, "Deeperguard: pCloud backup failed", body)
    except Exception as exc:
        log.error("pcloud failure email not sent user=%s: %s", user["email"], exc)


def write_rclone_config(user_id: int, region: str) -> Path:
    """Write an ephemeral rclone config with the user's OAuth token (0600). Caller must unlink."""
    token = pcloud_token(user_id)
    if not token:
        raise RuntimeError("pCloud rclone OAuth token is not configured")
    fd, name = tempfile.mkstemp(prefix=f"pcloud-rclone-{int(user_id)}-", suffix=".conf", dir=str(KEYS_DIR))
    os.close(fd)
    config_path = Path(name)
    body = (
        f"[{RCLONE_REMOTE}]\n"
        "type = pcloud\n"
        f"hostname = {pcloud_hostname(region)}\n"
        f"token = {token}\n"
    )
    config_path.write_text(body, encoding="utf-8")
    config_path.chmod(0o600)
    return config_path


def _rclone_base_args(config_path: Path) -> list[str]:
    return [
        rclone_bin(),
        "--config",
        str(config_path),
        "--retries",
        "2",
        "--low-level-retries",
        "3",
        "--contimeout",
        "60s",
    ]


def _run_rclone(cmd: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            "rclone timed out uploading the backup. Large vaults need a stable link; "
            "try refreshing the rclone OAuth token in Settings."
        ) from exc


def _format_rclone_error(proc: subprocess.CompletedProcess[str]) -> str:
    detail = (proc.stderr or proc.stdout or "rclone failed").strip()
    if len(detail) > 500:
        detail = detail[:497] + "..."
    if "401 Unauthorized" in detail:
        return "pCloud rejected the login (401). Refresh the rclone OAuth token in Settings."
    if "409 Conflict" in detail:
        return (
            "pCloud rejected the upload (409). Refresh the rclone OAuth token in Settings "
            "or check your pCloud account status."
        )
    if "empty token found" in detail:
        return (
            "pCloud OAuth token is missing or expired. Run "
            '"rclone authorize pcloud" on your computer and paste the token in Settings.'
        )
    return detail or "pcloud sync failed"


def prune_remote_backups(user_id: int, config_path: Path, remote_path: str) -> None:
    """Remove remote backups older than PCLOUD_RETENTION_DAYS (by file mtime on pCloud)."""
    if PCLOUD_RETENTION_DAYS <= 0:
        return
    include = backup_include_pattern(user_id)
    cmd = [
        *_rclone_base_args(config_path),
        "delete",
        f"{RCLONE_REMOTE}:{remote_path}",
        "--include",
        include,
        "--min-age",
        f"{PCLOUD_RETENTION_DAYS}d",
        "--multi-thread-streams",
        "0",
    ]
    proc = _run_rclone(cmd, timeout=min(RCLONE_TIMEOUT_SECONDS, 1800))
    if proc.returncode != 0:
        detail = _format_rclone_error(proc)
        raise RuntimeError(f"remote prune failed: {detail}")


def upload_backup_file(
    local_path: Path,
    config_path: Path,
    remote_path: str,
) -> None:
    """Upload a single gzip backup; avoids re-uploading every local daily copy."""
    cmd = [
        *_rclone_base_args(config_path),
        "copy",
        str(local_path),
        f"{RCLONE_REMOTE}:{remote_path}",
        "--timeout",
        "45m",
        "--transfers",
        "1",
        "--multi-thread-streams",
        "0",
    ]
    proc = _run_rclone(cmd, timeout=RCLONE_TIMEOUT_SECONDS)
    if proc.returncode != 0:
        raise RuntimeError(_format_rclone_error(proc))


def sync_user_backup(user_id: int) -> dict[str, Any]:
    user = db.get_user_by_id(user_id)
    if not user:
        raise RuntimeError("user not found")
    username = str(user["pcloud_username"] or "").strip()
    if not username:
        raise RuntimeError("pCloud username is not configured")
    if not pcloud_credentials_configured(user_id):
        raise RuntimeError("pCloud rclone OAuth token is not configured")

    remote_path = normalize_remote_path(str(user["pcloud_remote_path"] or ""))
    region = normalize_pcloud_region(str(user["pcloud_region"] or ""))
    config_path = write_rclone_config(user_id, region)

    local_path, item_count, bytes_size = ensure_local_full_backup(user_id, max_age=PCLOUD_LOCAL_MAX_AGE)
    if item_count == 0 and local_path.is_file():
        item_count = sum(1 for _ in db.iter_backup_items(user_id))

    try:
        upload_backup_file(local_path, config_path, remote_path)
    except RuntimeError as exc:
        detail = str(exc)
        db.update_pcloud_sync_status(user_id, "error", detail)
        db.log_backup(user_id, remote_path, item_count, bytes_size, "error", f"pcloud:{detail}")
        raise
    finally:
        try:
            config_path.unlink(missing_ok=True)
        except OSError:
            pass

    prune_error = ""
    config_path = write_rclone_config(user_id, region)
    try:
        try:
            prune_remote_backups(user_id, config_path, remote_path)
        except RuntimeError as exc:
            prune_error = str(exc)
            log.warning("pcloud remote prune user=%s: %s", user_id, prune_error)
    finally:
        try:
            config_path.unlink(missing_ok=True)
        except OSError:
            pass

    detail = f"synced {local_path.name}"
    if prune_error:
        detail = f"{detail}; prune warning: {prune_error}"
    db.update_pcloud_sync_status(user_id, "ok", detail)
    db.log_backup(user_id, remote_path, item_count, bytes_size, "ok", "pcloud")
    log.info(
        "pcloud sync user=%s remote=%s items=%s bytes=%s file=%s",
        user_id,
        remote_path,
        item_count,
        bytes_size,
        local_path.name,
    )
    return {
        "ok": True,
        "remote_path": remote_path,
        "local_path": str(local_path),
        "item_count": item_count,
        "bytes_size": bytes_size,
        "detail": detail,
    }


def save_pcloud_settings(
    user_id: int,
    *,
    username: str,
    remote_path: str,
    region: str,
    enabled: bool,
    password: str | None = None,
    rclone_token: str | None = None,
) -> None:
    username = username.strip()
    remote_path = normalize_remote_path(remote_path)
    region = normalize_pcloud_region(region)
    if enabled and not username:
        raise ValueError("pCloud username is required when backup is enabled")
    if password:
        raise ValueError(
            "pCloud account passwords are no longer stored on the server. "
            "Run rclone authorize pcloud on your computer and paste the OAuth token JSON."
        )
    pc.migrate_user_pcloud_secrets(user_id, KEYS_DIR)
    if rclone_token is not None:
        token = normalize_pcloud_token(rclone_token)
        if token:
            try:
                write_pcloud_token(user_id, token)
            except RuntimeError as exc:
                raise ValueError(str(exc)) from exc
        else:
            try:
                pcloud_token_path(user_id).unlink(missing_ok=True)
            except OSError:
                pass
    if enabled and not pcloud_credentials_configured(user_id):
        raise ValueError("pCloud rclone OAuth token is required when backup is enabled")

    db.update_pcloud_settings(user_id, username, remote_path, region, enabled)


def run_pcloud_backups() -> int:
    pc.migrate_all_pcloud_secrets(KEYS_DIR)
    synced = 0
    for user in db.users_with_pcloud_enabled():
        uid = int(user["id"])
        remote_path = normalize_remote_path(str(user["pcloud_remote_path"] or ""))
        if not pcloud_credentials_configured(uid):
            detail = "pCloud rclone OAuth token is not configured"
            db.update_pcloud_sync_status(uid, "error", detail)
            db.log_backup(uid, remote_path, 0, 0, "error", f"pcloud:{detail}")
            log.error("pcloud backup skipped user=%s: %s", user["email"], detail)
            notify_pcloud_backup_failure(user, detail)
            continue
        try:
            sync_user_backup(uid)
            synced += 1
        except Exception as exc:
            detail = str(exc).strip() or "pcloud sync failed"
            log.error("pcloud backup failed user=%s: %s", user["email"], exc)
            notify_pcloud_backup_failure(user, detail)
    return synced
