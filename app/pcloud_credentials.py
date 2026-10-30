"""pCloud backup credentials: OAuth token only, encrypted at rest on disk.

The encryption key lives in config/deeperguard.env (NOTES_PCLOUD_CREDENTIALS_KEY), not under keys/.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger("deeperguard.pcloud.credentials")

ENVELOPE_PREFIX = "dg-pcloud-v1:"
ENV_KEY = "NOTES_PCLOUD_CREDENTIALS_KEY"
_LEGACY_PASSWORD_GLOB = "pcloud-password-*"


def _parse_key_material(raw: str) -> bytes:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty key")
    if len(text) == 64 and all(c in "0123456789abcdefABCDEF" for c in text):
        key = bytes.fromhex(text)
    else:
        try:
            key = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("NOTES_PCLOUD_CREDENTIALS_KEY must be 32-byte hex or base64") from exc
    if len(key) != 32:
        raise ValueError("NOTES_PCLOUD_CREDENTIALS_KEY must decode to 32 bytes")
    return key


def credentials_encryption_key() -> bytes | None:
    raw = os.environ.get(ENV_KEY, "").strip()
    if not raw:
        return None
    return _parse_key_material(raw)


def require_credentials_encryption_key() -> bytes:
    key = credentials_encryption_key()
    if key is None:
        raise RuntimeError(
            f"{ENV_KEY} is not set. Add a 32-byte key to config/deeperguard.env "
            "(see deploy/deeperguard.env.example)."
        )
    return key


def encrypt_at_rest(plaintext: str) -> str:
    plain = str(plaintext or "")
    if not plain:
        return ""
    key = require_credentials_encryption_key()
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain.encode("utf-8"), None)
    blob = base64.b64encode(iv + ct).decode("ascii")
    return f"{ENVELOPE_PREFIX}{blob}"


def decrypt_at_rest(stored: str) -> str:
    text = str(stored or "").strip()
    if not text:
        return ""
    if not text.startswith(ENVELOPE_PREFIX):
        return text
    key = require_credentials_encryption_key()
    raw = base64.b64decode(text[len(ENVELOPE_PREFIX) :], validate=True)
    if len(raw) < 13:
        raise ValueError("corrupt pCloud credential blob")
    iv, ct = raw[:12], raw[12:]
    return AESGCM(key).decrypt(iv, ct, None).decode("utf-8")


def stored_token_is_encrypted(stored: str) -> bool:
    return str(stored or "").strip().startswith(ENVELOPE_PREFIX)


def legacy_password_path(user_id: int, keys_dir: Path) -> Path:
    return keys_dir / f"pcloud-password-{int(user_id)}"


def legacy_rclone_config_path(user_id: int, keys_dir: Path) -> Path:
    return keys_dir / f"pcloud-rclone-{int(user_id)}.conf"


def remove_legacy_password_file(user_id: int, keys_dir: Path) -> bool:
    path = legacy_password_path(user_id, keys_dir)
    if not path.is_file():
        return False
    try:
        path.unlink()
        log.warning(
            "Removed legacy plaintext pCloud password file for user_id=%s (WebDAV password auth is disabled)",
            user_id,
        )
        return True
    except OSError as exc:
        log.error("Could not remove legacy pCloud password file user_id=%s: %s", user_id, exc)
        return False


def remove_legacy_rclone_config(user_id: int, keys_dir: Path) -> None:
    path = legacy_rclone_config_path(user_id, keys_dir)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def migrate_token_file(token_path: Path) -> None:
    if not token_path.is_file():
        return
    raw = token_path.read_text(encoding="utf-8").strip()
    if not raw or stored_token_is_encrypted(raw):
        return
    encrypted = encrypt_at_rest(raw)
    token_path.write_text(encrypted, encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except OSError:
        pass
    log.info("Re-encrypted pCloud OAuth token at %s", token_path.name)


def migrate_user_pcloud_secrets(user_id: int, keys_dir: Path) -> None:
    remove_legacy_password_file(user_id, keys_dir)
    remove_legacy_rclone_config(user_id, keys_dir)
    migrate_token_file(keys_dir / f"pcloud-token-{int(user_id)}")


def migrate_all_pcloud_secrets(keys_dir: Path) -> None:
    if not keys_dir.is_dir():
        return
    if credentials_encryption_key() is None:
        return
    for path in keys_dir.glob("pcloud-password-*"):
        try:
            uid = int(path.name.rsplit("-", 1)[-1])
        except ValueError:
            continue
        remove_legacy_password_file(uid, keys_dir)
    for path in keys_dir.glob("pcloud-token-*"):
        migrate_token_file(path)
    for path in keys_dir.glob("pcloud-rclone-*.conf"):
        try:
            path.unlink()
        except OSError:
            pass


def assert_keys_dir_has_no_plaintext_passwords(keys_dir: Path) -> None:
    if not keys_dir.is_dir():
        return
    for path in keys_dir.glob(_LEGACY_PASSWORD_GLOB):
        raise AssertionError(f"plaintext pCloud password file must not exist: {path}")


def assert_token_file_not_plaintext(token_path: Path) -> None:
    if not token_path.is_file():
        return
    raw = token_path.read_text(encoding="utf-8").strip()
    if raw and not stored_token_is_encrypted(raw):
        raise AssertionError(f"pCloud token must be encrypted at rest: {token_path}")
