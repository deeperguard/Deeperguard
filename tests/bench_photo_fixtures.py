#!/usr/bin/env python3
"""Tune photo OCR fixtures: v0.65.28 pipeline vs enhanced (#256)."""
from __future__ import annotations

import importlib.util
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parents[1]
APPLY = REPO / "tests" / "apply_photo_preprocess.js"
LANG_DIR = REPO / "app" / "static" / "js" / "vendor" / "tesseract" / "lang"

_spec = importlib.util.spec_from_file_location("photo_ocr_quality", REPO / "tests" / "test_photo_ocr_quality.py")
_mod = importlib.util.module_from_spec(_spec)
sys.modules["photo_ocr_quality"] = _mod
_spec.loader.exec_module(_mod)

TRUTH_WORDS = _mod.TRUTH_WORDS
make_hard = _mod.make_hard
render_page = _mod.render_page
_noise = _mod._noise


def font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def write_rgba(path: Path, image: Image.Image) -> None:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    path.write_bytes(struct.pack("<II", w, h) + rgba.tobytes())


def tessdata() -> Path:
    import os

    dest = Path(tempfile.gettempdir()) / "deeperguard-tessdata"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("eng", "nld"):
        gz = LANG_DIR / f"{name}.traineddata.gz"
        out = dest / f"{name}.traineddata"
        if out.exists() and out.stat().st_size > 1000:
            continue
        with out.open("wb") as handle:
            subprocess.run(["gzip", "-dc", str(gz)], check=True, stdout=handle)
    return dest


