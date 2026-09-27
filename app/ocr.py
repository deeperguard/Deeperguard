"""Server-side text extraction for uploaded notes documents."""
from __future__ import annotations

import base64
import csv
import io
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageOps

MAX_BYTES = 50 * 1024 * 1024
MAX_SCAN_PAGES = 6
MAX_BOXES = 1500
LIST_PREVIEW_PX = 224
LIST_PREVIEW_JPEG_QUALITY = 78
MAX_LIST_PREVIEW_BYTES = 96 * 1024
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
HEIC_SUFFIXES = {".heic", ".heif"}
HEIC_MIMES = {"image/heic", "image/heif", "image/heic-sequence"}
TEXT_SUFFIXES = {".txt", ".md", ".csv"}
BINARY_SUFFIXES = {
    ".exe", ".dll", ".bin", ".zip", ".gz", ".tar", ".7z", ".html", ".htm",
    ".wasm", ".dmg", ".pkg", ".deb", ".rpm", ".msi", ".apk",
}
WORD_RE = re.compile(
    r'<word[^>]*xMin="([0-9.]+)"[^>]*yMin="([0-9.]+)"[^>]*xMax="([0-9.]+)"[^>]*yMax="([0-9.]+)"[^>]*>(.*?)</word>',
    re.I | re.S,
)


class OcrError(ValueError):
    """Unsupported or unreadable document."""


def _looks_like_text(data: bytes) -> bool:
    if not data or len(data) < 8:
        return False
    if len(data) >= 2 and data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return True
    if len(data) >= 3 and data[:3] == b"\xef\xbb\xbf":
        return True
    sample = data[:4096]
    nulls = sample.count(b"\x00")
    if nulls > len(sample) * 0.05:
        return False
    ctrl = sum(1 for b in sample if b < 9 or (13 < b < 32))
    printable = len(sample) - nulls - ctrl
    return printable / max(len(sample), 1) > 0.85 and ctrl / max(len(sample), 1) < 0.05


def _maybe_text(filename: str, mime: str, data: bytes) -> bool:
    name = (filename or "document").lower()
    kind = (mime or "").lower()
    suffix = Path(name).suffix
    if data.startswith(b"%PDF"):
        return False
    if kind == "application/pdf" or suffix == ".pdf":
        return False
    if kind.startswith("image/") or suffix in IMAGE_SUFFIXES or suffix in HEIC_SUFFIXES or kind in HEIC_MIMES:
        return False
    if kind.startswith("text/") or suffix in TEXT_SUFFIXES:
        return True
    if suffix in BINARY_SUFFIXES:
        return False
    return _looks_like_text(data)


def extract(filename: str, mime: str, data: bytes) -> dict[str, Any]:
    if not data:
        raise OcrError("empty file")
    if len(data) > MAX_BYTES:
        raise OcrError("File too large to process on the server.")
    name = (filename or "document").lower()
    mime = (mime or "").lower()
    suffix = Path(name).suffix
    preview = render_list_preview(filename, mime, data)
    preview_b64 = base64.b64encode(preview).decode("ascii") if preview else ""
    if _maybe_text(filename, mime, data):
        out = {"text": _clean(data.decode("utf-8", "replace")), "method": "text", "boxes": []}
        if preview_b64:
            out["preview_jpeg_b64"] = preview_b64
        return out
    if mime == "application/pdf" or suffix == ".pdf":
        out = _pdf(data)
        if preview_b64:
            out["preview_jpeg_b64"] = preview_b64
        return out
    if mime.startswith("image/") or suffix in IMAGE_SUFFIXES or suffix in HEIC_SUFFIXES or mime in HEIC_MIMES:
        out = _image(data, filename=name, mime=mime)
        if preview_b64:
            out["preview_jpeg_b64"] = preview_b64
        return out
    raise OcrError("Use an image, PDF, or text file.")


def render_list_preview(filename: str, mime: str, data: bytes) -> bytes:
    """Small JPEG for note-list thumbnails — generated once during OCR/upload."""
    if not data:
        return b""
    name = (filename or "document").lower()
    kind = (mime or "").lower()
    suffix = Path(name).suffix
    try:
        if kind == "application/pdf" or suffix == ".pdf":
            jpeg = _pdf_list_preview(data)
        elif kind.startswith("image/") or suffix in IMAGE_SUFFIXES or suffix in HEIC_SUFFIXES or kind in HEIC_MIMES:
            jpeg = _image_list_preview(data, filename=name, mime=mime)
        else:
            return b""
    except Exception:
        return b""
    if not jpeg or len(jpeg) > MAX_LIST_PREVIEW_BYTES:
        return b""
    return jpeg


