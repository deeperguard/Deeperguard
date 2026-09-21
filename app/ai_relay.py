"""Relay for Ollama Cloud (ollama.com) chat requests.

Browsers cannot call ollama.com directly (it sends no CORS headers), so the
signed-in client posts its request here and we forward it verbatim, with the
user's own API key from the ``X-Ollama-Key`` header. Nothing is stored or
logged: not the key, not the prompt, not the answer. The upstream host is fixed
so this cannot be used to reach anything else.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

UPSTREAM = "https://ollama.com"
MAX_BODY_BYTES = 512 * 1024
MAX_MESSAGES = 40
CHAT_TIMEOUT = 120
INFO_TIMEOUT = 20
ALLOWED_CHAT_FIELDS = {"model", "messages", "options", "think"}
ALLOWED_INFO_PATHS = {"ps": "/api/ps", "tags": "/api/tags"}


class RelayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def sanitize_chat_body(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RelayError(400, "JSON object required")
    model = str(raw.get("model") or "").strip()
    if not model or len(model) > 200:
        raise RelayError(400, "model required")
    messages = raw.get("messages")
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        raise RelayError(400, "messages required")
    clean_messages = []
    for msg in messages:
        if not isinstance(msg, dict):
            raise RelayError(400, "invalid message")
        role = str(msg.get("role") or "")
        if role not in {"system", "user", "assistant"}:
            raise RelayError(400, "invalid message role")
        clean_messages.append({"role": role, "content": str(msg.get("content") or "")})
    body = {"model": model, "messages": clean_messages, "stream": False}
    options = raw.get("options")
    if isinstance(options, dict):
        body["options"] = {k: v for k, v in options.items() if isinstance(v, (int, float, str, bool))}
    if "think" in raw and isinstance(raw["think"], (bool, str)):
        body["think"] = raw["think"]
    unknown = set(raw) - ALLOWED_CHAT_FIELDS - {"stream"}
    if unknown:
        raise RelayError(400, f"unsupported field: {sorted(unknown)[0]}")
    return body


def _forward(method: str, path: str, api_key: str, body: dict | None, timeout: int) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data is not None and len(data) > MAX_BODY_BYTES:
        raise RelayError(413, "request too large")
    req = urllib.request.Request(f"{UPSTREAM}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "deeperguard-notes")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - fixed https host
            return res.status, _parse(res.read())
    except urllib.error.HTTPError as err:
        payload = _parse(err.read())
        message = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(message, dict):
            message = message.get("message")
        return err.code, {"error": str(message or err.reason or err.code), "upstream": True}
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        reason = getattr(err, "reason", None) or err
        if "timed out" in str(reason).lower():
            raise RelayError(504, "Ollama Cloud did not answer in time") from err
        raise RelayError(502, "Could not reach ollama.com") from err


def _parse(raw: bytes) -> dict:
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"error": "invalid response from ollama.com", "upstream": True}
    return parsed if isinstance(parsed, dict) else {"data": parsed}


def chat(api_key: str, raw_body: object, *, forward=None) -> tuple[int, dict]:
    key = str(api_key or "").strip()
    if not key:
        raise RelayError(401, "Ollama API key required")
    body = sanitize_chat_body(raw_body)
    return (forward or _forward)("POST", "/api/chat", key, body, CHAT_TIMEOUT)


def info(api_key: str, what: str, *, forward=None) -> tuple[int, dict]:
    key = str(api_key or "").strip()
    if not key:
        raise RelayError(401, "Ollama API key required")
    path = ALLOWED_INFO_PATHS.get(what)
    if not path:
        raise RelayError(404, "not found")
    return (forward or _forward)("GET", path, key, None, INFO_TIMEOUT)
