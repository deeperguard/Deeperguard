#!/usr/bin/env bash
# Run autonomous notes promotion steps and print manual follow-ups.
set -euo pipefail

NOTES_URL="${NOTES_URL:-https://www.deeperguard.com}"
PROMO_URL="${NOTES_URL}/api/promo"
SITEMAP_URL="${NOTES_URL}/sitemap.xml"
INDEXNOW_KEY="${NOTES_INDEXNOW_KEY:-deeperguard-notes-indexnow-8f3a}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Deeperguard notes promotion ==="
echo "Website: ${NOTES_URL}"
echo ""

echo "=== 1. Verify live endpoints ==="
curl -fsS "${NOTES_URL}/api/health" | python3 -m json.tool
curl -fsS "${PROMO_URL}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('promo ok:', d.get('product'), d.get('tagline')[:60])"
echo ""

echo "=== 2. Search engine sitemap pings ==="
curl -fsS "https://www.google.com/ping?sitemap=${SITEMAP_URL}" && echo "Google ping OK" || echo "Google ping failed (use Search Console)"
curl -fsS "https://www.bing.com/ping?sitemap=${SITEMAP_URL}" && echo "Bing ping OK" || echo "Bing ping failed"
echo ""

echo "=== 3. IndexNow (Bing/Yandex) ==="
INDEXNOW_BODY=$(python3 - <<PY
import json
print(json.dumps({
  "host": "${NOTES_URL#https://}",
  "key": "${INDEXNOW_KEY}",
  "keyLocation": "${NOTES_URL}/${INDEXNOW_KEY}.txt",
  "urlList": [
    "${NOTES_URL}/",
    "${NOTES_URL}/pricing",
    "${NOTES_URL}/register",
    "${PROMO_URL}",
  ],
}))
PY
)
curl -fsS -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "${INDEXNOW_BODY}" && echo "IndexNow OK" || echo "IndexNow failed (deploy ${INDEXNOW_KEY}.txt route first)"
echo ""

echo "=== 4. Save outreach copy from /api/promo ==="
OUT_DIR="${ROOT}/contrib/outreach/generated"
mkdir -p "${OUT_DIR}"
curl -fsS "${PROMO_URL}" -o "${OUT_DIR}/promo.json"
python3 - <<'PY' "${OUT_DIR}/promo.json" "${OUT_DIR}"
import json, pathlib, sys
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
data = json.loads(src.read_text())
for name in ("reddit", "discord", "twitter", "hacker_news_title", "hacker_news_text", "alternativeto_email"):
    val = data.get("copy", {}).get(name, "")
    (out / f"{name}.txt").write_text(str(val) + "\n", encoding="utf-8")
print("Wrote:", ", ".join(p.name for p in sorted(out.glob("*.txt"))))
PY
echo ""

echo "=== 5. Manual channels (you post with your account) ==="
python3 - <<'PY' "${OUT_DIR}/promo.json"
import json, sys
data = json.load(open(sys.argv[1]))
for item in data.get("directories", []):
    print(f"- {item['name']}: {item['url']}")
    print(f"    {item['action']}")
PY
echo ""
echo "=== 6. Search Console / Bing Webmaster (one-time) ==="
echo "  Add property ${NOTES_URL#https://} and submit sitemap: ${SITEMAP_URL}"
echo ""
echo "Done. Re-run after deploy or copy changes."
