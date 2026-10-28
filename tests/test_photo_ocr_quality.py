"""Photo OCR preprocess: word recall on synthetic document photos.

The hard fixture is a dim, skewed phone-like shot of a Dutch invoice with the
page sitting inside a dark border. The previous client preprocess (grayscale,
contrast, a small upscale) is applied to that same image. Recognition uses the
vendored language data only — nothing is downloaded.

On that hard photo, eng+nld Tesseract measured:

- previous preprocess, PSM 3: word recall 0.636, character error rate 0.479
- deskew, crop, upscale, adaptive threshold, PSM 4: word recall 1.0, character error rate 0.0

The clean control is 1.0 / 0.0 on the new path. Those are this fixture, not a
claim about every phone photo.

Run directly:
    python3 tests/test_photo_ocr_quality.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parents[1]
APPLY = REPO / "tests" / "apply_photo_preprocess.js"
FIXTURE_DIR = REPO / "tests" / "fixtures" / "photo-ocr"
LANG_DIR = REPO / "app" / "static" / "js" / "vendor" / "tesseract" / "lang"

TRUTH = (
    "Factuur 2024\n"
    "Airco installatie\n"
    "BTW 21 procent\n"
    "Totaal 186,00 EUR\n"
    "Klant Deeperguard BV"
)
TRUTH_WORDS = (
    "factuur",
    "2024",
    "airco",
    "installatie",
    "btw",
    "procent",
    "totaal",
    "186",
    "eur",
    "klant",
    "deeperguard",
)


def font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def render_page(size: int) -> Image.Image:
    page = Image.new("RGB", (980, 1360), (236, 232, 224))
    draw = ImageDraw.Draw(page)
    face = font(size)
    lines = TRUTH.split("\n")
    y = 120
    for line in lines:
        draw.text((80, y), line, fill=(28, 28, 28), font=face)
        y += int(size * 2.15)
    return page


def _noise(image: Image.Image, amount: int, seed: int) -> Image.Image:
    import random

    rnd = random.Random(seed)
    px = image.load()
    w, h = image.size
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            delta = rnd.randint(-amount, amount)
            r, g, b = px[x, y]
            px[x, y] = (
                max(0, min(255, r + delta)),
                max(0, min(255, g + delta)),
                max(0, min(255, b + delta)),
            )
    return image


def make_clean() -> Image.Image:
    return render_page(54)


def make_hard() -> Image.Image:
    """Skewed, dim, low-contrast page on a dark surround, phone-photo scale.

    The tilt and glare are strong enough that the previous contrast-only
    preprocess misreads the invoice, while deskew plus adaptive threshold
    still recovers it.
    """
    page = render_page(28)
    page = ImageEnhance.Brightness(page).enhance(0.62)
    page = ImageEnhance.Contrast(page).enhance(0.72)
    glare = Image.new("RGB", page.size, (255, 255, 255))
    mask = Image.linear_gradient("L").resize(page.size)
    page = Image.composite(glare, page, mask.point(lambda v: int(v * 0.45)))
    page = page.rotate(8, expand=True, fillcolor=(18, 18, 18), resample=Image.Resampling.BICUBIC)
    frame = Image.new("RGB", (1680, 2200), (22, 24, 28))
    frame.paste(page, ((frame.width - page.width) // 2, (frame.height - page.height) // 2))
    frame = ImageEnhance.Brightness(frame).enhance(0.78)
    frame = frame.filter(ImageFilter.GaussianBlur(radius=0.6))
    return _noise(frame, 14, 2024)


def make_sideways() -> Image.Image:
    page = render_page(40)
    page = page.rotate(90, expand=True, fillcolor=(250, 250, 250), resample=Image.Resampling.BICUBIC)
    frame = Image.new("RGB", (page.height + 180, page.width + 180), (30, 32, 36))
    # page is landscape after 90° rotation; keep a dark border around it
    frame = Image.new("RGB", (page.width + 220, page.height + 220), (30, 32, 36))
    frame.paste(page, (110, 110))
    return ImageEnhance.Brightness(frame).enhance(0.85)


def write_rgba(path: Path, image: Image.Image) -> None:
    rgba = image.convert("RGBA")
    w, h = rgba.size
    path.write_bytes(struct.pack("<II", w, h) + rgba.tobytes())


def tokens(text: str) -> list[str]:
    found = re.findall(r"[a-z0-9]+", text.lower())
    return [word for word in found if len(word) >= 3 or word.isdigit()]


def word_recall(text: str) -> float:
    found = set(tokens(text))
    hits = sum(1 for word in TRUTH_WORDS if word in found or any_close(word, found))
    return hits / len(TRUTH_WORDS)


def any_close(word: str, found: set[str]) -> bool:
    if word in found:
        return True
    for other in found:
        if abs(len(other) - len(word)) > 1:
            continue
        if levenshtein(word, other) <= 1 and len(word) >= 4:
            return True
    return False


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def character_error_rate(text: str) -> float:
    ref = re.sub(r"[^a-z0-9]", "", TRUTH.lower())
    hyp = re.sub(r"[^a-z0-9]", "", text.lower())
    if not ref:
        return 1.0
    return levenshtein(ref, hyp) / len(ref)


def tessdata() -> Path:
    dest = Path(tempfile.gettempdir()) / "deeperguard-tessdata"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("eng", "nld"):
        gz = LANG_DIR / f"{name}.traineddata.gz"
        out = dest / f"{name}.traineddata"
        if out.exists() and out.stat().st_size > 1000:
            continue
        if not gz.exists():
            raise unittest.SkipTest(f"missing {gz}")
        with out.open("wb") as handle:
            subprocess.run(["gzip", "-dc", str(gz)], check=True, stdout=handle)
    return dest


def tesseract_bin() -> str:
    binary = shutil.which("tesseract")
    if not binary:
        raise unittest.SkipTest("tesseract is not installed")
    return binary


def run_tesseract(png: Path, data_dir: Path, psm: int) -> str:
    env = dict(os.environ)
    env["TESSDATA_PREFIX"] = str(data_dir)
    completed = subprocess.run(
        [tesseract_bin(), str(png), "stdout", "-l", "eng+nld", "--psm", str(psm), "--dpi", "300"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "tesseract failed")
    return completed.stdout


def preprocess(rgba_path: Path, png_path: Path, mode: str) -> dict:
    env = dict(os.environ)
    env["PHOTO_OCR_META"] = "1"
    completed = subprocess.run(
        ["node", str(APPLY), str(rgba_path), str(png_path), mode],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "preprocess failed")
    line = (completed.stdout or "").strip().splitlines()
    if not line:
        return {}
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError:
        return {}


def recognize(image: Image.Image, mode: str, psm: int, work: Path, data_dir: Path) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    rgba = work / f"{mode}.rgba"
    png = work / f"{mode}-psm{psm}.ppm"
    write_rgba(rgba, image)
    meta = preprocess(rgba, png, mode)
    text = run_tesseract(png, data_dir, psm)
    return {
        "text": text.strip(),
        "recall": word_recall(text),
        "cer": character_error_rate(text),
        "meta": meta,
    }


class PhotoOcrQualityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tessdata()
        tesseract_bin()
        if not shutil.which("node"):
            raise unittest.SkipTest("node is not installed")

    def test_deskew_angle_on_ruled_lines(self):
        """A page of horizontal rules, rotated 8 degrees, is deskewed near -8."""
        completed = subprocess.run(
            ["node", str(REPO / "tests" / "test_photo_deskew.js")],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if completed.returncode != 0:
            self.fail(completed.stderr or completed.stdout)

    def test_hard_photo_beats_old_preprocess(self):
        hard = make_hard()
        clean = make_clean()
        data_dir = self.data_dir
        with tempfile.TemporaryDirectory(prefix="photo-ocr-") as tmp:
            work = Path(tmp)
            # Previous client path: light enhance, PSM 3 (its first recognition pass).
            before = recognize(hard, "legacy", 3, work / "before", data_dir)
            primary = recognize(hard, "primary", 4, work / "primary", data_dir)
            after = primary
            if primary["recall"] < 0.7:
                strong = recognize(hard, "strong", 4, work / "strong", data_dir)
                after = strong if strong["recall"] > primary["recall"] else primary
            control = recognize(clean, "primary", 4, work / "control", data_dir)

        report = {
            "truth_words": list(TRUTH_WORDS),
            "hard_before_legacy_psm3": {
                "word_recall": round(before["recall"], 3),
                "cer": round(before["cer"], 3),
            },
            "hard_after_primary_psm4": {
                "word_recall": round(primary["recall"], 3),
                "cer": round(primary["cer"], 3),
                "angle": primary["meta"].get("angle"),
                "cropped": primary["meta"].get("cropped"),
                "size": [primary["meta"].get("width"), primary["meta"].get("height")],
            },
            "hard_after_chosen": {
                "word_recall": round(after["recall"], 3),
                "cer": round(after["cer"], 3),
            },
            "clean_control_primary": {
                "word_recall": round(control["recall"], 3),
                "cer": round(control["cer"], 3),
            },
        }
        print(json.dumps(report, indent=2))
        # Measured on this fixture (eng+nld, no network): legacy contrast
        # preprocess word recall 0.636 / CER 0.479; deskew + adaptive
        # threshold word recall 1.0 / CER 0.0. The bar sits between them.
        self.assertLess(before["recall"], 0.75, before["text"])
        self.assertGreater(before["cer"], 0.35, before["text"])
        self.assertGreaterEqual(after["recall"], 0.9, after["text"])
        self.assertLessEqual(after["cer"], 0.05, after["text"])
        self.assertGreater(after["recall"], before["recall"])
        self.assertLess(after["cer"], before["cer"])
        self.assertGreaterEqual(control["recall"], 0.9, control["text"])

    def test_sideways_photo_deskew_and_read(self):
        """A 90° page rotation should deskew and still reach high word recall."""
        sideways = make_sideways()
        data_dir = self.data_dir
        with tempfile.TemporaryDirectory(prefix="photo-ocr-sideways-") as tmp:
            work = Path(tmp)
            primary = recognize(sideways, "primary", 4, work / "primary", data_dir)
            after = primary
            if primary["recall"] < 0.85:
                gray = recognize(sideways, "gray", 4, work / "gray", data_dir)
                after = gray if gray["recall"] > primary["recall"] else primary
            angle = abs(float(primary["meta"].get("angle") or 0))
        self.assertGreaterEqual(angle, 80, f"expected ~90° deskew, got {angle}")
        self.assertGreaterEqual(after["recall"], 0.85, after["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