def _fit_preview_jpeg(image: Image.Image) -> bytes:
    img = image.copy()
    img.thumbnail((LIST_PREVIEW_PX, LIST_PREVIEW_PX), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=LIST_PREVIEW_JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def _image_list_preview(data: bytes, filename: str = "", mime: str = "") -> bytes:
    return _fit_preview_jpeg(decode_image(data, filename, mime))


def _pdf_list_preview(data: bytes) -> bytes:
    pdftoppm = _require("pdftoppm")
    with tempfile.TemporaryDirectory(prefix="notes-preview-") as tmp:
        root = Path(tmp)
        pdf_path = root / "doc.pdf"
        pdf_path.write_bytes(data)
        prefix = root / "page"
        try:
            _run(
                [
                    pdftoppm,
                    "-jpeg",
                    "-jpegopt",
                    f"quality={LIST_PREVIEW_JPEG_QUALITY}",
                    "-r",
                    "96",
                    "-f",
                    "1",
                    "-l",
                    "1",
                    str(pdf_path),
                    str(prefix),
                ],
                timeout=45,
            )
        except OcrError:
            pass
        pages = sorted(root.glob("page*.jpg"))
        if not pages:
            return b""
        image = Image.open(pages[0])
        if image.mode != "RGB":
            image = image.convert("RGB")
        return _fit_preview_jpeg(image)


def is_heic(filename: str = "", mime: str = "") -> bool:
    name = (filename or "").lower()
    kind = (mime or "").lower()
    return Path(name).suffix in HEIC_SUFFIXES or kind in HEIC_MIMES


def _ensure_heif() -> bool:
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
        return True
    except Exception:
        return False


_ensure_heif()


def decode_image(data: bytes, filename: str = "", mime: str = "") -> Image.Image:
    """Open a photo, including iPhone HEIC, and return an upright RGB image."""
    if not data:
        raise OcrError("empty file")
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        if image.mode != "RGB":
            image = image.convert("RGB")
        return image
    except Exception as exc:
        looks_heif = is_heic(filename, mime) or b"ftyp" in data[:16]
        if not looks_heif:
            raise OcrError("Could not read that image.") from exc
        return _heif_convert_cli(data)


def _heif_convert_cli(data: bytes) -> Image.Image:
    convert = shutil.which("heif-convert")
    if not convert:
        raise OcrError("HEIC photos need libheif on the notes server.")
    with tempfile.TemporaryDirectory(prefix="notes-heic-") as tmp:
        src = Path(tmp) / "in.heic"
        dest = Path(tmp) / "out.jpg"
        src.write_bytes(data)
        _run([convert, str(src), str(dest)], timeout=30)
        if not dest.is_file():
            raise OcrError("Could not convert that HEIC photo.")
        image = Image.open(dest)
        image = ImageOps.exif_transpose(image)
        return image.convert("RGB")


def image_to_jpeg(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=88, optimize=True)
    return buf.getvalue()


def images_to_pdf(images: list[Image.Image]) -> bytes:
    if not images:
        raise OcrError("Choose a photo first.")
    buf = io.BytesIO()
    first, rest = images[0], images[1:]
    first.save(buf, format="PDF", save_all=bool(rest), append_images=rest, resolution=150)
    return buf.getvalue()


def prepare(files: list[tuple[str, str, bytes]]) -> dict[str, Any]:
    """Normalize camera/library photos to a JPEG or a multi-page PDF."""
    if not files:
        raise OcrError("Choose a photo first.")
    if len(files) > MAX_SCAN_PAGES:
        raise OcrError(f"Scan at most {MAX_SCAN_PAGES} pages.")
    images: list[Image.Image] = []
    total = 0
    for filename, mime, data in files:
        total += len(data or b"")
        if total > MAX_BYTES * 2:
            raise OcrError("Those photos are too large to combine.")
        images.append(decode_image(data, filename, mime))
    if len(images) == 1:
        out = image_to_jpeg(images[0])
        if len(out) > MAX_BYTES:
            raise OcrError("File too large to process on the server.")
        return {"filename": "scan.jpg", "mime": "image/jpeg", "data": out}
    out = images_to_pdf(images)
    if len(out) > MAX_BYTES:
        raise OcrError("File too large to process on the server.")
    return {"filename": "scan.pdf", "mime": "application/pdf", "data": out}


def _clean(text: str) -> str:
    return "\n".join(line.rstrip() for line in (text or "").replace("\r\n", "\n").split("\n")).strip()


def _meaningful_words(text: str) -> list[str]:
    return [
        word
        for word in re.split(r"\s+", _clean(text))
        if len(word) >= 3 and re.search(r"[A-Za-z]{2}", word)
    ]


def weak_ocr_result(text: str, boxes: list[dict[str, Any]] | None) -> bool:
    """True when OCR returned too little text to be useful for search."""
    cleaned = _clean(text)
    if not cleaned:
        return True
    words = _meaningful_words(cleaned)
    box_count = len(boxes or [])
    if len(cleaned) < 32 and box_count < 8:
        return True
    if len(words) < 2:
        return True
    return False


def _enhance_for_ocr(image: Image.Image) -> Image.Image:
    """Upscale, sharpen, and boost contrast before a second OCR pass."""
    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        image = image.convert("RGB")
    width, height = image.size
    min_dim = min(width, height)
    if min_dim < 1400:
        scale = min(2.0, 1400 / max(min_dim, 1))
        image = image.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray, cutoff=2)
    sharp = ImageEnhance.Sharpness(gray).enhance(1.35)
    contrast = ImageEnhance.Contrast(sharp).enhance(1.15)
    return contrast.convert("RGB")


