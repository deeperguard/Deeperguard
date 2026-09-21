"""Simple in-memory rate limits for unauthenticated auth endpoints."""
from __future__ import annotations

import os
import time
from collections import defaultdict
from threading import Lock

_lock = Lock()
_hits: dict[str, list[float]] = defaultdict(list)


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


def allow(key: str, *, limit: int | None = None, window: float | None = None) -> bool:
    """Return True when the request is within the limit."""
    default_limit, default_window = _limits()
    use_limit = limit if limit is not None else default_limit
    use_window = window if window is not None else default_window
    now = time.time()
    with _lock:
        bucket = _hits[key]
        bucket[:] = [stamp for stamp in bucket if now - stamp < use_window]
        if len(bucket) >= use_limit:
            return False
        bucket.append(now)
        return True
