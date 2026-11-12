"""Refuse WAN/production boot when critical secrets are empty, built-in defaults, or env-example placeholders.

Never logs secret values — only setting names and rotation/refusal events.
"""
from __future__ import annotations

import logging
import os
import re
import sys
from pathlib import Path

log = logging.getLogger("deeperguard")

_BUILTIN_DEFAULTS: dict[str, frozenset[str]] = {
    "NOTES_INDEXNOW_KEY": frozenset({"deeperguard-notes-indexnow-8f3a"}),
    "NOTES_ADMIN_EMAILS": frozenset({"admin@example.com"}),
    "NOTES_SMTP_HOST": frozenset({"localhost", "smtp.example.com"}),
}

# Enforced only when any of these appear set (optional integrations).
_OPTIONAL_WHEN_SET: tuple[str, ...] = (
    "NOTES_TURNSTILE_SITE_KEY",
    "NOTES_TURNSTILE_SECRET_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "NOTES_PCLOUD_CREDENTIALS_KEY",
)

_EXAMPLE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "deeperguard.env.example"


def _parse_env_example_values() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    if not _EXAMPLE_PATH.is_file():
        return out
    for raw in _EXAMPLE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key or not value or value.startswith("#"):
            continue
        out.setdefault(key, set()).add(value)
    return out


def production_secrets_enforced() -> bool:
    if os.environ.get("NOTES_ALLOW_DEFAULT_SECRETS", "0") == "1":
        return False
    if os.environ.get("NOTES_CI", "0") == "1":
        return False
    if os.environ.get("GITHUB_ACTIONS", "").lower() == "true":
        return False
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False
    if os.environ.get("NOTES_ENV", "").strip().lower() in {"dev", "development", "local", "test"}:
        return False
    return os.environ.get("NOTES_DISABLE_CIDR_GATE", "0") == "1"


def _env_value(key: str) -> str:
    return os.environ.get(key, "").strip()


def _is_placeholder(key: str, value: str, example_values: dict[str, set[str]]) -> bool:
    if not value:
        return key not in {"NOTES_ADMIN_EMAILS", "NOTES_SMTP_HOST"}
    if value in _BUILTIN_DEFAULTS.get(key, ()):
        return True
    if key in example_values and value in example_values[key]:
        return True
    if key == "NOTES_ADMIN_EMAILS":
        emails = {part.strip().lower() for part in value.split(",") if part.strip()}
        if emails & {"admin@example.com"}:
            return True
    return False


def _flask_secret_ready(keys_dir: Path) -> bool:
    if _env_value("NOTES_FLASK_SECRET"):
        return True
    path = keys_dir / "flask-secret"
    return path.is_file() and bool(path.read_text(encoding="utf-8").strip())


def collect_production_secret_violations() -> list[str]:
    if not production_secrets_enforced():
        return []
    example_values = _parse_env_example_values()
    violations: list[str] = []

    from config import KEYS_DIR

    indexnow = os.environ.get("NOTES_INDEXNOW_KEY", "deeperguard-notes-indexnow-8f3a").strip()
    if _is_placeholder("NOTES_INDEXNOW_KEY", indexnow, example_values):
        violations.append("NOTES_INDEXNOW_KEY")

    if _is_placeholder("NOTES_ADMIN_EMAILS", _env_value("NOTES_ADMIN_EMAILS"), example_values):
        violations.append("NOTES_ADMIN_EMAILS")

    smtp_host = _env_value("NOTES_SMTP_HOST")
    if smtp_host and _is_placeholder("NOTES_SMTP_HOST", smtp_host, example_values):
        violations.append("NOTES_SMTP_HOST")

    if _env_value("NOTES_SKIP_LOGIN") == "1":
        violations.append("NOTES_SKIP_LOGIN")

    if not _flask_secret_ready(KEYS_DIR):
        violations.append("NOTES_FLASK_SECRET")

    site = _env_value("NOTES_TURNSTILE_SITE_KEY")
    secret = _env_value("NOTES_TURNSTILE_SECRET_KEY")
    if site and not secret:
        violations.append("NOTES_TURNSTILE_SECRET_KEY")
    if secret and not site:
        violations.append("NOTES_TURNSTILE_SITE_KEY")

    for key in _OPTIONAL_WHEN_SET:
        val = _env_value(key)
        if not val:
            continue
        if _is_placeholder(key, val, example_values):
            violations.append(key)

    return violations


def enforce_production_secrets() -> None:
    violations = collect_production_secret_violations()
    for name in violations:
        log.error("secret_guard: refused to start — %s is empty, default, or example placeholder", name)
    if violations:
        sys.exit(1)


def log_secret_rotation(name: str, *, reason: str = "rotated") -> None:
    """Audit hook for secrets that were generated or replaced at startup (no values)."""
    log.warning("secret_guard: %s %s", name, reason)
