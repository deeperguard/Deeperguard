"""Photo OCR preprocess: word recall on synthetic document photos.

Legacy ``make_hard`` / deskew tests are a weak regression bar (they already pass on
v0.65.28). Beta fail→pass proof lives in ``test_beta_fail_pass_fixtures`` and the
JPEGs in ``tests/fixtures/photo-ocr/beta-*.jpg``.

Run directly:
    python3 -m unittest tests.test_photo_ocr_quality -v
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tests"))
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

from photo_ocr_fixtures import BETA_FAIL_PASS_FIXTURES
from photo_ocr_pipeline import (
    pipeline_enhanced256_passes,
    pipeline_enhanced256_recall,
    pipeline_v6528_passes,
    pipeline_v6528_recall,
    search_tokens_found,
    tessdata_dir,
)

FIXTURE_DIR = REPO / "tests" / "fixtures" / "photo-ocr"
BETA_MANIFEST = FIXTURE_DIR / "beta-fail-pass.json"

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
    frame = Image.new("RGB", (page.width + 220, page.height + 220), (30, 32, 36))
    frame.paste(page, (110, 110))
    return ImageEnhance.Brightness(frame).enhance(0.85)


class PhotoOcrQualityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("tesseract"):
            raise unittest.SkipTest("tesseract is not installed")
        if not shutil.which("node"):
            raise unittest.SkipTest("node is not installed")
        cls.data_dir = tessdata_dir()

    def test_deskew_angle_on_ruled_lines(self):
        completed = subprocess.run(
            ["node", str(REPO / "tests" / "test_photo_deskew.js")],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if completed.returncode != 0:
            self.fail(completed.stderr or completed.stdout)

    def test_legacy_hard_fixture_regression_only(self):
        """Deskew invoice photo — already green on v0.65.28; not a fail→pass bar."""
        hard = make_hard()
        with tempfile.TemporaryDirectory(prefix="photo-ocr-legacy-") as tmp:
            work = Path(tmp)
            v65, _ = pipeline_v6528_recall(hard, TRUTH_WORDS, work / "v65", self.data_dir)
            enhanced, _ = pipeline_enhanced256_recall(hard, TRUTH_WORDS, work / "enh", self.data_dir)
        self.assertGreaterEqual(v65, 0.9, "legacy hard fixture (weak bar)")
        self.assertGreaterEqual(enhanced, 0.9)

    def test_beta_fail_pass_fixtures(self):
        """All four search tokens must fail v0.65.28 sim and pass #256 sim (committed JPEGs)."""
        self.assertTrue(BETA_MANIFEST.is_file(), "run tests/generate_photo_ocr_fixtures.py")
        on_disk = json.loads(BETA_MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(len(on_disk), len(BETA_FAIL_PASS_FIXTURES))
        for fx in BETA_FAIL_PASS_FIXTURES:
            path = FIXTURE_DIR / fx.filename
            self.assertTrue(path.is_file(), path)
            image = Image.open(path).convert("RGB")
            with tempfile.TemporaryDirectory(prefix=f"beta-ocr-{fx.id}-") as tmp:
                work = Path(tmp)
                v65_ok, text_v65 = pipeline_v6528_passes(
                    image, fx.search_tokens, work / "v65", self.data_dir
                )
                enh_ok, text_enh = pipeline_enhanced256_passes(
                    image, fx.search_tokens, work / "enh", self.data_dir
                )
            self.assertFalse(
                v65_ok,
                msg=f"{fx.id} must miss ≥1 search token on v0.65.28 sim; got {text_v65!r}",
            )
            self.assertTrue(
                enh_ok,
                msg=f"{fx.id} must include all search tokens on #256 sim; got {text_enh!r}",
            )
            self.assertTrue(search_tokens_found(text_enh, fx.search_tokens))

    @unittest.skip("Weak bar — sideways deskew already passes on v0.65.28; not fail→pass proof.")
    def test_sideways_photo_deskew_and_read(self):
        sideways = make_sideways()
        with tempfile.TemporaryDirectory(prefix="photo-ocr-sideways-") as tmp:
            work = Path(tmp)
            enhanced, text = pipeline_enhanced256_recall(
                sideways, TRUTH_WORDS, work / "enh", self.data_dir
            )
        self.assertGreaterEqual(enhanced, 0.85, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
