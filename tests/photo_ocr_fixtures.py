"""Synthetic beta OCR fixtures with measured fail→pass against pipeline simulators."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


@dataclass(frozen=True)
class BetaOcrFixture:
    id: str
    filename: str
    description: str
    search_tokens: tuple[str, ...]
    truth_words: tuple[str, ...]
    v6528_max_recall: float
    enhanced_min_recall: float

    def build_image(self) -> Image.Image:
        builders = {
            "beta-receipt-soft-blur": make_beta_receipt_soft_blur,
            "beta-receipt-glare-blur": make_beta_receipt_glare_blur,
        }
        return builders[self.id]()


RECEIPT_LINES = (
    "Kiosk Amsterdam Centraal",
    "BTW NL123456789B01",
    "Subtotaal 14,50 EUR",
    "Betaald Visa contactloos",
    "Terminal ID 884422",
)

RECEIPT_TRUTH_WORDS = (
    "kiosk",
    "amsterdam",
    "btw",
    "123456789",
    "subtotaal",
    "visa",
    "884422",
    "terminal",
)

# Tokens Beta can type in the in-app search bar (subset of receipt text).
RECEIPT_SEARCH_TOKENS = ("kiosk", "amsterdam", "visa", "884422")


def _render_receipt_page(font_size: int) -> Image.Image:
    w, h = 580, 1180
    page = Image.new("RGB", (w, h), (225, 222, 216))
    draw = ImageDraw.Draw(page)
    face = font(font_size)
    y = 36
    for line in RECEIPT_LINES:
        draw.text((28, y), line, fill=(40, 40, 44), font=face)
        y += 31
    return page


def _frame_receipt(page: Image.Image) -> Image.Image:
    frame = Image.new("RGB", (1080, 1920), (24, 26, 30))
    frame.paste(page, (130, 420))
    return frame.rotate(-7, expand=False, fillcolor=(24, 26, 30), resample=Image.Resampling.BICUBIC)


def make_beta_receipt_soft_blur() -> Image.Image:
    """Dim phone photo: soft camera blur on dense receipt type (no cloud OCR)."""
    page = _render_receipt_page(20)
    page = page.filter(ImageFilter.GaussianBlur(radius=0.9))
    return _frame_receipt(page)


def make_beta_receipt_glare_blur() -> Image.Image:
    """Top glare + soft blur — binarize-heavy v0.65.28 passes stay weak; sharpen/gray path recovers."""
    page = _render_receipt_page(20)
    w, h = page.size
    glare = Image.new("RGB", page.size, (255, 255, 255))
    mask = Image.new("L", page.size, 0)
    ImageDraw.Draw(mask).rectangle((0, 0, w, int(h * 0.52)), fill=int(255 * 0.16))
    page = Image.composite(glare, page, mask)
    page = page.filter(ImageFilter.GaussianBlur(radius=0.88))
    return _frame_receipt(page)


BETA_FAIL_PASS_FIXTURES: tuple[BetaOcrFixture, ...] = (
    BetaOcrFixture(
        id="beta-receipt-soft-blur",
        filename="beta-receipt-soft-blur.jpg",
        description="Soft blur on a tilted phone photo of a Dutch/English receipt.",
        search_tokens=RECEIPT_SEARCH_TOKENS,
        truth_words=RECEIPT_TRUTH_WORDS,
        v6528_max_recall=0.72,
        enhanced_min_recall=0.85,
    ),
    BetaOcrFixture(
        id="beta-receipt-glare-blur",
        filename="beta-receipt-glare-blur.jpg",
        description="Mild top glare plus soft blur on the same receipt layout.",
        search_tokens=RECEIPT_SEARCH_TOKENS,
        truth_words=RECEIPT_TRUTH_WORDS,
        v6528_max_recall=0.72,
        enhanced_min_recall=0.85,
    ),
)
