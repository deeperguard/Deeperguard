"""Rotating sync.log writer — avoids per-request open/close."""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from config import DATA_DIR

_logger: logging.Logger | None = None


def logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "sync.log"
    _logger = logging.getLogger("deeperguard.sync.file")
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    if not _logger.handlers:
        handler = RotatingFileHandler(
            path,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%SZ"))
        handler.converter = __import__("time").gmtime
        _logger.addHandler(handler)
    return _logger


def write(line: str) -> None:
    logger().info(line)
