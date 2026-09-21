#!/usr/bin/env bash
# Create Cloudflare WAF rate-limit rules for Deeperguard auth endpoints.
# Usage:
#   export CLOUDFLARE_API_TOKEN='...'   # Zone DNS Edit + WAF Edit
#   export CF_ZONE_NAME='deeperguard.com'
#   bash deploy/setup-cloudflare-rate-limits.sh
set -euo pipefail

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ZONE_NAME="${CF_ZONE_NAME:-deeperguard.com}"
CF_API="https://api.cloudflare.com/client/v4"

if [[ -z "$TOKEN" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN with Zone WAF Edit permission." >&2
  exit 1
fi

cf_api() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "${CF_API}${path}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$data"
  else
    curl -sS -X "$method" "${CF_API}${path}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json"
  fi
}

ZONE_ID="$(cf_api GET "/zones?name=${ZONE_NAME}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")"
if [[ -z "$ZONE_ID" ]]; then
  echo "Could not resolve zone ${ZONE_NAME}" >&2
  exit 1
fi
echo "Zone: ${ZONE_ID} (${ZONE_NAME})"

# Use custom ruleset (http_request_firewall_custom) when available.
RULESET_JSON="$(cf_api GET "/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint")"
RULESET_ID="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('id',''))" <<<"$RULESET_JSON")"

if [[ -z "$RULESET_ID" ]]; then
  echo "Could not find http_request_firewall_custom ruleset. Create rate limits manually:" >&2
  echo "  Security → WAF → Custom rules → Block when path starts with /api/auth/ and rate > 30/min per IP" >&2
  exit 1
fi

RULE_DESC="Deeperguard auth rate limit"
EXISTING="$(python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('result',{}).get('rules',[]) or []:
    if r.get('description')=='''${RULE_DESC}''':
        print(r.get('id',''))
        break
" <<<"$RULESET_JSON")"

PAYLOAD='{
  "description": "Deeperguard auth rate limit",
  "expression": "(http.request.uri.path contains \"/api/auth/\")",
  "action": "block",
  "ratelimit": {
    "characteristics": ["ip.src"],
    "period": 60,
    "requests_per_period": 30,
    "mitigation_timeout": 60
  }
}'

if [[ -n "$EXISTING" ]]; then
  echo "Updating existing rule ${EXISTING}…"
  RESP="$(cf_api PUT "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${EXISTING}" "$PAYLOAD")"
else
  echo "Creating auth rate-limit rule…"
  RESP="$(cf_api POST "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules" "$PAYLOAD")"
fi

python3 -c "import json,sys; d=json.load(sys.stdin); print('ok', d.get('success'), d.get('errors'))" <<<"$RESP"
echo "Rate limit active: /api/auth/* → 30 requests / minute / IP (block 60s)."
