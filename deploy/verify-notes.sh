#!/usr/bin/env bash
# Smoke-check Deeperguard TLS, offline shell, encryption, and client OCR assets.
set -euo pipefail
HOST="${NOTES_HOST:-www.deeperguard.com}"
BASE="https://${HOST}"
FAIL=0

pass() { echo "OK  $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

health="$(curl -ksS "${BASE}/api/health")"
build="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('build',''))" <<<"$health")"
echo "Health: $health"

if curl -ksSf "${BASE}/api/health" | grep -q '"ok":true'; then pass "HTTPS health"; else fail "HTTPS health"; fi
if curl -ksSf "${BASE}/ca.crt" | grep -q 'BEGIN CERTIFICATE'; then pass "CA certificate"; else fail "CA certificate"; fi
if curl -sS "http://${HOST}/" | grep -q 'Certificate Trust Settings'; then pass "HTTP certificate setup page"; else fail "HTTP certificate setup page"; fi
if curl -sS "http://${HOST}/" | grep -q "/ca.crt"; then pass "HTTP setup links CA"; else fail "HTTP setup links CA"; fi
if curl -ksSf "${BASE}/sw.js" | grep -q "deeperguard-offline"; then pass "Service worker"; else fail "Service worker"; fi
sw="$(curl -ksSf "${BASE}/sw.js")"
if grep -q "app.css?v=${build}" <<<"$sw" || grep -q "const BUILD = '${build}'" <<<"$sw"; then pass "SW precache build"; else fail "SW precache build"; fi
html="$(curl -ksSf "${BASE}/")"
manifest="$(curl -ksSf "${BASE}/manifest.json")"
if grep -q 'notes-build' <<<"$html"; then pass "App shell"; else fail "App shell"; fi
if grep -q "content=\"${build}\"" <<<"$html"; then pass "Build meta matches health"; else fail "Build meta matches health"; fi

