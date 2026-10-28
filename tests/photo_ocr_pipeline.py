"""Simulate v0.65.28 vs #256 on-device photo OCR pipelines for fixture tests.

Uses the same preprocess JS as the browser and local ``tesseract`` with vendored
eng+nld traineddata. Nothing is uploaded.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APPLY = REPO / "tests" / "apply_photo_preprocess.js"
LANG_DIR = REPO / "app" / "static" / "js" / "vendor" / "tesseract" / "lang"

# v0.65.28 client: deskew preprocess (no unsharp), primary + strong binarize, raw PSM 6.
PIPELINE_V6528 = (
    ("primary_v65", 4),
    ("strong_v65", 4),
    ("raw", 6),
)

# #256 client: sharpen preprocess, gray + auto PSM retries, sparse gray pass.
PIPELINE_ENHANCED_256 = (
    ("primary", 4),
    ("strong", 4),
    ("gray", 4),
    ("primary", 3),
    ("raw", 6),
    ("gray", 11),
)


def write_rgba(path: Path, image) -> None:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    path.write_bytes(struct.pack("<II", w, h) + rgba.tobytes())


def tessdata_dir() -> Path:
    dest = Path(tempfile.gettempdir()) / "deeperguard-tessdata"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("eng", "nld"):
        gz = LANG_DIR / f"{name}.traineddata.gz"
        out = dest / f"{name}.traineddata"
        if out.exists() and out.stat().st_size > 1000:
            continue
        if not gz.exists():
            raise FileNotFoundError(gz)
        with out.open("wb") as handle:
            subprocess.run(["gzip", "-dc", str(gz)], check=True, stdout=handle)
    return dest


def tesseract_bin() -> str:
    binary = shutil.which("tesseract")
    if not binary:
        raise RuntimeError("tesseract is not installed")
    return binary


def preprocess_rgba(rgba_path: Path, ppm_path: Path, mode: str) -> None:
    subprocess.run(
        ["node", str(APPLY), str(rgba_path), str(ppm_path), mode],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )


def run_tesseract(ppm_path: Path, data_dir: Path, psm: int) -> str:
    env = dict(os.environ)
    env["TESSDATA_PREFIX"] = str(data_dir)
    completed = subprocess.run(
        [tesseract_bin(), str(ppm_path), "stdout", "-l", "eng+nld", "--psm", str(psm), "--dpi", "300"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout


def ocr_pass(image, mode: str, psm: int, work: Path, data_dir: Path) -> str:
    work.mkdir(parents=True, exist_ok=True)
    rgba = work / f"{mode}-psm{psm}.rgba"
    ppm = work / f"{mode}-psm{psm}.ppm"
    write_rgba(rgba, image)
    preprocess_rgba(rgba, ppm, mode)
    return run_tesseract(ppm, data_dir, psm).strip()


def token_recall(text: str, words: tuple[str, ...]) -> float:
    found = set(re.findall(r"[a-z0-9]+", text.lower()))
    hits = sum(1 for word in words if word in found)
    return hits / max(1, len(words))


def pipeline_best_recall(image, passes, words, work: Path, data_dir: Path) -> tuple[float, str]:
    best_recall = 0.0
    best_text = ""
    for mode, psm in passes:
        text = ocr_pass(image, mode, psm, work, data_dir)
        score = token_recall(text, words)
        if score > best_recall:
            best_recall = score
            best_text = text
    return best_recall, best_text


def pipeline_v6528_recall(image, words, work: Path, data_dir: Path) -> tuple[float, str]:
    return pipeline_best_recall(image, PIPELINE_V6528, words, work, data_dir)


def pipeline_enhanced256_recall(image, words, work: Path, data_dir: Path) -> tuple[float, str]:
    return pipeline_best_recall(image, PIPELINE_ENHANCED_256, words, work, data_dir)