def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise OcrError(f"{binary} is not installed on the notes server.")
    return path


def _run(args: list[str], timeout: int = 60) -> str:
    try:
        completed = subprocess.run(
            args,
            check=False,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise OcrError("Document processing timed out on the server.") from exc
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or b"").decode("utf-8", "replace").strip()
        raise OcrError(err or f"{args[0]} failed")
    return completed.stdout.decode("utf-8", "replace")


def _box(text: str, left: float, top: float, width: float, height: float, page: int = 0) -> dict[str, Any] | None:
    word = _clean(text)
    if not word:
        return None
    if width <= 0 or height <= 0:
        return None
    return {
        "text": word[:80],
        "l": round(max(0.0, min(1.0, left)), 4),
        "t": round(max(0.0, min(1.0, top)), 4),
        "w": round(max(0.001, min(1.0, width)), 4),
        "h": round(max(0.001, min(1.0, height)), 4),
        "page": int(page),
    }


def parse_bbox_html(html: str) -> list[dict[str, Any]]:
    boxes: list[dict[str, Any]] = []
    chunks = re.split(r"(?i)<page\b", html or "")
    for page, chunk in enumerate(chunks[1:]):
        header, _, rest = chunk.partition(">")
        width_m = re.search(r'width="([0-9.]+)"', header, re.I)
        height_m = re.search(r'height="([0-9.]+)"', header, re.I)
        if not width_m or not height_m:
            continue
        page_w = float(width_m.group(1)) or 0.0
        page_h = float(height_m.group(1)) or 0.0
        if page_w <= 0 or page_h <= 0:
            continue
        for match in WORD_RE.finditer(rest):
            x_min, y_min, x_max, y_max = (float(match.group(i)) for i in range(1, 5))
            word = re.sub(r"<[^>]+>", "", match.group(5))
            item = _box(
                word,
                x_min / page_w,
                y_min / page_h,
                (x_max - x_min) / page_w,
                (y_max - y_min) / page_h,
                page,
            )
            if item:
                boxes.append(item)
            if len(boxes) >= MAX_BOXES:
                return boxes
    return boxes