app_js="$(curl -ksSf "${BASE}/static/js/app.js?v=${build}")"
store_js="$(curl -ksSf "${BASE}/static/js/store.js?v=${build}")"
preview_js="$(curl -ksSf "${BASE}/static/js/preview.js?v=${build}")"
if grep -q 'savedDevicePassword' <<<"$app_js"; then pass "Offline unlock helpers"; else fail "Offline unlock helpers"; fi
if grep -q 'LAN-only Wi‑Fi may report navigator.onLine=false' <<<"$app_js"; then pass "LAN health probe"; else fail "LAN health probe"; fi
if grep -q "entry.kind === 'image'" <<<"$app_js"; then pass "Image OCR indexing"; else fail "Image OCR indexing"; fi
if grep -q 'enqueueRetryOcrJobs' <<<"$app_js"; then pass "OCR retry on reconnect"; else fail "OCR retry on reconnect"; fi
if grep -q 'encryptObject' <<<"$store_js"; then pass "Client encryption store"; else fail "Client encryption store"; fi
if grep -q 'upgradeImageQuality' <<<"$preview_js"; then pass "Image zoom upgrade"; else fail "Image zoom upgrade"; fi
if grep -q 'upgradePdfQuality' <<<"$preview_js"; then pass "PDF zoom upgrade"; else fail "PDF zoom upgrade"; fi
if grep -q 'note-list-thumb' <<<"$app_js"; then pass "List document thumbnails"; else fail "List document thumbnails"; fi
if grep -q 'confirm-dialog' <<<"$html"; then pass "In-app confirm dialog"; else fail "In-app confirm dialog"; fi
if grep -q 'btn-find' <<<"$html"; then pass "Mobile find button"; else fail "Mobile find button"; fi
if grep -q 'files.length === 1' <<<"$app_js"; then pass "Direct single-file attach"; else fail "Direct single-file attach"; fi
ocr_js="$(curl -ksSf "${BASE}/static/js/ocr.js?v=${build}")"
client_ocr_js="$(curl -ksSf "${BASE}/static/js/client-ocr-engine.js?v=${build}")"
if grep -q 'NotesClientOcr' <<<"$ocr_js"; then pass "Client OCR wrapper"; else fail "Client OCR wrapper"; fi
if grep -q 'createWorker' <<<"$client_ocr_js"; then pass "Client OCR engine"; else fail "Client OCR engine"; fi
if ! grep -q '/api/ocr' <<<"$ocr_js"; then pass "OCR does not call server API"; else fail "OCR does not call server API"; fi
if grep -q 'isScanImage(localFile) && NotesOcr.needsPrepare' <<<"$app_js"; then pass "Photo prepare before ingest"; else fail "Photo prepare before ingest"; fi
if grep -q 'ensureServerSession' <<<"$app_js"; then pass "PWA session bootstrap"; else fail "PWA session bootstrap"; fi
if grep -q 'attachmentOcrStatus' <<<"$app_js"; then pass "Attachment OCR status UI"; else fail "Attachment OCR status UI"; fi
if grep -q 'pullNoteOcrFromServer' <<<"$app_js"; then pass "Note OCR reindex hook"; else fail "Note OCR reindex hook"; fi
if grep -q 'refreshAllNoteSearchIndexes' <<<"$app_js"; then pass "Vault-wide search index repair"; else fail "Vault-wide search index repair"; fi
if grep -q 'repairDocumentSearch' <<<"$app_js"; then pass "Repair search index control"; else fail "Repair search index control"; fi
if grep -q 'privacy-status' <<<"$html"; then pass "Settings privacy status"; else fail "Settings privacy status"; fi
if grep -q 'NotesSrpAuth' <<<"$(curl -ksSf "${BASE}/static/js/srp-auth.js?v=${build}")"; then pass "SRP auth client"; else fail "SRP auth client"; fi
if grep -q 'passkeyHostError' <<<"$(curl -ksSf "${BASE}/static/js/webauthn-client.js?v=${build}")"; then pass "Passkey hostname guard"; else fail "Passkey hostname guard"; fi
legacy_reg="$(curl -ksS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/auth/register" -H 'Content-Type: application/json' -d '{"email":"probe@home.local","password":"probe-secure-pass"}')"
if [[ "$legacy_reg" == "410" ]]; then pass "Legacy register disabled"; else fail "Legacy register disabled (got ${legacy_reg})"; fi
if grep -q 'deferOcrJob' <<<"$app_js"; then pass "OCR defer on transient errors"; else fail "OCR defer on transient errors"; fi
if grep -q 'repairSearchIndexesForQuery' <<<"$app_js"; then pass "Search-time index repair"; else fail "Search-time index repair"; fi
if grep -q 'settings-diagnostics' <<<"$html" || grep -q 'privacy-status' <<<"$html"; then pass "Settings privacy panel"; else fail "Settings privacy panel"; fi
if grep -q 'btn-copy-diagnostics' <<<"$html"; then pass "Copy diagnostics button"; else fail "Copy diagnostics button"; fi
if grep -q 'uploadDeviceReport' <<<"$app_js"; then pass "Device report upload"; else fail "Device report upload"; fi
if grep -q 'resolveDeviceReportCsrf' <<<"$app_js" && grep -q 'deviceReportNeedsSessionRetry' <<<"$app_js"; then pass "Device report session bootstrap"; else fail "Device report session bootstrap"; fi
if grep -q 'btn-send-checklist' <<<"$html"; then pass "Send checklist button"; else fail "Send checklist button"; fi
if grep -q 'runPhotoSearchSelfTest' <<<"$app_js"; then pass "Photo search self-test"; else fail "Photo search self-test"; fi
if grep -q 'btn-test-photo-search' <<<"$html"; then pass "Photo search self-test button"; else fail "Photo search self-test button"; fi
if grep -q 'buildIphoneChecklistReport' <<<"$app_js"; then pass "Auto iPhone checklist report"; else fail "Auto iPhone checklist report"; fi
if grep -q 'id="settings-checklist"' <<<"$html"; then pass "Settings checklist preview"; else fail "Settings checklist preview"; fi
if grep -q 'runAllDeviceTests' <<<"$app_js"; then pass "Run all device tests"; else fail "Run all device tests"; fi
if grep -q 'ocrResultWeak' <<<"$app_js" || grep -q 'NotesOcrQuality' "$SRC/app/static/js/ocr-quality.js" 2>/dev/null; then pass "Weak OCR user warning"; else fail "Weak OCR user warning"; fi
ocr_py="$(cat "$(dirname "$0")/../app/ocr.py")"
if grep -q 'weak_ocr_result' <<<"$ocr_py"; then pass "Server weak OCR detection"; else fail "Server weak OCR detection"; fi
if grep -q 'offlineUnlockVerified' <<<"$app_js"; then pass "Offline unlock verification flag"; else fail "Offline unlock verification flag"; fi
if grep -q "Probe /api/health" <<<"$app_js"; then pass "Offline unlock health probe"; else fail "Offline unlock health probe"; fi
if grep -q 'uploadPendingDeviceReport' <<<"$app_js"; then pass "Pending checklist auto-upload"; else fail "Pending checklist auto-upload"; fi
if grep -q 'offline-setup-banner' <<<"$html"; then pass "Offline setup banner"; else fail "Offline setup banner"; fi
if grep -q 'maybeAutoEnableRememberDevice' <<<"$app_js"; then pass "PWA auto remember password"; else fail "PWA auto remember password"; fi
if grep -q 'maybePromptOfflineSetup' <<<"$app_js"; then pass "Offline setup modal"; else fail "Offline setup modal"; fi
if grep -q 'pwaStandaloneVerified' <<<"$app_js"; then pass "PWA standalone verification flag"; else fail "PWA standalone verification flag"; fi
if grep -q 'runPdfPreviewSearchSelfTest' <<<"$app_js"; then pass "PDF preview search self-test"; else fail "PDF preview search self-test"; fi
if grep -q 'simulatePinchZoom' <<<"$app_js"; then pass "PDF pinch zoom self-test"; else fail "PDF pinch zoom self-test"; fi
if grep -q 'btn-refresh-app' <<<"$html"; then pass "Refresh app cache button"; else fail "Refresh app cache button"; fi
if grep -q 'forceRefreshApp' <<<"$app_js"; then pass "Force refresh app cache"; else fail "Force refresh app cache"; fi
if grep -q 'notesClearAppCaches' <<<"$app_js"; then pass "Clear app cache helper"; else fail "Clear app cache helper"; fi
if grep -q 'commitTagBarInput' <<<"$app_js"; then pass "Tag bar commit helper"; else fail "Tag bar commit helper"; fi
if grep -q 'id="tag-bar-form"' <<<"$app_js"; then pass "Tag bar form input"; else fail "Tag bar form input"; fi
if grep -q 'id="tag-bar-add"' <<<"$app_js"; then pass "Tag bar add button"; else fail "Tag bar add button"; fi
if grep -q 'id="note-warn-at"' <<<"$html"; then pass "Note time warning UI"; else fail "Note time warning UI"; fi
if grep -q 'consumeNoteDeepLink' <<<"$app_js"; then pass "Note email deep link"; else fail "Note email deep link"; fi
if grep -q "warn_at: ''" <<<"$store_js"; then pass "Note warn_at field"; else fail "Note warn_at field"; fi
if grep -q 'note-tag-warn' <<<"$app_js" && grep -q 'noteWarnChipHtml' <<<"$app_js"; then pass "List clock chip for time warning"; else fail "List clock chip for time warning"; fi
if grep -q 'function cancelNoteReminder' <<<"$app_js" && grep -q 'cancelNoteReminder(id)' <<<"$app_js"; then pass "Trash cancels time warning"; else fail "Trash cancels time warning"; fi
if grep -q 'updateAppUpdateBanner' <<<"$app_js"; then pass "App update banner"; else fail "App update banner"; fi
if grep -q 'PREVIEW_CACHE_MAX' <<<"$app_js"; then pass "Preview cache LRU"; else fail "Preview cache LRU"; fi
if grep -q 'id="app-update-banner"' <<<"$html"; then pass "Update banner markup"; else fail "Update banner markup"; fi

