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
RECOVERY_MAX_FAILED = 5
RECOVERY_LOCK_BASE_SECONDS = 900
RECOVERY_LOCK_MAX_SECONDS = 86400
PENDING_REKEY_TTL_SECONDS = 86400

_KEY_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_PROOF_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RECOVERY_PUT_FIELDS = frozenset(
    {"expected_key_rev", "key_id", "wrap_version", "recovery_salt", "wrap", "proof_hash", "token", "csrf_token",
     "password_changed_at"}
)
PRF_PUT_FIELDS = frozenset(
    {"expected_key_rev", "key_id", "wrap_version", "prf_salt", "wrap", "token", "csrf_token"}
)
RECOVERY_DELETE_FIELDS = frozenset({"expected_key_rev", "token", "csrf_token"})
RECOVERY_COMMIT_FIELDS = frozenset(
    {"proof", "expected_key_rev", "from_key_id", "to_key_id", "srp_salt", "srp_verifier",
     "srp_kdf_version", "new_recovery", "csrf_token"}
)
RECOVERY_PENDING_FIELDS = frozenset(
    {"proof", "expected_key_rev", "from_key_id", "to_key_id", "wrap_version", "wrap", "csrf_token"}
)
RECOVERY_PENDING_FETCH_FIELDS = frozenset({"proof", "csrf_token"})
_NEW_RECOVERY_FIELDS = frozenset({"recovery_salt", "wrap", "wrap_version", "proof_hash"})
_HEX_RE = re.compile(r"^[0-9a-f]+$")
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


def _wrap_json(wrap: Any) -> tuple[str | None, str]:
    """Canonical JSON of a wrapped 32-byte key, or (None, error message)."""
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
    return wrap_json, ""


def parse_prf_put(body: dict) -> tuple[dict | None, str]:
    """Validate the body of PUT vault-keys/prf/<credential_id>."""
    extra = unexpected_fields(body, PRF_PUT_FIELDS)
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
    if _b64(body.get("prf_salt"), size=32) is None:
        return None, "invalid prf_salt"
    wrap_json, problem = _wrap_json(body.get("wrap"))
    if wrap_json is None:
        return None, problem
    return {
        "expected_key_rev": rev, "key_id": key_id, "wrap_version": version,
        "prf_salt": body["prf_salt"], "wrap_json": wrap_json,
    }, ""


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
    wrap_json, problem = _wrap_json(body.get("wrap"))
    if wrap_json is None:
        return None, problem
    # Password-change time the writing device holds its vault key for (0 = not stated).
    pca = body.get("password_changed_at", 0)
    if isinstance(pca, bool) or not isinstance(pca, (int, float)) or not 0 <= pca < 1e11:
        return None, "invalid password_changed_at"
    return {
        "expected_key_rev": rev,
        "key_id": key_id,
        "key_password_changed_at": float(pca),
        "wrap_version": version,
        "recovery_salt": body["recovery_salt"],
        "wrap_json": wrap_json,
        "proof_hash": proof_hash,
    }, ""


def lock_seconds(level: int) -> int:
    """Lock length after the 5th failure at the given lock level (3.3): 900 * 2^level, capped."""
    return min(RECOVERY_LOCK_MAX_SECONDS, RECOVERY_LOCK_BASE_SECONDS * (2 ** max(0, min(int(level), 16))))


def parse_recovery_commit(body: dict) -> tuple[dict | None, str]:
    """Validate the body of recover/commit. `proof` stays a hex string of 32 raw bytes."""
    extra = unexpected_fields(body, RECOVERY_COMMIT_FIELDS)
    if extra:
        return None, "unexpected field: " + ", ".join(extra)
    proof = body.get("proof")
    if not isinstance(proof, str) or not re.fullmatch(r"[0-9a-f]{64}", proof):
        return None, "invalid proof"
    from_key_id, to_key_id = body.get("from_key_id"), body.get("to_key_id")
    if not valid_key_id(from_key_id) or not valid_key_id(to_key_id):
        return None, "invalid key_id"
    srp_salt, srp_verifier = body.get("srp_salt"), body.get("srp_verifier")
    for value in (srp_salt, srp_verifier):
        if not isinstance(value, str) or not _HEX_RE.match(value) or len(value) > 1024:
            return None, "invalid srp verifier"
    if body.get("srp_kdf_version") != 2:
        return None, "srp_kdf_version 2 required"
    new = body.get("new_recovery")
    if not isinstance(new, dict) or set(new) != _NEW_RECOVERY_FIELDS:
        return None, "invalid new_recovery"
    fields, problem = parse_recovery_put({
        "expected_key_rev": body.get("expected_key_rev"), "key_id": to_key_id, **new,
    })
    if fields is None:
        return None, problem
    fields.pop("key_id")
    fields.pop("key_password_changed_at")
    return {
        **fields, "proof": proof, "from_key_id": from_key_id, "to_key_id": to_key_id,
        "srp_salt": srp_salt, "srp_verifier": srp_verifier,
    }, ""


def _parse_proof(body: dict) -> str | None:
    proof = body.get("proof")
    return proof if isinstance(proof, str) and re.fullmatch(r"[0-9a-f]{64}", proof) else None


def parse_pending_fetch(body: dict) -> tuple[dict | None, str]:
    extra = unexpected_fields(body, RECOVERY_PENDING_FETCH_FIELDS)
    if extra:
        return None, "unexpected field: " + ", ".join(extra)
    proof = _parse_proof(body)
    if proof is None:
        return None, "invalid proof"
    return {"proof": proof}, ""


def parse_recovery_pending(body: dict) -> tuple[dict | None, str]:
    """Validate the body of recover/pending. The wrap (new VK under old VK) stays opaque."""
    extra = unexpected_fields(body, RECOVERY_PENDING_FIELDS)
    if extra:
        return None, "unexpected field: " + ", ".join(extra)
    proof = _parse_proof(body)
    if proof is None:
        return None, "invalid proof"
    from_key_id, to_key_id = body.get("from_key_id"), body.get("to_key_id")
    if not valid_key_id(from_key_id) or not valid_key_id(to_key_id):
        return None, "invalid key_id"
    if body.get("wrap_version") != WRAP_VERSION:
        return None, "invalid wrap_version"
    # Same shape rules as the recovery wrap; the salt and proof hash are placeholders here.
    fields, problem = parse_recovery_put({
        "expected_key_rev": body.get("expected_key_rev"), "key_id": to_key_id,
        "wrap_version": WRAP_VERSION, "wrap": body.get("wrap"),
        "recovery_salt": base64.b64encode(bytes(16)).decode("ascii"), "proof_hash": "0" * 64,
    })
    if fields is None:
        return None, problem
    return {
        "proof": proof, "expected_key_rev": fields["expected_key_rev"],
        "from_key_id": from_key_id, "to_key_id": to_key_id, "wrap_json": fields["wrap_json"],
    }, ""
