#!/usr/bin/env python3
"""Build a deterministic client asset manifest (SHA-256 + SRI) for Deeperguard.

The frontend is plain static JS/CSS (no bundler). This script hashes every
shipped client script/stylesheet under app/static/{js,css}, writes
app/static/client-manifest.json, and optionally verifies a second build.

Environment:
  SOURCE_DATE_EPOCH  Unix timestamp embedded as manifest \"created\" (default: 0)
  NOTES_CLIENT_OUT   Override output path for the manifest JSON

Usage:
  python3 scripts/build-client-manifest.py
  python3 scripts/build-client-manifest.py --check-repro
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "app" / "static"
DEFAULT_OUT = STATIC / "client-manifest.json"

# Client code covered by the integrity manifest. Vendor OCR/PDF stacks are
# included so a release attests the full browser-side surface.
INCLUDE_ROOTS = ("js", "css")
INCLUDE_SUFFIXES = {".js", ".css", ".mjs"}


def _source_date_epoch() -> int:
    raw = (os.environ.get("SOURCE_DATE_EPOCH") or "0").strip()
    try:
        return int(raw)
    except ValueError:
        return 0


def _iter_assets() -> list[Path]:
    found: list[Path] = []
    for root in INCLUDE_ROOTS:
        base = STATIC / root
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in INCLUDE_SUFFIXES:
                continue
            # Skip build outputs, AppleDouble junk, and editor swap files.
            if path.name == "client-manifest.json":
                continue
            if path.name.startswith("._") or path.name.endswith("~"):
                continue
            found.append(path)
    return found


def _sri_sha384(data: bytes) -> str:
    digest = hashlib.sha384(data).digest()
    return "sha384-" + base64.b64encode(digest).decode("ascii")


def _logical_key(path: Path) -> str:
    return path.relative_to(STATIC).as_posix()


def _hashed_url(logical: str, sha256_hex: str) -> str:
    """Content-hashed filename: js/app.js + abcd… → /static/js/app.abcd….js"""
    path = Path(logical)
    stem = path.stem  # app
    suffix = path.suffix  # .js
    parent = path.parent.as_posix()
    short = sha256_hex[:16]
    name = f"{stem}.{short}{suffix}"
    if parent in ("", "."):
        return f"/static/{name}"
    return f"/static/{parent}/{name}"


def build_manifest() -> dict:
    assets: dict[str, dict] = {}
    for path in _iter_assets():
        data = path.read_bytes()
        sha256_hex = hashlib.sha256(data).hexdigest()
        logical = _logical_key(path)
        assets[logical] = {
            "sha256": sha256_hex,
            "sri": _sri_sha384(data),
            "url": _hashed_url(logical, sha256_hex),
            "bytes": len(data),
        }
    # Canonical digest over sorted logical→sha256 pairs (byte-identical builds).
    lines = [f"{key}:{assets[key]['sha256']}" for key in sorted(assets)]
    payload = "\n".join(lines).encode("utf-8")
    manifest_sha256 = hashlib.sha256(payload).hexdigest()
    return {
        "version": 1,
        "created": _source_date_epoch(),
        "manifest_sha256": manifest_sha256,
        "asset_count": len(assets),
        "assets": {key: assets[key] for key in sorted(assets)},
    }


def write_manifest(doc: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(os.environ.get("NOTES_CLIENT_OUT") or DEFAULT_OUT),
        help="Manifest output path",
    )
    parser.add_argument(
        "--check-repro",
        action="store_true",
        help="Build twice into temp dirs and require identical manifest_sha256",
    )
    parser.add_argument(
        "--print-hash",
        action="store_true",
        help="Print only manifest_sha256",
    )
    args = parser.parse_args()

    if args.check_repro:
        with tempfile.TemporaryDirectory(prefix="dg-client-a-") as a, tempfile.TemporaryDirectory(
            prefix="dg-client-b-"
        ) as b:
            out_a = Path(a) / "client-manifest.json"
            out_b = Path(b) / "client-manifest.json"
            doc_a = build_manifest()
            doc_b = build_manifest()
            write_manifest(doc_a, out_a)
            write_manifest(doc_b, out_b)
            ha = doc_a["manifest_sha256"]
            hb = doc_b["manifest_sha256"]
            if ha != hb or out_a.read_bytes() != out_b.read_bytes():
                print(f"repro check FAILED: {ha} != {hb}", file=sys.stderr)
                return 1
            print(f"repro check ok manifest_sha256={ha}")
            return 0

    doc = build_manifest()
    write_manifest(doc, args.output)
    if args.print_hash:
        print(doc["manifest_sha256"])
    else:
        print(
            f"wrote {args.output} assets={doc['asset_count']} "
            f"manifest_sha256={doc['manifest_sha256']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
