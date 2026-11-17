"""Server-side validation for wrapped vault-key copies (docs/VAULT_RECOVERY.md 1.2, 2.2, 2.3).

The server stores ciphertext and public metadata only. Everything here is shape
checking: the server cannot (and must not be able to) open a wrap.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any

WRAP_VERSION = 1
MAX_WRAP_BYTES = 4096

_KEY_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_PROOF_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RECOVERY_PUT_FIELDS = frozenset(
    {"expected_key_rev", "key_id", "wrap_version", "recovery_salt", "wrap", "proof_hash", "token", "csrf_token"}
)
RECOVERY_DELETE_FIELDS = frozenset({"expected_key_rev", "token", "csrf_token"})
_WRAP_FIELDS = frozenset({"v", "iv", "data"})


def _b64(value: Any, *, size: int | None = None) -> bytes | None:
    if not isinstance(value, str) or not value:
        return None
    pad = "=" * (-len(value) % 4)
    try:
        raw = base64.b64decode(value.replace("-", "+").replace("_", "/") + pad, validate=True)
    except (binascii.Error, ValueError):
        return None
    if size is not None and len(raw) != size:
        return None
    return raw


def unexpected_fields(body: dict, allowed: frozenset[str]) -> list[str]:
    """Names in the body that are not part of the contract (e.g. a clear key field)."""
    return sorted(str(k) for k in body if k not in allowed)


def parse_expected_rev(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def valid_key_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_KEY_ID_RE.match(value))


def parse_recovery_put(body: dict) -> tuple[dict | None, str]:
    """Return (clean fields, "") or (None, error message)."""
    extra = unexpected_fields(body, RECOVERY_PUT_FIELDS)
    if extra:
        return None, "unexpected field: " + ", ".join(extra)
    rev = parse_expected_rev(body.get("expected_key_rev"))
    if rev is None:
        return None, "expected_key_rev must be a non-negative integer"
    key_id = body.get("key_id")
    if not valid_key_id(key_id):
        return None, "invalid key_id"
    version = body.get("wrap_version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        return None, "invalid wrap_version"
    if _b64(body.get("recovery_salt"), size=16) is None:
        return None, "invalid recovery_salt"
    proof_hash = body.get("proof_hash")
    if not isinstance(proof_hash, str) or not _PROOF_HASH_RE.match(proof_hash):
        return None, "invalid proof_hash"
    wrap = body.get("wrap")
    if not isinstance(wrap, dict) or set(wrap) != _WRAP_FIELDS or wrap.get("v") != 2:
        return None, "invalid wrap"
    iv = _b64(wrap.get("iv"), size=12)
    data = _b64(wrap.get("data"))
    # AES-GCM of a 32-byte key: 32 bytes of ciphertext + 16-byte tag.
    if iv is None or data is None or len(data) != 48:
        return None, "invalid wrap"
    wrap_json = json.dumps(
        {"v": 2, "iv": wrap["iv"], "data": wrap["data"]}, separators=(",", ":"), sort_keys=True,
    )
    if len(wrap_json.encode("utf-8")) > MAX_WRAP_BYTES:
        return None, "wrap too large"
    return {
        "expected_key_rev": rev,
        "key_id": key_id,
        "wrap_version": version,
        "recovery_salt": body["recovery_salt"],
        "wrap_json": wrap_json,
        "proof_hash": proof_hash,
    }, ""