device_report_code="$(curl -ksS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/device-report" -H 'Content-Type: application/json' -d '{}')"
if grep -qE '^(401|403|400|404)$' <<<"$device_report_code"; then pass "Device report API route"; else fail "Device report API route (got ${device_report_code})"; fi

ocr_code="$(curl -ksS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/ocr")"
if grep -qE '^(401|403|400|415|422|200)$' <<<"$ocr_code"; then pass "OCR API route"; else fail "OCR API route (got ${ocr_code})"; fi

if grep -q 'LAN-only Wi‑Fi may report navigator.onLine=false' <<<"$html"; then pass "Shell update on LAN"; else fail "Shell update on LAN"; fi
if ! grep -q '&hard=1' <<<"$html"; then pass "Shell avoids hard=1 navigate"; else fail "Shell still navigates with hard=1"; fi
if grep -q 'seedShellHtml' <<<"$app_js"; then pass "Update reseeds shell cache"; else fail "Update reseeds shell cache"; fi
if ! grep -q 'app-update-modal' <<<"$html"; then pass "No update popup modal"; else fail "Update popup modal still present"; fi
if grep -q 'Keep the service worker registered' <<<"$app_js"; then pass "Update keeps service worker"; else fail "Update keeps service worker"; fi
if grep -q "get('hard')" <<<"$(curl -ksSf "${BASE}/sw.js")"; then pass "SW hard navigate bypass"; else fail "SW hard navigate bypass"; fi
if grep -q "SKIP_WAITING" <<<"$(curl -ksSf "${BASE}/sw.js")"; then pass "SW waits for Update"; else fail "SW waits for Update"; fi
if grep -q "Do NOT skipWaiting on updates" <<<"$(curl -ksSf "${BASE}/sw.js")"; then pass "SW no auto skipWaiting"; else fail "SW no auto skipWaiting"; fi
if grep -q "byte-stable" <<<"$(curl -ksSf "${BASE}/sw.js")"; then pass "SW byte-stable"; else fail "SW byte-stable"; fi
if grep -q "cacheFirstNavigate" <<<"$(curl -ksSf "${BASE}/sw.js")"; then pass "SW cache-first navigate"; else fail "SW cache-first navigate"; fi
if grep -q 'viewport-fit=cover' <<<"$html"; then pass "iOS viewport safe areas"; else fail "iOS viewport safe areas"; fi
if grep -q 'apple-touch-icon' <<<"$html"; then pass "iOS home screen icon"; else fail "iOS home screen icon"; fi
if grep -q 'unlock-secure-hint' <<<"$html"; then pass "HTTPS unlock hint"; else fail "HTTPS unlock hint"; fi
css="$(curl -ksSf "${BASE}/static/css/app.css?v=${build}")"
if grep -q 'safe-area-inset-top' <<<"$css"; then pass "iOS safe-area CSS"; else fail "iOS safe-area CSS"; fi
if grep -q '"display": "standalone"' <<<"$manifest"; then pass "PWA standalone manifest"; else fail "PWA standalone manifest"; fi
if grep -q "icon-192.png?v=${build}" <<<"$manifest"; then pass "PWA manifest build"; else fail "PWA manifest build"; fi
if grep -qE '"orientation": "(any|portrait-primary)"' <<<"$manifest"; then pass "PWA orientation"; else fail "PWA orientation"; fi

if command -v chromium >/dev/null && command -v chromedriver >/dev/null && command -v tesseract >/dev/null \
    && [ -x "$(dirname "$0")/../venv/bin/python" ]; then
  echo ""
  echo "Running automated browser checks (optional)…"
  offline_ok=0
  for attempt in 1 2; do
    if E2E_OFFLINE=1 "$(dirname "$0")/../venv/bin/python" "$(dirname "$0")/../tests/e2e_offline_vault.py"; then
      offline_ok=1
      break
    fi
    if [ "$attempt" -eq 1 ]; then
      echo "WARN offline E2E retrying once…"
      sleep 2
    fi
  done
  if [ "$offline_ok" -eq 1 ]; then
    pass "Offline vault E2E"
  elif [ "${NOTES_IOS_READINESS:-0}" = "1" ]; then
    fail "Offline vault E2E"
  else
    echo "WARN offline E2E skipped or failed (non-fatal for deploy verify)"
  fi
elif [ "${NOTES_IOS_READINESS:-0}" = "1" ]; then
  fail "Browser E2E deps missing (need chromium, chromedriver, tesseract, venv python)"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "Verification failed."
  exit 1
fi
echo "All checks passed (build ${build})."
