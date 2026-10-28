"""Synthetic beta OCR fixtures — must fail v0.65.28 search, pass #256 search."""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


def font(size: int):
    from pathlib import Path

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

    def build_image(self) -> Image.Image:
        builders = {
            "beta-receipt-heavy-blur-glare": make_beta_receipt_heavy_blur_glare,
            "beta-receipt-lowcon-glare-skew": make_beta_receipt_lowcon_glare_skew,
        }
        return builders[self.id]()


RECEIPT_LINES = (
    "Kiosk Amsterdam Centraal",
    "BTW NL123456789B01",
    "Subtotaal 14,50 EUR",
    "Betaald Visa contactloos",
    "Terminal ID 884422",
)

RECEIPT_SEARCH_TOKENS = ("kiosk", "amsterdam", "visa", "884422")

# JPEG baked into committed fixtures (matches phone attach + recompress).
FIXTURE_JPEG_QUALITY = 88


def _render_receipt_page(
    font_size: int,
    *,
    paper=(218, 214, 206),
    ink=(44, 42, 40),
    line_step: int | None = None,
) -> Image.Image:
    w, h = 580, 1180
    page = Image.new("RGB", (w, h), paper)
    draw = ImageDraw.Draw(page)
    face = font(font_size)
    step = line_step or max(26, int(font_size * 1.45))
    y = 34
    for line in RECEIPT_LINES:
        draw.text((26, y), line, fill=ink, font=face)
        y += step
    return page


def _apply_top_glare(page: Image.Image, strength: float, top_fraction: float = 0.55) -> Image.Image:
    w, h = page.size
    mask = Image.new("L", page.size, 0)
    ImageDraw.Draw(mask).rectangle((0, 0, w, int(h * top_fraction)), fill=int(255 * strength))
    white = Image.new("RGB", page.size, (255, 255, 255))
    return Image.composite(white, page, mask)


def _phone_frame(page: Image.Image, *, skew: float, paste=(125, 410)) -> Image.Image:
    frame = Image.new("RGB", (1080, 1920), (24, 26, 30))
    frame.paste(page, paste)
    return frame.rotate(skew, expand=False, fillcolor=(24, 26, 30), resample=Image.Resampling.BICUBIC)


def generate_fixture_jpeg(image: Image.Image, path: Path) -> None:
    image.save(path, format="JPEG", quality=FIXTURE_JPEG_QUALITY, optimize=True)


def make_beta_receipt_heavy_blur_glare() -> Image.Image:
    """Camera blur + top glare + skew; v0.65.28 sim misses ≥1 search token, #256 recovers all four."""
    page = _render_receipt_page(21)
    page = _apply_top_glare(page, 0.08)
    page = ImageEnhance.Contrast(page).enhance(0.85)
    page = page.filter(ImageFilter.GaussianBlur(radius=0.65))
    return _phone_frame(page, skew=-9)


def make_beta_receipt_lowcon_glare_skew() -> Image.Image:
    """Low contrast, stronger glare, extra skew; v0.65.28 sim fails, #256 multi-pass passes."""
    page = _render_receipt_page(
        20, paper=(212, 208, 200), ink=(46, 44, 42), line_step=29
    )
    page = _apply_top_glare(page, 0.14, top_fraction=0.55)
    page = ImageEnhance.Brightness(page).enhance(0.60)
    page = ImageEnhance.Contrast(page).enhance(0.62)
    page = page.filter(ImageFilter.GaussianBlur(radius=0.68))
    return _phone_frame(page, skew=-12, paste=(122, 408))


BETA_FAIL_PASS_FIXTURES: tuple[BetaOcrFixture, ...] = (
    BetaOcrFixture(
        id="beta-receipt-heavy-blur-glare",
        filename="beta-receipt-heavy-blur-glare.jpg",
        description="Blurred receipt with top glare and ~9° skew (JPEG Q88); harder than retired beta soft/glare fixtures.",
        search_tokens=RECEIPT_SEARCH_TOKENS,
    ),
    BetaOcrFixture(
        id="beta-receipt-lowcon-glare-skew",
        filename="beta-receipt-lowcon-glare-skew.jpg",
        description="Low-contrast receipt, stronger glare, ~12° skew, moderate blur (JPEG Q88).",
        search_tokens=RECEIPT_SEARCH_TOKENS,
    ),
)
