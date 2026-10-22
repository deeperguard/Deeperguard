"""Client asset integrity helpers (hashed URLs + Subresource Integrity).

Reads app/static/client-manifest.json (produced by scripts/build-client-manifest.py).
If the manifest is missing, builds an in-memory manifest from source files so local
dev and tests still get deterministic hashes and SRI.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
from functools import lru_cache
from pathlib import Path

from markupsafe import Markup

_STATIC = Path(__file__).resolve().parent / "static"
_MANIFEST_PATH = _STATIC / "client-manifest.json"
_HASHED_NAME = re.compile(
    r"^(?P<dir>(?:js|css)(?:/.*)?)/(?P<stem>[^/]+)\.(?P<hash>[a-f0-9]{16})\.(?P<ext>js|css|mjs)$"
)

GITHUB_RELEASES = "https://github.com/deeperguard/Deeperguard/releases"


def _source_date_epoch() -> int:
    raw = (os.environ.get("SOURCE_DATE_EPOCH") or "0").strip()
    try:
        return int(raw)
    except ValueError:
        return 0


def _sri_sha384(data: bytes) -> str:
    digest = hashlib.sha384(data).digest()
    return "sha384-" + base64.b64encode(digest).decode("ascii")


def _hashed_url(logical: str, sha256_hex: str) -> str:
    path = Path(logical)
    short = sha256_hex[:16]
    name = f"{path.stem}.{short}{path.suffix}"
    parent = path.parent.as_posix()
    if parent in ("", "."):
        return f"/static/{name}"
    return f"/static/{parent}/{name}"


def _build_from_source() -> dict:
    """Mirror scripts/build-client-manifest.py (kept small to avoid import cycles)."""
    assets: dict[str, dict] = {}
    for root in ("js", "css"):
        base = _STATIC / root
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".js", ".css", ".mjs"}:
                continue
            if path.name == "client-manifest.json":
                continue
            data = path.read_bytes()
            sha256_hex = hashlib.sha256(data).hexdigest()
            logical = path.relative_to(_STATIC).as_posix()
            assets[logical] = {
                "sha256": sha256_hex,
                "sri": _sri_sha384(data),
                "url": _hashed_url(logical, sha256_hex),
                "bytes": len(data),
            }
    lines = [f"{key}:{assets[key]['sha256']}" for key in sorted(assets)]
    manifest_sha256 = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return {
        "version": 1,
        "created": _source_date_epoch(),
        "manifest_sha256": manifest_sha256,
        "asset_count": len(assets),
        "assets": {key: assets[key] for key in sorted(assets)},
    }


@lru_cache(maxsize=1)
def load_manifest() -> dict:
    env_path = (os.environ.get("NOTES_CLIENT_MANIFEST") or "").strip()
    path = Path(env_path) if env_path else _MANIFEST_PATH
    if path.is_file():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(doc, dict) and doc.get("assets") and doc.get("manifest_sha256"):
                return doc
        except (OSError, json.JSONDecodeError):
            pass
    return _build_from_source()


def reload_manifest() -> dict:
    load_manifest.cache_clear()
    return load_manifest()


def client_hash() -> str:
    return str(load_manifest().get("manifest_sha256") or "")


def client_hash_short() -> str:
    full = client_hash()
    return full[:16] if full else ""


def release_tag() -> str:
    """Optional published tag (v1.2.3). Empty when not set."""
    env = (os.environ.get("NOTES_RELEASE_TAG") or "").strip()
    if env:
        return env
    tag_path = Path(os.environ.get("NOTES_ROOT", "/opt/deeperguard")) / "RELEASE_TAG"
    try:
        value = tag_path.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    version_tag = _STATIC.parent.parent / "RELEASE_TAG"
    try:
        value = version_tag.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    return ""


def release_url() -> str:
    tag = release_tag()
    if tag:
        return f"{GITHUB_RELEASES}/tag/{tag}"
    # Fall back to the releases list until the first tag exists.
    return GITHUB_RELEASES


def asset_info(logical: str) -> dict | None:
    key = logical.lstrip("/")
    if key.startswith("static/"):
        key = key[len("static/") :]
    assets = load_manifest().get("assets") or {}
    info = assets.get(key)
    if info:
        return info
    # Allow callers to pass js/foo.js or /static/js/foo.js
    return assets.get(key.removeprefix("static/"))


def asset_url(logical: str, *, fallback_build: str = "") -> str:
    info = asset_info(logical)
    if info and info.get("url"):
        return str(info["url"])
    key = logical.lstrip("/")
    if key.startswith("static/"):
        key = key[len("static/") :]
    q = f"?v={fallback_build}" if fallback_build else ""
    return f"/static/{key}{q}"


def asset_sri(logical: str) -> str:
    info = asset_info(logical)
    return str(info.get("sri") or "") if info else ""


def asset_script(logical: str, *, defer: bool = False, async_: bool = False) -> Markup:
    url = asset_url(logical)
    sri = asset_sri(logical)
    attrs = [f'src="{url}"']
    if sri:
        attrs.append(f'integrity="{sri}"')
        attrs.append('crossorigin="anonymous"')
    if defer:
        attrs.append("defer")
    if async_:
        attrs.append("async")
    return Markup(f"<script {' '.join(attrs)}></script>")


def asset_stylesheet(logical: str) -> Markup:
    url = asset_url(logical)
    sri = asset_sri(logical)
    attrs = [f'rel="stylesheet"', f'href="{url}"']
    if sri:
        attrs.append(f'integrity="{sri}"')
        attrs.append('crossorigin="anonymous"')
    return Markup(f"<link {' '.join(attrs)}>")


def resolve_hashed_static(path: str) -> str | None:
    """Map /static/js/app.<hash16>.js → js/app.js when the hash matches the manifest."""
    if not path.startswith("/static/"):
        return None
    rel = path[len("/static/") :]
    match = _HASHED_NAME.match(rel)
    if not match:
        return None
    logical = f"{match.group('dir')}/{match.group('stem')}.{match.group('ext')}"
    # dir may be "js" or "js/vendor/…" — Path normalization
    logical = str(Path(match.group("dir")) / f"{match.group('stem')}.{match.group('ext')}")
    logical = logical.replace("\\", "/")
    info = asset_info(logical)
    if not info:
        return None
    if not str(info.get("sha256", "")).startswith(match.group("hash")):
        return None
    return logical


def ensure_manifest_file() -> Path:
    """Write app/static/client-manifest.json if missing (deploy / first boot)."""
    doc = _build_from_source()
    _MANIFEST_PATH.write_text(
        json.dumps(doc, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    reload_manifest()
    return _MANIFEST_PATH


def jinja_globals() -> dict:
    # Callables for templates. Scalar values (client_hash, release_url, …)
    # are injected by app._inject_template_globals so Jinja does not print
    # "<function client_hash …>".
    return {
        "asset_script": asset_script,
        "asset_stylesheet": asset_stylesheet,
        "asset_url": asset_url,
        "asset_sri": asset_sri,
    }


def _main_write() -> int:
    path = ensure_manifest_file()
    print(f"wrote {path} manifest_sha256={client_hash()}")
    return 0


if __name__ == "__main__":
    # Allow `python3 -m client_assets` from app/ for quick regen.
    sys.exit(_main_write())
