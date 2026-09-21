#!/usr/bin/env bash
# Verify Deeperguard is ready for iPhone PWA testing and print a manual checklist.
set -euo pipefail
HOST="${NOTES_HOST:-www.deeperguard.com}"
BASE="https://${HOST}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Deeperguard iOS readiness (${HOST}) ==="
if ! NOTES_IOS_READINESS=1 bash "$(dirname "$0")/verify-notes.sh"; then
  exit 1
fi

echo ""
echo "Checking iOS web client assets…"
APP_HTML="${REPO}/app/templates/app.html"
MANIFEST="${REPO}/app/static/manifest.json"
IOS_TUNE="${REPO}/app/static/js/ios-tune.js"
for path in "$APP_HTML" "$MANIFEST" "$IOS_TUNE"; do
  if [ ! -f "$path" ]; then
    echo "FAIL missing ${path}"
    exit 1
  fi
done
grep -q 'ios-tune.js' "$APP_HTML" && echo "OK  ios-tune.js wired in app shell" || { echo "FAIL ios-tune.js not in app.html"; exit 1; }
grep -q 'network-status-banner' "$APP_HTML" && echo "OK  network status banner" || { echo "FAIL network-status-banner missing"; exit 1; }
grep -q 'color-scheme' "$APP_HTML" && echo "OK  color-scheme meta" || { echo "FAIL color-scheme meta missing"; exit 1; }
grep -q 'apple-touch-startup-image' "$APP_HTML" && echo "OK  splash screen links" || { echo "FAIL splash screen links missing"; exit 1; }
grep -q '"shortcuts"' "$MANIFEST" && echo "OK  manifest shortcuts" || { echo "FAIL manifest shortcuts missing"; exit 1; }
grep -q '"maskable"' "$MANIFEST" && echo "OK  maskable manifest icon" || { echo "FAIL maskable icon missing"; exit 1; }
grep -q 'NotesIosTune' "$IOS_TUNE" && echo "OK  ios-tune helpers" || { echo "FAIL ios-tune helpers missing"; exit 1; }

health="$(curl -ksS "${BASE}/api/health")"
build="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('build',''))" <<<"$health")"

PY="${REPO}/venv/bin/python"

echo ""
echo "Running unit tests…"
if [ -x "$PY" ]; then
  if PYTHONPATH="${REPO}/app" "$PY" -m unittest discover -s "${REPO}/tests" -p 'test_*.py' -q; then
    echo "OK  Unit tests"
  else
    echo "FAIL Unit tests"
    exit 1
  fi
else
  echo "FAIL venv python missing at ${PY}"
  exit 1
fi

if ! command -v chromium >/dev/null || ! command -v chromedriver >/dev/null || ! command -v tesseract >/dev/null; then
  echo "FAIL Browser E2E deps missing (need chromium, chromedriver, tesseract)"
  exit 1
fi

if command -v chromium >/dev/null && command -v chromedriver >/dev/null && command -v tesseract >/dev/null \
    && [ -x "$PY" ]; then
  echo ""
  echo "Running PDF/photo search highlight E2E (local, ~30s)…"
  search_ok=0
  for attempt in 1 2; do
    if E2E_SEARCH=1 "$PY" "${REPO}/tests/e2e_search_highlight.py"; then
      search_ok=1
      break
    fi
    if [ "$attempt" -eq 1 ]; then
      echo "WARN PDF search E2E retrying once…"
      sleep 3
    fi
  done
  if [ "$search_ok" -eq 1 ]; then
    echo "OK  PDF/photo search highlight E2E"
  else
    echo "FAIL PDF/photo search highlight E2E"
    exit 1
  fi
else
  echo "FAIL Browser E2E deps missing (need chromium, chromedriver, tesseract, venv python)"
  exit 1
fi

echo ""
echo "Automated coverage (server + headless browser — not a substitute for iPhone):"
echo "  • HTTPS/TLS, CA cert, service worker, encryption, client OCR (Tesseract.js)"
echo "  • Offline vault unlock, edit, run-all device tests (steps 7–10)"
echo "  • PDF/photo search highlights (4 document types)"
echo "  • Single-file attach, star/pin/archive/protect/duplicate/trash buttons"
echo "  • iOS tune helpers, network banner, manifest shortcuts, splash links"
echo ""
echo "Manual iPhone checklist (required to confirm touch/PWA behavior):"
echo "  1. Join home Wi‑Fi or WireGuard"
echo "  2. Safari → ${BASE}/  (sidebar must show v${build}; if stale: Settings → Refresh app cache)"
echo "  3. Install ${BASE}/ca.crt → Settings → Certificate Trust Settings → enable full trust"
echo "  4. Notes → Settings → Security → enable Remember password on this device"
echo "  5. Add to Home Screen (Share → Add to Home Screen)"
echo "  6. Create/edit a text note; force-quit; reopen offline — vault should unlock"
echo "  7. Scan/upload photo → toast Searchable · … → search finds text — or Settings → Run all device tests → PASS"
echo "  8. Open PDF full-screen; pinch zoom stays sharp; search highlights visible"
echo "  9. Test star, pin, protect, trash, duplicate, and tag bar on a note"
echo " 10. Open a note → Add file → pick one PDF/image — attaches directly (no scan dialog)"
echo " 11. Pull down on the note list to sync; swipe from the left edge to close the editor"
echo " 12. Settings → Diagnostics shows storage estimate and iOS device fields"
echo ""
echo "Reply with pass/fail for each step to close the iOS refactor goal."
echo "Or run device tests on iPhone — the report uploads to the server at /opt/deeperguard/data/device-reports/latest.txt"
if ssh -o BatchMode=yes -o ConnectTimeout=8 "root@${HOST}" "test -s /opt/deeperguard/data/device-reports/latest.txt" 2>/dev/null; then
  echo ""
  echo "=== Latest iPhone device report on server ==="
  ssh -o BatchMode=yes -o ConnectTimeout=8 "root@${HOST}" "head -30 /opt/deeperguard/data/device-reports/latest.txt"
fi
