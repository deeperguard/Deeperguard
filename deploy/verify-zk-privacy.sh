#!/usr/bin/env bash
# Verify zero-knowledge auth, DNS, and client encryption markers.
set -euo pipefail
HOST="${NOTES_HOST:-www.deeperguard.com}"
IP="${NOTES_IP:-www.deeperguard.com}"
DNS="${NOTES_DNS:-}"
BASE="https://${HOST}"
FAIL=0

pass() { echo "OK  $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

if dig @"${DNS}" "${HOST}" +short 2>/dev/null | grep -q "${IP}"; then
  pass "DNS ${HOST} -> ${IP}"
else
  fail "DNS ${HOST} -> ${IP} (check AdGuard rewrite)"
fi

if curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/api/health" | grep -q '"ok":true'; then
  pass "HTTPS health on ${HOST}"
else
  fail "HTTPS health on ${HOST}"
fi

build="$(curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('build',''))")"
app_js="$(curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/static/js/app.js?v=${build}")"
store_js="$(curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/static/js/store.js?v=${build}")"
srp_js="$(curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/static/js/srp-auth.js?v=${build}")"

if grep -q 'NotesSrpAuth' <<<"$srp_js"; then pass "SRP client"; else fail "SRP client"; fi
if grep -q 'encryptObject' <<<"$store_js"; then pass "Client vault encryption"; else fail "Client vault encryption"; fi
html="$(curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/")"
if grep -q 'privacy-status' <<<"$html"; then pass "Privacy status in settings"; else fail "Privacy status in settings"; fi
if grep -q 'passkeyHostError' <<<"$app_js" || curl -ksSf --resolve "${HOST}:443:${IP}" "${BASE}/static/js/webauthn-client.js?v=${build}" | grep -q 'passkeyHostError'; then
  pass "Passkey hostname guard"
else
  fail "Passkey hostname guard"
fi

legacy_code="$(curl -ksS -o /dev/null -w '%{http_code}' --resolve "${HOST}:443:${IP}" -X POST "${BASE}/api/auth/register" -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"long-enough-pass"}')"
if [[ "$legacy_code" == "410" ]]; then pass "Legacy register disabled"; else fail "Legacy register disabled (got ${legacy_code})"; fi

unlock_code="$(curl -ksS -o /dev/null -w '%{http_code}' --resolve "${HOST}:443:${IP}" -X POST "${BASE}/api/account/unlock" -H 'Content-Type: application/json' -d '{}')"
if [[ "$unlock_code" == "401" || "$unlock_code" == "403" || "$unlock_code" == "404" ]]; then
  pass "Unlock requires session (no password on wire)"
else
  fail "Unlock requires session (got ${unlock_code})"
fi

verify_code="$(curl -ksS -o /dev/null -w '%{http_code}' --resolve "${HOST}:443:${IP}" -X POST "${BASE}/api/auth/verify-vault" -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"long-enough-pass"}')"
if [[ "$verify_code" == "410" ]]; then pass "Server vault verify disabled (strict ZK)"; else fail "Server vault verify disabled (got ${verify_code})"; fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "Zero-knowledge verification failed."
  exit 1
fi
echo "Zero-knowledge privacy checks passed."
