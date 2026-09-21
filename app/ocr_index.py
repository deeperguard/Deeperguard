"""Server-side OCR helpers — ephemeral by default (no plaintext at rest)."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path
from typing import Any

from config import DATA_DIR, ocr_ephemeral

import ocr as ocr_mod

INDEX_VERSION = 59
ATT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,80}$")


def ocr_root(user_id: int) -> Path:
    return DATA_DIR / "ocr" / str(int(user_id))


def safe_att_id(value: str | None) -> str:
    raw = str(value or "").strip()
    if not ATT_ID_RE.match(raw):
        return ""
    return raw


def _doc_dir(user_id: int, att_id: str) -> Path:
    return ocr_root(user_id) / att_id


def _public(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "att_id": meta.get("att_id") or "",
        "filename": meta.get("filename") or "document",
        "mime": meta.get("mime") or "",
        "sha256": meta.get("sha256") or "",
        "text": meta.get("text") or "",
        "method": meta.get("method") or "",
        "boxes": meta.get("boxes") if isinstance(meta.get("boxes"), list) else [],
        "index_version": int(meta.get("index_version") or 0),
        "updated_at": float(meta.get("updated_at") or 0),
    }


def extract_response(
    user_id: int,
    att_id: str,
    filename: str,
    mime: str,
    data: bytes,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Build an OCR API payload without writing plaintext to disk."""
    del user_id  # reserved for future per-user policy hooks
    att_id = safe_att_id(att_id)
    return _public({
        "att_id": att_id,
        "filename": filename or "document",
        "mime": mime or "",
        "sha256": hashlib.sha256(data).hexdigest() if data else "",
        **(result or {}),
        "index_version": INDEX_VERSION,
        "updated_at": time.time(),
    })


def delete_document(user_id: int, att_id: str) -> bool:
    att_id = safe_att_id(att_id)
    if not att_id:
        return False
    folder = _doc_dir(user_id, att_id)
    if not folder.is_dir():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True


def purge_legacy_plaintext_indexes() -> int:
    """Remove persisted OCR plaintext indexes left from older builds."""
    root = DATA_DIR / "ocr"
    if not root.is_dir():
        return 0
    removed = 0
    for user_dir in root.iterdir():
        if not user_dir.is_dir():
            continue
        for folder in user_dir.iterdir():
            if not folder.is_dir():
                continue
            meta = folder / "meta.json"
            if meta.is_file():
                try:
                    meta.unlink()
                    removed += 1
                except OSError:
                    pass
            file_path = folder / "file"
            if file_path.is_file():
                try:
                    file_path.unlink()
                except OSError:
                    pass
            try:
                if folder.is_dir() and not any(folder.iterdir()):
                    folder.rmdir()
            except OSError:
                pass
    return removed


def save_document(
    user_id: int,
    att_id: str,
    filename: str,
    mime: str,
    data: bytes,
    result: dict[str, Any],
) -> dict[str, Any]:
    if ocr_ephemeral():
        return extract_response(user_id, att_id, filename, mime, data, result)
    att_id = safe_att_id(att_id)
    if not att_id:
        return _public({
            "filename": filename,
            "mime": mime,
            **(result or {}),
            "index_version": INDEX_VERSION,
            "updated_at": time.time(),
        })
    folder = _doc_dir(user_id, att_id)
    folder.mkdir(parents=True, exist_ok=True)
    if data:
        (folder / "file").write_bytes(data)
    meta = {
        "att_id": att_id,
        "filename": filename or "document",
        "mime": mime or "",
        "sha256": hashlib.sha256(data).hexdigest(),
        "text": str((result or {}).get("text") or ""),
        "method": str((result or {}).get("method") or ""),
        "boxes": (result or {}).get("boxes") if isinstance((result or {}).get("boxes"), list) else [],
        "index_version": INDEX_VERSION,
        "updated_at": time.time(),
    }
    (folder / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    method = str(meta.get("method") or "")
    if method and method not in {"", "failed"}:
        try:
            (folder / "file").unlink(missing_ok=True)
        except OSError:
            pass
    return _public(meta)


def save_file_only(
    user_id: int,
    att_id: str,
    filename: str,
    mime: str,
    data: bytes,
) -> dict[str, Any]:
    """Store file bytes for an offline OCR queue without plaintext meta."""
    att_id = safe_att_id(att_id)
    if not att_id:
        return {"att_id": "", "stored": False, "bytes": 0}
    if ocr_ephemeral():
        folder = _doc_dir(user_id, att_id)
        folder.mkdir(parents=True, exist_ok=True)
        if data:
            (folder / "file").write_bytes(data)
        return {"att_id": att_id, "stored": True, "bytes": len(data)}
    return save_document(
        user_id,
        att_id,
        filename,
        mime,
        data,
        {"text": "", "method": "", "boxes": []},
    )


def load_meta(user_id: int, att_id: str) -> dict[str, Any] | None:
    att_id = safe_att_id(att_id)
    if not att_id:
        return None
    path = _doc_dir(user_id, att_id) / "meta.json"
    if not path.is_file():
        return None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(meta, dict):
        return None
    meta["att_id"] = att_id
    return meta


def load_file(user_id: int, att_id: str) -> bytes | None:
    att_id = safe_att_id(att_id)
    if not att_id:
        return None
    path = _doc_dir(user_id, att_id) / "file"
    if not path.is_file():
        return None
    return path.read_bytes()


def list_index(user_id: int) -> list[dict[str, Any]]:
    if ocr_ephemeral():
        return []
    root = ocr_root(user_id)
    if not root.is_dir():
        return []
    items = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        meta = load_meta(user_id, folder.name)
        if meta:
            items.append(_public(meta))
    return items


def reindex_user(user_id: int) -> dict[str, Any]:
    if ocr_ephemeral():
        return {
            "ok": True,
            "ephemeral": True,
            "count": 0,
            "errors": 0,
            "index_version": INDEX_VERSION,
            "items": [],
        }
    items: list[dict[str, Any]] = []
    errors = 0
    for entry in list_index(user_id):
        att_id = entry["att_id"]
        data = load_file(user_id, att_id)
        meta = load_meta(user_id, att_id) or {}
        if not data:
            if meta.get("text") or meta.get("method"):
                items.append(_public(meta))
                continue
            errors += 1
            items.append(entry)
            continue
        try:
            result = ocr_mod.extract(
                str(meta.get("filename") or entry.get("filename") or "document"),
                str(meta.get("mime") or entry.get("mime") or ""),
                data,
            )
            saved = save_document(
                user_id,
                att_id,
                str(meta.get("filename") or "document"),
                str(meta.get("mime") or ""),
                data,
                result,
            )
            if result.get("preview_jpeg_b64"):
                saved["preview_jpeg_b64"] = result["preview_jpeg_b64"]
            items.append(saved)
        except Exception:
            errors += 1
            items.append(save_document(
                user_id,
                att_id,
                str(meta.get("filename") or entry.get("filename") or "document"),
                str(meta.get("mime") or entry.get("mime") or ""),
                b"",
                {"text": "", "method": "failed", "boxes": []},
            ))
    return {
        "ok": True,
        "count": len(items),
        "errors": errors,
        "index_version": INDEX_VERSION,
        "items": items,
    }
