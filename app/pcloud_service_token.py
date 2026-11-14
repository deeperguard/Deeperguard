"""Admin-set pCloud service token, encrypted at rest (AES-256-GCM).

The 32-byte server key lives in a 0600 file in KEYS_DIR, separate from the database.
The database stores only ciphertext, nonce, region, set_at and set_by. Error messages
and logs never contain the token or the submitted input.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import config
import db

TABLE = "pcloud_service_token"
ROW_ID = 1
KEY_FILENAME = "pcloud-service-token.key"
MAX_INPUT_BYTES = 4096
REGIONS = ("eu", "us")


class TokenError(ValueError):
    """Carries a fixed message that never contains input or secrets."""


def _aad() -> bytes:
    return f"{TABLE}:{ROW_ID}".encode("ascii")


def key_path():
    return config.KEYS_DIR / KEY_FILENAME


def _load_key(create: bool) -> bytes | None:
    path = key_path()
    try:
        key = path.read_bytes()
    except FileNotFoundError:
        key = None
    if key is not None:
        if len(key) != 32:
            raise TokenError("pCloud service key file is invalid")
        return key
    if not create:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:  # lost a race: use the winner's key
        return _load_key(False)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
        fh.flush()
        os.fsync(fh.fileno())
    return key


def _decrypt(key: bytes, ciphertext: bytes, nonce: bytes) -> str:
    try:
        return AESGCM(key).decrypt(bytes(nonce), bytes(ciphertext), _aad()).decode("utf-8")
    except (InvalidTag, ValueError):
        raise TokenError("stored pCloud token cannot be decrypted") from None


def _has_control(text: str) -> bool:
    return any(ord(c) < 32 or ord(c) == 127 for c in text)


def parse_input(raw: Any) -> str:
    """Return the token as rclone token JSON. Accepts rclone-authorize JSON or a bare token."""
    if not isinstance(raw, str):
        raise TokenError("token must be text")
    text = raw.strip()
    if not text:
        raise TokenError("token is empty")
    if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise TokenError("token is too large (max 4 KB)")
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            raise TokenError("token JSON is not valid") from None
        access = data.get("access_token") if isinstance(data, dict) else None
        if not isinstance(access, str) or not access.strip():
            raise TokenError("token JSON must contain access_token")
        if _has_control(access):
            raise TokenError("token contains control characters")
        return json.dumps(data, separators=(",", ":"))
    if _has_control(text) or any(c.isspace() for c in text):
        raise TokenError("token contains control characters or spaces")
    return json.dumps(
        {"access_token": text, "token_type": "bearer", "expiry": "0001-01-01T00:00:00Z"},
        separators=(",", ":"),
    )


def _check_region(region: Any) -> str:
    value = region.strip().lower() if isinstance(region, str) else ""
    if value not in REGIONS:
        raise TokenError("region must be eu or us")
    return value


def set_token(raw: Any, region: Any, admin: Any) -> None:
    token_json = parse_input(raw)
    region = _check_region(region)
    key = _load_key(True)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, token_json.encode("utf-8"), _aad())
    conn = db.connection()
    conn.execute(
        f"INSERT OR REPLACE INTO {TABLE} (id, ciphertext, nonce, region, set_at, set_by) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (ROW_ID, ciphertext, nonce, region, time.time(), str(admin or "")[:254]),
    )
    conn.commit()


def _row():
    return db.connection().execute(
        f"SELECT ciphertext, nonce, region, set_at, set_by FROM {TABLE} WHERE id = ?", (ROW_ID,)
    ).fetchone()


def status() -> dict[str, Any]:
    row = _row()
    if not row:
        return {"configured": False, "region": "", "set_at": 0, "set_by": ""}
    return {
        "configured": True,
        "region": row["region"],
        "set_at": row["set_at"],
        "set_by": row["set_by"],
    }


def remove() -> None:
    conn = db.connection()
    conn.execute(f"DELETE FROM {TABLE} WHERE id = ?", (ROW_ID,))
    conn.commit()


def decrypt_for_use() -> tuple[str, str]:
    """Return (token_json, region). Plaintext stays in memory; callers must not log it."""
    row = _row()
    if not row:
        raise TokenError("pCloud service token is not configured")
    key = _load_key(False)
    if key is None:
        raise TokenError("stored pCloud token cannot be decrypted")
    return _decrypt(key, row["ciphertext"], row["nonce"]), row["region"]
