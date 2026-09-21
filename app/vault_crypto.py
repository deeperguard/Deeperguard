"""Vault key derivation and note decryption (matches static/js/crypto.js)."""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VAULT_KDF_V1 = 1
VAULT_KDF_V2 = 2
ARGON2_PARAMS = {"time_cost": 3, "memory_cost": 65536, "parallelism": 2, "hash_len": 32}


def decode_salt_bytes(salt: str) -> bytes:
    text = str(salt or "").strip()
    if not text:
        return bytes(8)
    try:
        decoded = base64.b64decode(text, validate=False)
        if len(decoded) >= 8:
            return bytes(decoded)
    except Exception:
        pass
    encoded = text.encode("utf-8")
    if len(encoded) >= 8:
        return bytes(encoded)
    padded = bytearray(8)
    padded[: len(encoded)] = encoded
    return bytes(padded)


def derive_raw_v1(password: str, salt: str) -> bytes:
    a = str(password or "").encode("utf-8")
    b = str(salt or "").encode("utf-8")
    return hashlib.sha256(a + b"\x00" + b).digest()


def derive_raw_v2(password: str, salt: str) -> bytes:
    return hash_secret_raw(
        secret=str(password or "").encode("utf-8"),
        salt=decode_salt_bytes(salt),
        type=Type.ID,
        **ARGON2_PARAMS,
    )


def derive_raw(password: str, salt: str, kdf_version: int) -> bytes:
    if int(kdf_version) == VAULT_KDF_V2:
        return derive_raw_v2(password, salt)
    return derive_raw_v1(password, salt)


def encrypt_object(password: str, salt: str, kdf_version: int, obj: dict[str, Any]) -> str:
    import os

    raw = derive_raw(password, salt, kdf_version)
    iv = os.urandom(12)
    plain = json.dumps(obj).encode("utf-8")
    data = AESGCM(raw).encrypt(iv, plain, None)
    payload = {"v": 1, "iv": base64.b64encode(iv).decode("ascii"), "data": base64.b64encode(data).decode("ascii")}
    return json.dumps(payload)


def decrypt_object(password: str, salt: str, kdf_version: int, ciphertext: str) -> dict[str, Any]:
    payload = json.loads(str(ciphertext or ""))
    if not isinstance(payload, dict) or "iv" not in payload or "data" not in payload:
        raise ValueError("invalid ciphertext payload")
    raw = derive_raw(password, salt, kdf_version)
    iv = base64.b64decode(str(payload["iv"]))
    data = base64.b64decode(str(payload["data"]))
    plain = AESGCM(raw).decrypt(iv, data, None)
    obj = json.loads(plain.decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("invalid decrypted note")
    return obj


def password_unlocks_vault(
    password: str,
    *,
    kdf_salt: str,
    vault_kdf_version: int,
    ciphertext: str,
) -> bool:
    primary = int(vault_kdf_version or VAULT_KDF_V1)
    try:
        decrypt_object(password, kdf_salt, primary, ciphertext)
        return True
    except Exception:
        pass
    alt = VAULT_KDF_V2 if primary == VAULT_KDF_V1 else VAULT_KDF_V1
    try:
        decrypt_object(password, kdf_salt, alt, ciphertext)
        return True
    except Exception:
        return False


def password_unlocks_samples(
    password: str,
    *,
    kdf_salt: str,
    vault_kdf_version: int,
    ciphertexts: list[str],
) -> bool:
    for ciphertext in ciphertexts:
        if password_unlocks_vault(
            password,
            kdf_salt=kdf_salt,
            vault_kdf_version=vault_kdf_version,
            ciphertext=ciphertext,
        ):
            return True
    return False