def run_tesseract(ppm: Path, data_dir: Path, psm: int) -> str:
    import os

    env = dict(os.environ)
    env["TESSDATA_PREFIX"] = str(data_dir)
    completed = subprocess.run(
        ["tesseract", str(ppm), "stdout", "-l", "eng+nld", "--psm", str(psm), "--dpi", "300"],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    return completed.stdout if completed.returncode == 0 else ""


def preprocess(rgba_path: Path, ppm_path: Path, mode: str) -> None:
    subprocess.run(
        ["node", str(APPLY), str(rgba_path), str(ppm_path), mode],
        check=True,
        capture_output=True,
        timeout=120,
    )


def ocr_image(image: Image.Image, mode: str, psm: int, work: Path, data_dir: Path) -> str:
    work.mkdir(parents=True, exist_ok=True)
    rgba = work / f"{mode}-{psm}.rgba"
    ppm = work / f"{mode}-{psm}.ppm"
    write_rgba(rgba, image)
    preprocess(rgba, ppm, mode)
    return run_tesseract(ppm, data_dir, psm).strip()


def recall(text: str, words: tuple[str, ...]) -> float:
    import re

    found = set(re.findall(r"[a-z0-9]+", text.lower()))
    hits = sum(1 for w in words if w in found)
    return hits / max(1, len(words))


def pipeline_v65(image, words, work, data_dir):
    passes = [("primary_v65", 4), ("strong_v65", 4), ("raw", 6)]
    return max(recall(ocr_image(image, m, p, work, data_dir), words) for m, p in passes)


def pipeline_enhanced(image, words, work, data_dir):
    passes = [
        ("primary", 4),
        ("strong", 4),
        ("gray", 4),
        ("primary", 3),
        ("raw", 6),
        ("gray", 11),
    ]
    return max(recall(ocr_image(image, m, p, work, data_dir), words) for m, p in passes)


RECEIPT_LINES = (
    "Kiosk Amsterdam Centraal",
    "BTW NL123456789B01",
    "Subtotaal 14,50 EUR",
    "Betaald Visa contactloos",
    "Terminal ID 884422",
)
RECEIPT_WORDS = ("kiosk", "amsterdam", "btw", "123456789", "subtotaal", "visa", "884422", "terminal")


def make_receipt_dense() -> Image.Image:
    w, h = 640, 1280
    page = Image.new("RGB", (w, h), (225, 222, 216))
    draw = ImageDraw.Draw(page)
    face = font(26)
    y = 40
    for line in RECEIPT_LINES:
        draw.text((32, y), line, fill=(35, 35, 38), font=face)
        y += 46
    page = page.filter(ImageFilter.GaussianBlur(radius=0.85))
    glare = Image.new("RGB", page.size, (255, 255, 255))
    mask = Image.new("L", page.size, 0)
    ImageDraw.Draw(mask).ellipse((40, 30, w - 20, int(h * 0.45)), fill=200)
    page = Image.composite(glare, page, mask)
    page = ImageEnhance.Brightness(page).enhance(0.78)
    page = ImageEnhance.Contrast(page).enhance(0.75)
    frame = Image.new("RGB", (1080, 1920), (24, 26, 30))
    frame.paste(page, (140, 360))
    return frame.rotate(-6, expand=False, fillcolor=(24, 26, 30), resample=Image.Resampling.BICUBIC)


def make_glare_invoice() -> Image.Image:
    """Invoice truth with strong wash-out glare; gray pass + sharpen should beat v65 binarize."""
    page = render_page(32)
    page = ImageEnhance.Brightness(page).enhance(0.58)
    page = ImageEnhance.Contrast(page).enhance(0.7)
    glare = Image.new("RGB", page.size, (255, 255, 255))
    mask = Image.new("L", page.size, 0)
    w, h = page.size
    ImageDraw.Draw(mask).rectangle((0, 0, w, int(h * 0.55)), fill=210)
    ImageDraw.Draw(mask).ellipse((int(w * 0.1), int(h * 0.05), int(w * 0.95), int(h * 0.65)), fill=180)
    page = Image.composite(glare, page, mask)
    page = page.rotate(7, expand=True, fillcolor=(20, 20, 20), resample=Image.Resampling.BICUBIC)
    frame = Image.new("RGB", (1680, 2200), (22, 24, 28))
    frame.paste(page, ((frame.width - page.width) // 2, (frame.height - page.height) // 2))
    frame = ImageEnhance.Brightness(frame).enhance(0.8)
    frame = frame.filter(ImageFilter.GaussianBlur(radius=0.75))
    return _noise(frame, 12, 90210)


LOW_CONTRAST_WORDS = ("meeting", "oct", "walrus", "beta", "vienna", "retest", "fixtures", "search")


def make_low_contrast_notes() -> Image.Image:
    w, h = 900, 1200
    page = Image.new("RGB", (w, h), (168, 165, 158))
    draw = ImageDraw.Draw(page)
    face = font(26)
    lines = (
        "Meeting notes 28 Oct",
        "Ship OCR fail to pass fixtures",
        "Search tokens: walrus beta",
        "Action: Vienna retest photo",
    )
    y = 80
    for line in lines:
        draw.text((60, y), line, fill=(108, 106, 102), font=face)
        y += 64
    page = page.filter(ImageFilter.GaussianBlur(radius=0.65))
    frame = Image.new("RGB", (1200, 1600), (32, 34, 38))
    frame.paste(page, (150, 200))
    return ImageEnhance.Brightness(frame).enhance(0.84)


def main():
    data_dir = tessdata()
    cases = [
        ("make_hard", make_hard(), TRUTH_WORDS),
        ("glare_invoice", make_glare_invoice(), TRUTH_WORDS),
        ("receipt_dense", make_receipt_dense(), RECEIPT_WORDS),
        ("low_contrast_notes", make_low_contrast_notes(), LOW_CONTRAST_WORDS),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for name, img, words in cases:
            v65 = pipeline_v65(img, words, work / name, data_dir)
            enh = pipeline_enhanced(img, words, work / name, data_dir)
            flag = "OK" if v65 < 0.72 and enh >= 0.85 else "--"
            print(f"{flag} {name}: v65={v65:.3f} enhanced={enh:.3f}")


if __name__ == "__main__":
    main()
