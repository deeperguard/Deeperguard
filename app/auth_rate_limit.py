"""Simple in-memory rate limits for unauthenticated auth endpoints."""
from __future__ import annotations

import os
import time
from collections import defaultdict
from threading import Lock

_lock = Lock()
_hits: dict[str, list[float]] = defaultdict(list)
_lock_until: dict[str, float] = {}


def _limits() -> tuple[int, float]:
    try:
        limit = int(os.environ.get("NOTES_AUTH_RATE_LIMIT", "24"))
    except (TypeError, ValueError):
        limit = 24
    try:
        window = float(os.environ.get("NOTES_AUTH_RATE_WINDOW", "300"))
    except (TypeError, ValueError):
        window = 300.0
    if os.environ.get("NOTES_DISABLE_CIDR_GATE", "0") == "1":
        try:
            wan_limit = int(os.environ.get("NOTES_AUTH_RATE_LIMIT_WAN", "12"))
            limit = min(limit, wan_limit)
        except (TypeError, ValueError):
            limit = min(limit, 12)
    return max(1, limit), max(60.0, window)


_MAX_KEYS = 20_000


def allow(key: str, *, limit: int | None = None, window: float | None = None) -> bool:
    """Return True when the request is within the limit."""
    default_limit, default_window = _limits()
    use_limit = limit if limit is not None else default_limit
    use_window = window if window is not None else default_window
    now = time.time()
    with _lock:
        # Bound memory growth on long-lived workers (prior L7).
        if len(_hits) > _MAX_KEYS:
            stale = [k for k, stamps in _hits.items() if not stamps or now - stamps[-1] >= use_window]
            for k in stale[: max(1, len(stale) // 2)]:
                _hits.pop(k, None)
            if len(_hits) > _MAX_KEYS:
                for k in list(_hits.keys())[: len(_hits) - _MAX_KEYS]:
                    _hits.pop(k, None)
        bucket = _hits[key]
        bucket[:] = [stamp for stamp in bucket if now - stamp < use_window]
        if len(bucket) >= use_limit:
            return False
        bucket.append(now)
        return True


def record(key: str, *, window: float = 3600.0) -> int:
    """Record one event and return how many are in the window (including this one)."""
    now = time.time()
    with _lock:
        bucket = _hits[key]
        bucket[:] = [stamp for stamp in bucket if now - stamp < window]
        bucket.append(now)
        return len(bucket)


def set_lock(key: str, seconds: float) -> None:
    """Block a key until `seconds` elapse from now."""
    if seconds <= 0:
        return
    with _lock:
        _lock_until[key] = time.time() + seconds


def is_locked(key: str) -> bool:
    with _lock:
        until = _lock_until.get(key, 0.0)
        if until and time.time() < until:
            return True
        if until:
            _lock_until.pop(key, None)
        return False