def parse_tsv(tsv: str, image_w: int, image_h: int, page: int = 0) -> list[dict[str, Any]]:
    boxes: list[dict[str, Any]] = []
    if image_w <= 0 or image_h <= 0:
        return boxes
    reader = csv.DictReader(io.StringIO(tsv or ""), delimiter="\t")
    for row in reader:
        if str(row.get("level") or "") != "5":
            continue
        try:
            conf = float(row.get("conf") or -1)
            left = float(row.get("left") or 0)
            top = float(row.get("top") or 0)
            width = float(row.get("width") or 0)
            height = float(row.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if conf < 0:
            continue
        item = _box(str(row.get("text") or ""), left / image_w, top / image_h, width / image_w, height / image_h, page)
        if item:
            boxes.append(item)
        if len(boxes) >= MAX_BOXES:
            break
    return boxes


def _tesseract(image_path: str, psm: int = 3) -> str:
    binary = _require("tesseract")
    return _clean(_run([binary, image_path, "stdout", "-l", "eng+nld", "--psm", str(psm)], timeout=90))


def _tesseract_boxes(image_path: str, page: int = 0, psm: int = 3) -> tuple[str, list[dict[str, Any]]]:
    binary = _require("tesseract")
    raw = _run([binary, image_path, "stdout", "-l", "eng+nld", "--psm", str(psm), "tsv"], timeout=90)
    with Image.open(image_path) as image:
        width, height = image.size
    boxes = parse_tsv(raw, width, height, page)
    text = _clean(" ".join(item["text"] for item in boxes)) or _clean(
        "\n".join(
            row.get("text") or ""
            for row in csv.DictReader(io.StringIO(raw), delimiter="\t")
            if str(row.get("level") or "") == "5"
        )
    )
    return text, boxes


def _save_image(data: bytes, dest: Path, filename: str = "", mime: str = "") -> Path:
    image = decode_image(data, filename, mime)
    path = dest / "page.png"
    image.save(path, format="PNG")
    return path


def _ocr_image_file(path: Path, psm: int = 3) -> tuple[str, list[dict[str, Any]]]:
    text, boxes = _tesseract_boxes(str(path), psm=psm)
    if not text:
        text = _tesseract(str(path), psm=psm)
    return text, boxes


def _image(data: bytes, filename: str = "", mime: str = "") -> dict[str, Any]:
    source = decode_image(data, filename, mime)
    with tempfile.TemporaryDirectory(prefix="notes-ocr-") as tmp:
        root = Path(tmp)
        path = root / "page.png"
        source.save(path, format="PNG")
        text, boxes = _ocr_image_file(path, psm=3)
        if weak_ocr_result(text, boxes):
            enhanced_path = root / "enhanced.png"
            _enhance_for_ocr(source).save(enhanced_path, format="PNG")
            for psm in (6, 11):
                alt_text, alt_boxes = _ocr_image_file(enhanced_path, psm=psm)
                if len(_clean(alt_text)) > len(_clean(text)) or len(alt_boxes) > len(boxes):
                    text, boxes = alt_text, alt_boxes
                if not weak_ocr_result(text, boxes):
                    break
        quality = "weak" if weak_ocr_result(text, boxes) else "ok"
        return {
            "text": text,
            "method": "tesseract",
            "boxes": boxes,
            "ocr_quality": quality,
        }


def _pdf_boxes(pdf_path: Path) -> list[dict[str, Any]]:
    try:
        pdftotext = _require("pdftotext")
        html = _run(
            [pdftotext, "-bbox", "-enc", "UTF-8", str(pdf_path), "-"],
            timeout=600,
        )
    except OcrError:
        return []
    return parse_bbox_html(html)


def _pdf_raster_boxes(pdf_path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Rasterize PDF pages and OCR word boxes aligned to the rendered page image."""
    pdftoppm = _require("pdftoppm")
    prefix = pdf_path.parent / "page"
    try:
        _run(
            [
                pdftoppm,
                "-jpeg",
                "-jpegopt",
                "quality=88",
                "-r",
                "110",
                "-f",
                "1",
                str(pdf_path),
                str(prefix),
            ],
            timeout=1800,
        )
    except OcrError:
        # Some pdftoppm builds write pages and still exit non-zero on warnings.
        pass
    pages = sorted(pdf_path.parent.glob("page*.jpg"))
    if not pages:
        return [], []
    boxes: list[dict[str, Any]] = []
    texts: list[str] = []
    for index, page in enumerate(pages):
        try:
            text, page_boxes = _tesseract_boxes(str(page), index)
            if not text:
                text = _tesseract(str(page))
        except OcrError:
            # A renderer warning may leave only its last page incomplete.
            # Keep searchable boxes from every complete page.
            continue
        if text:
            texts.append(text)
        if len(boxes) < MAX_BOXES:
            boxes.extend(page_boxes[: MAX_BOXES - len(boxes)])
    return boxes, texts


def _pdf(data: bytes) -> dict[str, Any]:
    pdftotext = _require("pdftotext")
    with tempfile.TemporaryDirectory(prefix="notes-ocr-") as tmp:
        root = Path(tmp)
        pdf_path = root / "doc.pdf"
        pdf_path.write_bytes(data)
        embedded = _clean(
            _run([pdftotext, "-layout", "-enc", "UTF-8", str(pdf_path), "-"], timeout=600)
        )
        boxes = _pdf_boxes(pdf_path)
        if len(embedded) >= 40 and len(boxes) >= 5:
            # Keep bbox geometry for pages where pdf.js finds no text hits.
            # The client skips these overlays when embedded PDF text already painted.
            return {"text": embedded, "method": "pdftotext", "boxes": boxes}
        raster_boxes, raster_texts = _pdf_raster_boxes(pdf_path)
        if not raster_boxes and not raster_texts:
            return {"text": embedded, "method": "pdftotext", "boxes": boxes}
        parts = [embedded] if embedded else []
        for text in raster_texts:
            if text and (not embedded or text not in embedded):
                parts.append(text)
        ocr_boxes = raster_boxes or boxes
        method = "tesseract" if raster_boxes else "pdftotext"
        return {
            "text": _clean("\n\n".join(parts)) or embedded,
            "method": method,
            "boxes": ocr_boxes[:MAX_BOXES],
        }
