#!/usr/bin/env python3
"""Write committed JPEG fixtures under tests/fixtures/photo-ocr/."""
from __future__ import annotations

import json
from pathlib import Path

from photo_ocr_fixtures import BETA_FAIL_PASS_FIXTURES, FIXTURE_JPEG_QUALITY, generate_fixture_jpeg

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "tests" / "fixtures" / "photo-ocr"
LEGACY = (
    "beta-receipt-soft-blur.jpg",
    "beta-receipt-glare-blur.jpg",
)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in LEGACY:
        legacy = OUT / name
        if legacy.is_file():
            legacy.unlink()
    manifest = []
    for fx in BETA_FAIL_PASS_FIXTURES:
        path = OUT / fx.filename
        image = fx.build_image()
        generate_fixture_jpeg(image, path)
        manifest.append(
            {
                "id": fx.id,
                "file": fx.filename,
                "description": fx.description,
                "search_tokens": list(fx.search_tokens),
                "pass_rule": "all search_tokens in OCR text (accent-insensitive); v0.65.28 pipeline sim must fail, #256 sim must pass",
            }
        )
    (OUT / "beta-fail-pass.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(manifest)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
