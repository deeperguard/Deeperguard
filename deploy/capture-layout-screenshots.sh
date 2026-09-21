#!/usr/bin/env bash
# Capture layout screenshots of Deeperguard public pages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/opt/cursor/artifacts/screenshots}"
BASE_URL="${NOTES_SCREENSHOT_URL:-http://127.0.0.1:5050}"
mkdir -p "$OUT"

pages=(
  "login:/login"
  "register:/register"
  "privacy:/privacy"
  "terms:/terms"
  "admin_denied:/admin"
  "unlock:/"
)

for entry in "${pages[@]}"; do
  name="${entry%%:*}"
  path="${entry#*:}"
  echo "Screenshot $name ($path)"
  chromium --headless=new --no-sandbox --disable-gpu --window-size=1280,900 \
    --screenshot="$OUT/layout_${name}_desktop.png" \
    "$BASE_URL$path" 2>/dev/null || true
  chromium --headless=new --no-sandbox --disable-gpu --window-size=390,844 \
    --screenshot="$OUT/layout_${name}_mobile.png" \
    "$BASE_URL$path" 2>/dev/null || true
done

echo "Saved to $OUT"
