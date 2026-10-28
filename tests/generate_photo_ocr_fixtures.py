#!/usr/bin/env python3
"""Write committed JPEG fixtures under tests/fixtures/photo-ocr/."""
from __future__ import annotations

import json
from pathlib import Path

from photo_ocr_fixtures import BETA_FAIL_PASS_FIXTURES

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "tests" / "fixtures" / "photo-ocr"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for fx in BETA_FAIL_PASS_FIXTURES:
        path = OUT / fx.filename
        image = fx.build_image()
        image.save(path, format="JPEG", quality=95, optimize=True)
        manifest.append(
            {
                "id": fx.id,
                "file": fx.filename,
                "description": fx.description,
                "search_tokens": list(fx.search_tokens),
                "truth_words": list(fx.truth_words),
                "v6528_max_recall": fx.v6528_max_recall,
                "enhanced_min_recall": fx.enhanced_min_recall,
            }
        )
    (OUT / "beta-fail-pass.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(manifest)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
