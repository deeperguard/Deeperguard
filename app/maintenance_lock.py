"""Advisory file lock so backup cron and heavy sync do not overlap."""
from __future__ import annotations

import fcntl
import os
from contextlib import contextmanager
from pathlib import Path

from config import DATA_DIR

_LOCK_PATH = DATA_DIR / "maintenance.lock"


@contextmanager
def maintenance_lock(blocking: bool = False):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(_LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o600)
    flags = fcntl.LOCK_EX
    if not blocking:
        flags |= fcntl.LOCK_NB
    try:
        fcntl.flock(fd, flags)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError("maintenance in progress")
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
