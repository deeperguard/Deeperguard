#!/usr/bin/env bash
# Self-hosted assets for zero-knowledge client OCR and document preview.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PDF="$ROOT/app/static/js/vendor/pdfjs"
TESS="$ROOT/app/static/js/vendor/tesseract"
JSPDF="$ROOT/app/static/js/vendor/jspdf"
HEIC="$ROOT/app/static/js/vendor/heic2any"
mkdir -p "$PDF" "$TESS/lang" "$JSPDF" "$HEIC"

PDFJS_VER="${PDFJS_VER:-3.11.174}"
TESSERACT_VER="${TESSERACT_VER:-5.1.1}"
TESSDATA_VER="${TESSDATA_VER:-4.0.0}"
JSPDF_VER="${JSPDF_VER:-2.5.2}"
HEIC_VER="${HEIC_VER:-0.0.4}"

fetch() {
  local url="$1"
  local dest="$2"
  if [[ -s "$dest" ]]; then
    return 0
  fi
  echo "Fetching $(basename "$dest")"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest.part"
  mv "$dest.part" "$dest"
}

fetch "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/legacy/build/pdf.min.js" "$PDF/pdf.min.js"
fetch "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/legacy/build/pdf.worker.min.js" "$PDF/pdf.worker.min.js"

fetch "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VER}/dist/tesseract.min.js" "$TESS/tesseract.min.js"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VER}/dist/worker.min.js" "$TESS/worker.min.js"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VER}/tesseract-core.wasm.js" "$TESS/tesseract-core.wasm.js"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VER}/tesseract-core-simd.wasm.js" "$TESS/tesseract-core-simd.wasm.js"
fetch "https://github.com/naptha/tessdata/raw/gh-pages/${TESSDATA_VER}/eng.traineddata.gz" "$TESS/lang/eng.traineddata.gz"
fetch "https://github.com/naptha/tessdata/raw/gh-pages/${TESSDATA_VER}/nld.traineddata.gz" "$TESS/lang/nld.traineddata.gz"

fetch "https://cdn.jsdelivr.net/npm/jspdf@${JSPDF_VER}/dist/jspdf.umd.min.js" "$JSPDF/jspdf.umd.min.js"
fetch "https://cdn.jsdelivr.net/npm/heic2any@${HEIC_VER}/dist/heic2any.min.js" "$HEIC/heic2any.min.js"

echo "Client OCR + preview assets ready"
