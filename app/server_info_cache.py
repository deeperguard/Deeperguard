"""Precomputed server info — refreshed every 5 minutes on the server."""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import db
from config import DATA_DIR, ocr_ephemeral

log = logging.getLogger("deeperguard.server_info")

REFRESH_INTERVAL_SEC = int(os.environ.get("NOTES_SERVER_INFO_REFRESH_SEC", "300"))
CACHE_DIR = DATA_DIR / "server-info-cache"

_lock = threading.Lock()
_memory: dict[int, dict[str, Any]] = {}
_thread_started = False
_stop = threading.Event()


def _cache_path(user_id: int) -> Path:
    return CACHE_DIR / f"user-{int(user_id)}.json"


def compute_server() -> dict[str, Any]:
    usage = shutil.disk_usage(str(DATA_DIR))
    ocr_bytes = 0 if ocr_ephemeral() else db.dir_size(DATA_DIR / "ocr")
    return {
        "disk_free_bytes": usage.free,
        "disk_total_bytes": usage.total,
        "disk_used_bytes": usage.used,
        "ocr_bytes_total": ocr_bytes,
        "computed_at": time.time(),
    }


def compute(user_id: int) -> dict[str, Any]:
    vault = db.user_vault_stats(user_id)
    ocr_bytes = 0
    if not ocr_ephemeral():
        ocr_bytes = db.dir_size(DATA_DIR / "ocr" / str(int(user_id)))
        try:
            from uploads import user_upload_dir

            ocr_bytes += db.dir_size(user_upload_dir(int(user_id)) / "ocr")
        except OSError:
            pass
    usage = shutil.disk_usage(str(DATA_DIR))
    return {
        "ok": True,
        "sync_items": vault["active_items"],
        "vault_bytes": vault["vault_bytes"],
        "ocr_bytes": ocr_bytes,
        "disk_free_bytes": usage.free,
        "disk_total_bytes": usage.total,
        "disk_used_bytes": usage.used,
        "computed_at": time.time(),
    }


def store(user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    uid = int(user_id)
    data = dict(payload)
    data["computed_at"] = float(data.get("computed_at") or time.time())
    with _lock:
        _memory[uid] = data
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(uid)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)
    return data


def load_from_disk(user_id: int) -> dict[str, Any] | None:
    path = _cache_path(int(user_id))
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(raw, dict) or not raw.get("ok"):
        return None
    with _lock:
        _memory[int(user_id)] = raw
    return dict(raw)


def get(user_id: int) -> dict[str, Any] | None:
    uid = int(user_id)
    with _lock:
        cached = _memory.get(uid)
    if cached:
        return dict(cached)
    return load_from_disk(uid)


def refresh_user(user_id: int) -> dict[str, Any]:
    return store(user_id, compute(user_id))


def drop_user(user_id: int) -> None:
    uid = int(user_id)
    with _lock:
        _memory.pop(uid, None)
    try:
        _cache_path(uid).unlink(missing_ok=True)
    except OSError:
        pass


def refresh_all_users() -> int:
    rows = db.connection().execute("SELECT id FROM users").fetchall()
    count = 0
    for row in rows:
        try:
            refresh_user(int(row["id"]))
            count += 1
        except Exception as exc:
            log.warning("server info refresh failed user=%s: %s", row["id"], exc)
    return count


def get_or_compute(user_id: int) -> dict[str, Any]:
    cached = get(user_id)
    if cached:
        return cached
    return refresh_user(user_id)


def warm_memory_from_disk() -> None:
    if not CACHE_DIR.is_dir():
        return
    for path in CACHE_DIR.glob("user-*.json"):
        try:
            uid = int(path.stem.split("-", 1)[1])
        except (ValueError, IndexError):
            continue
        load_from_disk(uid)


def _refresh_loop() -> None:
    while not _stop.wait(REFRESH_INTERVAL_SEC):
        try:
            refresh_all_users()
        except Exception as exc:
            log.warning("server info refresh loop: %s", exc)


def start_refresh_loop() -> None:
    global _thread_started
    if _thread_started or os.environ.get("NOTES_SERVER_INFO_REFRESH", "1") == "0":
        return
    _thread_started = True
    warm_memory_from_disk()
    threading.Thread(target=refresh_all_users, name="server-info-initial", daemon=True).start()
    threading.Thread(target=_refresh_loop, name="server-info-refresh", daemon=True).start()
