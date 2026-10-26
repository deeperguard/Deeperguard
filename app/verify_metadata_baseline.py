"""Versioned /verify metadata baseline: what each in-app action typically sends."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_BASELINE_PATH = Path(__file__).resolve().parent / "verify-metadata-baseline.json"


def baseline_path() -> Path:
    return _BASELINE_PATH


def load_baseline() -> dict[str, Any]:
    path = baseline_path()
    if not path.is_file():
        return {
            "schema_version": 1,
            "baseline_version": 0,
            "release_tag": "",
            "generated_at": "",
            "generation": "missing",
            "actions": [],
        }
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def template_context() -> dict[str, Any]:
    data = load_baseline()
    return {
        "verify_metadata_baseline": data,
        "verify_metadata_baseline_version": int(data.get("baseline_version") or 0),
        "verify_metadata_release_tag": str(data.get("release_tag") or ""),
    }
