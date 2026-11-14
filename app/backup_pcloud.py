"""Sync encrypted local backups to pCloud via rclone."""
from __future__ import annotations

import json
import logging
import os
import re
import gzip
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import db
import pcloud_credentials as pc
from backup_mail import backups_dir, ensure_local_full_backup
import config
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


def rclone_remote_env(user_id: int, region: str) -> dict[str, str]:
    """Environment for rclone with the remote defined in memory only.

    No config file is written, so the OAuth token never touches disk in readable form.
    """
    token = pcloud_token(user_id)
    if not token:
        raise RuntimeError("pCloud rclone OAuth token is not configured")
    prefix = f"RCLONE_CONFIG_{RCLONE_REMOTE.upper()}_"
    env = dict(os.environ)
    env[prefix + "TYPE"] = "pcloud"
    env[prefix + "HOSTNAME"] = pcloud_hostname(region)
    env[prefix + "TOKEN"] = token
    return env


def _rclone_base_args() -> list[str]:
    return [
        rclone_bin(),
        "--config",
        os.devnull,
        "--retries",
        "2",
        "--low-level-retries",
        "3",
        "--contimeout",
        "60s",
    ]


def _run_rclone(cmd: list[str], *, timeout: int, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
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


def prune_remote_backups(user_id: int, env: dict[str, str], remote_path: str) -> None:
    """Remove remote backups older than PCLOUD_RETENTION_DAYS (by file mtime on pCloud)."""
    if PCLOUD_RETENTION_DAYS <= 0:
        return
    include = backup_include_pattern(user_id)
    cmd = [
        *_rclone_base_args(),
        "delete",
        f"{RCLONE_REMOTE}:{remote_path}",
        "--include",
        include,
        "--min-age",
        f"{PCLOUD_RETENTION_DAYS}d",
        "--multi-thread-streams",
        "0",
    ]
    proc = _run_rclone(cmd, timeout=min(RCLONE_TIMEOUT_SECONDS, 1800), env=env)
    if proc.returncode != 0:
        detail = _format_rclone_error(proc)
        raise RuntimeError(f"remote prune failed: {detail}")


def upload_backup_file(
    local_path: Path,
    env: dict[str, str],
    remote_path: str,
) -> None:
    """Upload a single gzip backup; avoids re-uploading every local daily copy."""
    cmd = [
        *_rclone_base_args(),
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
    proc = _run_rclone(cmd, timeout=RCLONE_TIMEOUT_SECONDS, env=env)
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
    env = rclone_remote_env(user_id, region)

    local_path, item_count, bytes_size = ensure_local_full_backup(user_id, max_age=PCLOUD_LOCAL_MAX_AGE)
    if item_count == 0 and local_path.is_file():
        item_count = sum(1 for _ in db.iter_backup_items(user_id))

    try:
        upload_backup_file(local_path, env, remote_path)
    except RuntimeError as exc:
        detail = str(exc)
        db.update_pcloud_sync_status(user_id, "error", detail)
        db.log_backup(user_id, remote_path, item_count, bytes_size, "error", f"pcloud:{detail}")
        raise

    prune_error = ""
    try:
        prune_remote_backups(user_id, env, remote_path)
    except RuntimeError as exc:
        prune_error = str(exc)
        log.warning("pcloud remote prune user=%s: %s", user_id, prune_error)

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
    if service_source():
        managed_healthcheck()  # result only logged; legacy token users are unaffected
    managed_ids = {int(u["id"]) for u in db.users_with_managed_backup_enabled()}
    for user in db.users_with_pcloud_enabled():
        uid = int(user["id"])
        if uid in managed_ids:
            continue  # managed flag wins; the legacy token flow is for non-managed users
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


# --- Managed (service remote) backup: rclone wrapper, health check, per-user path ---

HEALTHCHECK_DIR = "__healthcheck"
HEALTHCHECK_TIMEOUT_SECONDS = 60
_DIR_ID_RE = re.compile(r"^[0-9a-f]{32}$")

ERR_NOT_CONFIGURED = "not_configured"
ERR_RCLONE_MISSING = "rclone_missing"
ERR_UNAVAILABLE = "remote_unavailable"
ERR_TIMEOUT = "timeout"
ERR_QUOTA = "quota"
ERR_AUTH = "auth"
ERR_BAD_PATH = "bad_path"


class ManagedBackupError(RuntimeError):
    """Carries only a fixed error code; never rclone output."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _classify_rclone_failure(stderr: str) -> str:
    """Map rclone stderr to a fixed code. The text itself is discarded."""
    low = (stderr or "").lower()
    if "quota" in low or "insufficient storage" in low or "over quota" in low:
        return ERR_QUOTA
    if "401" in low or "unauthorized" in low or "empty token" in low:
        return ERR_AUTH
    return ERR_UNAVAILABLE


ADMIN_REMOTE_NAME = "dgservice"
SOURCE_ENV = "env"
SOURCE_ADMIN = "admin"


def _stored_token_configured() -> bool:
    try:
        import pcloud_service_token as pst

        return bool(pst.status()["configured"])
    except Exception:
        return False


def service_source() -> str:
    """'env' (NOTES_PCLOUD_SERVICE_REMOTE wins), 'admin' (stored token) or '' (none)."""
    if config.pcloud_service_remote():
        return SOURCE_ENV
    if _stored_token_configured():
        return SOURCE_ADMIN
    return ""


def service_status() -> dict[str, Any]:
    src = service_source()
    return {"configured": bool(src), "source": src or "not_configured"}


def _managed_remote_name() -> str:
    src = service_source()
    if not src or not config.pcloud_service_root():
        raise ManagedBackupError(ERR_NOT_CONFIGURED)
    return config.pcloud_service_remote() if src == SOURCE_ENV else ADMIN_REMOTE_NAME


def _admin_remote_env() -> dict[str, str]:
    """Subprocess env with the stored token as an in-memory rclone remote."""
    import pcloud_service_token as pst

    try:
        token_json, region = pst.decrypt_for_use()
    except pst.TokenError:
        raise ManagedBackupError(ERR_AUTH) from None
    prefix = f"RCLONE_CONFIG_{ADMIN_REMOTE_NAME.upper()}_"
    env = dict(os.environ)
    env[prefix + "TYPE"] = "pcloud"
    env[prefix + "TOKEN"] = token_json
    env[prefix + "HOSTNAME"] = pcloud_hostname(region)
    return env


def _run_managed_rclone(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    """Run rclone for the service remote. Raises ManagedBackupError(code) on any failure."""
    _managed_remote_name()  # validates configuration; callers embed it through _remote_spec
    try:
        binary = rclone_bin()
    except RuntimeError:
        raise ManagedBackupError(ERR_RCLONE_MISSING) from None
    cmd = [binary]
    env = None
    if service_source() == SOURCE_ADMIN:
        env = _admin_remote_env()  # decrypted just before the call, subprocess-only
    else:
        cfg = config.pcloud_service_rclone_config()
        if cfg:
            cmd += ["--config", cfg]
    cmd += list(args)
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            shell=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise ManagedBackupError(ERR_TIMEOUT) from None
    except OSError:
        raise ManagedBackupError(ERR_RCLONE_MISSING) from None
    finally:
        env = None
    if proc.returncode != 0:
        # classify then discard: rclone output (which may echo the token) is never kept
        raise ManagedBackupError(_classify_rclone_failure(proc.stderr or ""))
    proc.stderr = ""
    return proc


def test_connection() -> dict[str, Any]:
    """Cheap read-only check (lsd on the remote root). Returns only ok + fixed category."""
    try:
        remote = _managed_remote_name()
        _run_managed_rclone(["lsd", f"{remote}:", "--max-depth", "1"],
                            timeout=HEALTHCHECK_TIMEOUT_SECONDS)
        return {"ok": True, "category": "ok"}
    except ManagedBackupError as exc:
        return {"ok": False, "category": exc.code}
    except Exception:
        return {"ok": False, "category": ERR_UNAVAILABLE}


test_connection.__test__ = False  # not a pytest test


def _remote_spec(relative: str) -> str:
    return f"{_managed_remote_name()}:{config.pcloud_service_root()}/{relative}"


def managed_healthcheck() -> dict[str, Any]:
    """Cheap check on the fixed health-check folder. Never lists user folders, never raises."""
    try:
        spec = _remote_spec(HEALTHCHECK_DIR)
        try:
            _run_managed_rclone(
                ["lsf", spec, "--max-depth", "1", "--files-only"],
                timeout=HEALTHCHECK_TIMEOUT_SECONDS,
            )
        except ManagedBackupError as exc:
            if exc.code != ERR_UNAVAILABLE:
                raise
            _run_managed_rclone(["mkdir", spec], timeout=HEALTHCHECK_TIMEOUT_SECONDS)
        return {"available": True, "reason_code": ""}
    except ManagedBackupError as exc:
        log.warning("managed pcloud backup unavailable: %s", exc.code)
        return {"available": False, "reason_code": exc.code}
    except Exception:
        log.warning("managed pcloud backup unavailable: %s", ERR_UNAVAILABLE)
        return {"available": False, "reason_code": ERR_UNAVAILABLE}


def user_backup_path(user: Any) -> str:
    """Remote directory (without remote name) for one user.

    Built only from the stored opaque id and the configured root. Raises
    ManagedBackupError if either is invalid.
    """
    root = config.pcloud_service_root()
    if not root:
        raise ManagedBackupError(ERR_NOT_CONFIGURED)
    try:
        dir_id = user["pcloud_dir_id"]
    except (KeyError, IndexError, TypeError):
        raise ManagedBackupError(ERR_BAD_PATH) from None
    if not isinstance(dir_id, str) or not _DIR_ID_RE.fullmatch(dir_id):
        raise ManagedBackupError(ERR_BAD_PATH)
    return f"{root}/{dir_id}"


# --- Managed run: per-user upload of ciphertext only, retention per directory ---

MANAGED_ARCHIVE_GLOB = "backup-*.enc.json.gz"
ERR_PLAN = "plan"
ERR_UPLOAD = "upload_failed"
# Exactly what a managed archive may contain; tests assert this export list.
MANAGED_TOP_LEVEL_KEYS = ("exported_at", "format", "item_count", "items", "kdf_salt")
MANAGED_ITEM_KEYS = (
    "blob_ciphertext", "ciphertext", "content_hash", "content_version",
    "deleted", "item_uuid", "updated_at",
)


def write_managed_archive(user_id: int, directory: Path) -> tuple[Path, int, int]:
    """Stream the user's stored ciphertext into a gzip file. No e-mail, no secrets."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise ManagedBackupError(ERR_BAD_PATH)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    path = directory / f"backup-{stamp}.enc.json.gz"
    exported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    count = 0
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as gz:
        gz.write('{"format":"deeperguard-backup-v1",')
        gz.write(f'"kdf_salt":{json.dumps(user["kdf_salt"])},')
        gz.write(f'"exported_at":{json.dumps(exported_at)},"items":[')
        for item in db.iter_backup_items(user_id):
            if count:
                gz.write(",")
            gz.write(json.dumps(item, separators=(",", ":"), sort_keys=True))
            count += 1
        gz.write(f'],"item_count":{count}}}')
    return path, count, path.stat().st_size


def _managed_prune_and_count(spec_dir: str, fallback: int) -> int:
    """Apply the existing retention inside one user directory; return backups kept."""
    if PCLOUD_RETENTION_DAYS > 0:
        try:
            _run_managed_rclone(
                ["delete", spec_dir, "--include", MANAGED_ARCHIVE_GLOB,
                 "--min-age", f"{PCLOUD_RETENTION_DAYS}d"],
                timeout=min(RCLONE_TIMEOUT_SECONDS, 1800),
            )
        except ManagedBackupError as exc:
            log.warning("managed prune failed: %s", exc.code)
    try:
        proc = _run_managed_rclone(
            ["lsf", spec_dir, "--files-only", "--max-depth", "1"],
            timeout=HEALTHCHECK_TIMEOUT_SECONDS,
        )
    except ManagedBackupError:
        return fallback
    names = [ln.strip() for ln in (proc.stdout or "").splitlines()]
    return sum(1 for n in names if re.fullmatch(r"backup-[0-9-]+\.enc\.json\.gz", n))


def sync_managed_user(user: Any) -> dict[str, Any]:
    """Upload one user's ciphertext into that user's own directory. Raises ManagedBackupError."""
    from plans import plan_has

    uid = int(user["id"])
    if not plan_has(db.user_plan(user), "pcloud_backup"):
        raise ManagedBackupError(ERR_PLAN)
    dir_path = user_backup_path(user)  # only the stored opaque id + configured root
    spec_dir = f"{_managed_remote_name()}:{dir_path}"
    with tempfile.TemporaryDirectory(dir=backups_dir(), prefix="managed-") as tmp:
        path, items, size = write_managed_archive(uid, Path(tmp))
        try:
            _run_managed_rclone(
                ["copyto", str(path), f"{spec_dir}/{path.name}", "--transfers", "1"],
                timeout=RCLONE_TIMEOUT_SECONDS,
            )
        except ManagedBackupError as exc:
            if exc.code == ERR_UNAVAILABLE:
                raise ManagedBackupError(ERR_UPLOAD) from None
            raise
    kept = _managed_prune_and_count(spec_dir, int(user["pcloud_last_kept"] or 0))
    return {"size": size, "kept": kept, "items": items}


def run_managed_backups() -> list[dict[str, Any]]:
    """Run managed backups for every enabled user; returns one result dict per user.

    The result list (user_id, ok, code, size, kept, at) is the input for the mail task.
    One user's failure never stops the others; it is retried on the next run.
    """
    results: list[dict[str, Any]] = []
    users = db.users_with_managed_backup_enabled()
    if not users:
        return results
    health = managed_healthcheck()
    for user in users:
        uid = int(user["id"])
        code, size, kept = "", 0, 0
        try:
            if not health["available"]:
                raise ManagedBackupError(health["reason_code"] or ERR_UNAVAILABLE)
            out = sync_managed_user(user)
            size, kept = out["size"], out["kept"]
        except ManagedBackupError as exc:
            code = exc.code
        except Exception:
            code = ERR_UNAVAILABLE
        status = "ok" if not code else ("skipped" if code == ERR_PLAN else "error")
        try:
            db.update_managed_backup_status(uid, status, code, size, kept)
            db.log_backup(uid, "managed", 0, size, status, code or "pcloud")
        except Exception:
            log.error("managed backup status not saved user_id=%s", uid)
        if code:
            log.warning("managed pcloud backup user_id=%s failed: %s", uid, code)
        results.append({
            "user_id": uid, "ok": not code, "code": code or "ok",
            "size": size, "kept": kept, "at": time.time(),
        })
    return results
