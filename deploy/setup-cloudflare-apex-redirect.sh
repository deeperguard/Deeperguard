#!/usr/bin/env bash
# Point apex deeperguard.com at Cloudflare and 301 redirect to www.
#
# Fixes the common misconfig where apex has a stale A record to a home IP
# (HTTPS fails) while www is proxied through the tunnel.
#
# Usage:
#   export CLOUDFLARE_API_TOKEN='...'
#   bash deploy/setup-cloudflare-apex-redirect.sh
#
# Token permissions (Account cfat_ tokens often lack Zone DNS Edit):
#   - Cloudflare Tunnel Write (tunnel ingress + hostname route)
#   - Dynamic URL Redirects Write (apex -> www redirect)
#   - Zone DNS Edit (optional; without it you must fix apex DNS manually)
#
# Optional:
#   CF_ZONE_NAME=deeperguard.com
#   CF_WWW_HOST=www.deeperguard.com
#   CF_TUNNEL_NAME=homelab-notes
#   CF_TUNNEL_ID=<uuid>                 # skip tunnel lookup when set
set -euo pipefail

TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
EMAIL="${CF_EMAIL:-}"
API_KEY="${CF_API_KEY:-}"
ZONE_NAME="${CF_ZONE_NAME:-deeperguard.com}"
WWW_HOST="${CF_WWW_HOST:-www.${ZONE_NAME}}"
TUNNEL_NAME="${CF_TUNNEL_NAME:-homelab-notes}"
TUNNEL_ID="${CF_TUNNEL_ID:-}"
RULE_DESC="Deeperguard apex to www"
CF_API="https://api.cloudflare.com/client/v4"
DNS_OK=0

if [[ -z "$TOKEN" && ( -z "$EMAIL" || -z "$API_KEY" ) ]]; then
  echo "Set CLOUDFLARE_API_TOKEN (preferred) or CF_EMAIL + CF_API_KEY (Global API Key)." >&2
  if [[ -n "${CF_PASSWORD:-}" && -z "$API_KEY" ]]; then
    echo "Note: CF_PASSWORD is your Cloudflare login password — it cannot call the API." >&2
    echo "Create an API token at https://dash.cloudflare.com/profile/api-tokens" >&2
    echo "  (Cloudflare Tunnel Write + Dynamic URL Redirects Write; Zone DNS Edit if possible)" >&2
    echo "Account tokens (cfat_) often cannot edit DNS — use a User token (cfut_) with Zone DNS Edit." >&2
  fi
  exit 1
fi

cf_api() {
  local method="$1" path="$2" data="${3:-}"
  local -a headers=(-H "Content-Type: application/json")
  if [[ -n "$TOKEN" ]]; then
    headers+=(-H "Authorization: Bearer ${TOKEN}")
  else
    headers+=(-H "X-Auth-Email: ${EMAIL}" -H "X-Auth-Key: ${API_KEY}")
  fi
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "${CF_API}${path}" "${headers[@]}" --data "$data"
  else
    curl -sS -X "$method" "${CF_API}${path}" "${headers[@]}"
  fi
}

cf_ok() {
  python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" <<<"$1"
}

build_rule_json() {
  ZONE_NAME="$ZONE_NAME" WWW_HOST="$WWW_HOST" RULE_DESC="$RULE_DESC" python3 - <<'PY'
import json, os
zone = os.environ["ZONE_NAME"]
www = os.environ["WWW_HOST"]
desc = os.environ["RULE_DESC"]
print(json.dumps({
    "description": desc,
    "expression": f'(http.host eq "{zone}")',
    "action": "redirect",
    "enabled": True,
    "action_parameters": {
        "from_value": {
            "status_code": 301,
            "preserve_query_string": True,
            "target_url": {
                "expression": f'concat("https://{www}", http.request.uri.path)'
            }
        }
    }
}))
PY
}

print_manual_dns() {
  echo ""
  echo "Manual DNS required (token lacks Zone DNS Edit):" >&2
  echo "  https://dash.cloudflare.com/${ZONE_ID}/${ZONE_NAME}/dns/records" >&2
  echo "  1. Delete A/AAAA for ${ZONE_NAME} (home IP ${HOME_IP:-?})" >&2
  echo "  2. Add CNAME @ -> ${TUNNEL_ID}.cfargotunnel.com (proxied / orange cloud)" >&2
}

echo "Resolving zone ${ZONE_NAME}…"
ZONE_ID="$(cf_api GET "/zones?name=${ZONE_NAME}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")"
if [[ -z "$ZONE_ID" ]]; then
  echo "Could not resolve zone ${ZONE_NAME}." >&2
  exit 1
fi
echo "Zone ID: ${ZONE_ID}"

ACCOUNT_ID="$(cf_api GET "/accounts?per_page=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")"
if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Could not resolve Cloudflare account." >&2
  exit 1
fi

if [[ -z "$TUNNEL_ID" ]]; then
  TUNNEL_ID="$(cf_api GET "/accounts/${ACCOUNT_ID}/cfd_tunnel" | python3 -c "
import json,sys
name='${TUNNEL_NAME}'
for t in json.load(sys.stdin).get('result',[]):
    if t.get('name')==name:
        print(t.get('id',''))
        break
")"
fi
if [[ -z "$TUNNEL_ID" ]]; then
  echo "Could not find tunnel ${TUNNEL_NAME}. Set CF_TUNNEL_ID or run setup-cloudflare-tunnel.sh first." >&2
  exit 1
fi
echo "Tunnel ID: ${TUNNEL_ID}"

echo "Ensuring tunnel ingress includes ${ZONE_NAME}…"
CFG_JSON="$(cf_api GET "/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations")"
INGRESS_UPDATED="$(python3 -c "
import json, sys
zone='${ZONE_NAME}'
origin='http://127.0.0.1:80'
cfg=json.load(sys.stdin).get('result',{}).get('config',{})
ingress=list(cfg.get('ingress') or [])
hosts=[(r.get('hostname') or '').lower() for r in ingress if r.get('hostname')]
if zone.lower() in hosts:
    print('skip')
    sys.exit(0)
# insert apex before catch-all
out=[]
inserted=False
for r in ingress:
    svc=r.get('service','')
    if not inserted and svc.startswith('http_status:'):
        out.append({'hostname': zone, 'service': origin, 'originRequest': {}})
        inserted=True
    out.append(r)
if not inserted:
    out.insert(0, {'hostname': zone, 'service': origin, 'originRequest': {}})
print(json.dumps({'config': {'ingress': out}}))
" <<<"$CFG_JSON")"
if [[ "$INGRESS_UPDATED" != "skip" ]]; then
  ingress_resp="$(cf_api PUT "/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" "$INGRESS_UPDATED")"
  if ! cf_ok "$ingress_resp"; then
    echo "Tunnel ingress update failed: $(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$ingress_resp")" >&2
    exit 1
  fi
  echo "Tunnel ingress updated."
else
  echo "Tunnel ingress already includes ${ZONE_NAME}."
fi

echo "Updating apex DNS (@) -> ${TUNNEL_ID}.cfargotunnel.com (proxied)…"
HOME_IP="$(python3 -c "
import json,sys
for r in json.load(sys.stdin).get('result',[]):
    if r.get('type')=='A':
        print(r.get('content',''))
        break
" <<<"$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=A&name=${ZONE_NAME}")")"

dns_probe="$(cf_api POST "/zones/${ZONE_ID}/dns_records" '{"type":"TXT","name":"_cf-dns-probe","content":"probe","ttl":120}')"
if cf_ok "$dns_probe"; then
  probe_id="$(python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])" <<<"$dns_probe")"
  cf_api DELETE "/zones/${ZONE_ID}/dns_records/${probe_id}" >/dev/null || true
  for rtype in A AAAA; do
    old_resp="$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=${rtype}&name=${ZONE_NAME}")"
    while IFS= read -r rid; do
      [[ -z "$rid" ]] && continue
      del_resp="$(cf_api DELETE "/zones/${ZONE_ID}/dns_records/${rid}")"
      if cf_ok "$del_resp"; then
        echo "  removed ${rtype} ${ZONE_NAME} (${rid})"
      else
        echo "  WARN: could not remove ${rtype} ${ZONE_NAME} (${rid})" >&2
      fi
    done < <(python3 -c "import json,sys; [print(r['id']) for r in json.load(sys.stdin).get('result',[])]" <<<"$old_resp")
  done
  existing_resp="$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=CNAME&name=${ZONE_NAME}")"
  existing="$(python3 -c "import json,sys; r=json.load(sys.stdin).get('result',[]); print(r[0]['id'] if r else '')" <<<"$existing_resp")"
  dns_body="{\"type\":\"CNAME\",\"proxied\":true,\"name\":\"@\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"ttl\":1}"
  if [[ -n "$existing" ]]; then
    dns_resp="$(cf_api PUT "/zones/${ZONE_ID}/dns_records/${existing}" "$dns_body")"
  else
    dns_resp="$(cf_api POST "/zones/${ZONE_ID}/dns_records" "$dns_body")"
  fi
  if cf_ok "$dns_resp"; then
    DNS_OK=1
    echo "Apex DNS updated."
  else
    echo "DNS update failed: $(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$dns_resp")" >&2
  fi
else
  echo "DNS API write denied (Account tokens often lack Zone DNS Edit)." >&2
  route_resp="$(cf_api POST "/accounts/${ACCOUNT_ID}/zerotrust/routes/hostname" "{\"hostname\":\"${ZONE_NAME}\",\"tunnel_id\":\"${TUNNEL_ID}\",\"comment\":\"apex via setup-cloudflare-apex-redirect\"}")"
  if cf_ok "$route_resp"; then
    echo "Registered Zero Trust hostname route for ${ZONE_NAME} -> tunnel ${TUNNEL_NAME}."
  else
    err="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$route_resp")"
    if python3 -c "import json,sys; errs=json.load(sys.stdin).get('errors',[]); print(any('already exists' in str(e).lower() or e.get('code') in (1099,1100,1004) for e in errs))" <<<"$route_resp" 2>/dev/null | grep -q True; then
      echo "Hostname route for ${ZONE_NAME} already exists."
    else
      echo "Hostname route failed: ${err}" >&2
    fi
  fi
  print_manual_dns
fi

echo "Installing redirect rule ${ZONE_NAME} -> https://${WWW_HOST}…"
ENTRY_JSON="$(cf_api GET "/zones/${ZONE_ID}/rulesets/phases/http_request_dynamic_redirect/entrypoint")"
RULESET_ID="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('result',{}).get('id',''))" <<<"$ENTRY_JSON")"
RULE_PAYLOAD="$(build_rule_json)"

if [[ -z "$RULESET_ID" ]]; then
  create_body="$(python3 -c "
import json, os, sys
rule = json.loads(sys.stdin.read())
print(json.dumps({
  'name': 'Deeperguard redirect rules',
  'kind': 'zone',
  'phase': 'http_request_dynamic_redirect',
  'rules': [rule],
}))
" <<<"$RULE_PAYLOAD")"
  create_resp="$(cf_api POST "/zones/${ZONE_ID}/rulesets" "$create_body")"
  if ! cf_ok "$create_resp"; then
    echo "Redirect ruleset create failed: $(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$create_resp")" >&2
    exit 1
  fi
  echo "Created redirect ruleset."
else
  EXISTING_RULE="$(python3 -c "
import json,sys
desc='${RULE_DESC}'
zone='${ZONE_NAME}'
for r in json.load(sys.stdin).get('result',{}).get('rules',[]) or []:
    if r.get('description')==desc:
        print(r.get('id',''))
        break
    expr=(r.get('expression') or '').lower()
    if zone.lower() in expr and 'redirect' in (r.get('action') or ''):
        print(r.get('id',''))
        break
" <<<"$ENTRY_JSON")"
  if [[ -n "$EXISTING_RULE" ]]; then
    echo "Updating existing redirect rule ${EXISTING_RULE}…"
    rule_resp="$(cf_api PUT "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${EXISTING_RULE}" "$RULE_PAYLOAD")"
  else
    echo "Adding redirect rule to ruleset ${RULESET_ID}…"
    rule_resp="$(cf_api POST "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules" "$RULE_PAYLOAD")"
  fi
  if ! cf_ok "$rule_resp"; then
    err="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$rule_resp")"
    has_rule="$(python3 -c "
import json,sys
zone='${ZONE_NAME}'.lower()
for r in json.load(sys.stdin).get('result',{}).get('rules',[]) or []:
    expr=(r.get('expression') or '').lower()
    if zone in expr and r.get('action')=='redirect' and r.get('enabled', True):
        print('yes')
        break
" <<<"$ENTRY_JSON")"
    if [[ "$has_rule" == "yes" ]]; then
      echo "Redirect rule update denied (${err}); existing apex redirect rule kept."
    else
      echo "Redirect rule failed: ${err}" >&2
      exit 1
    fi
  else
    echo "Redirect rule installed."
  fi
fi

if [[ "$DNS_OK" == "1" ]]; then
  echo ""
  echo "Waiting for DNS/edge propagation (up to 60s)…"
  for _ in $(seq 1 12); do
    loc="$(curl -ksS -o /dev/null -D - --connect-timeout 8 "https://${ZONE_NAME}/" 2>/dev/null | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r' | head -1 || true)"
    if [[ "$loc" == "https://${WWW_HOST}/" || "$loc" == https://${WWW_HOST}/* ]]; then
      echo "OK  https://${ZONE_NAME}/ -> ${loc}"
      break
    fi
    code="$(curl -ksS -o /dev/null -w '%{http_code}' --connect-timeout 8 "https://${ZONE_NAME}/api/health" 2>/dev/null || echo 000)"
    if [[ "$code" == "200" ]]; then
      echo "OK  https://${ZONE_NAME}/api/health -> 200"
      break
    fi
    sleep 5
  done
fi

echo ""
if [[ "$DNS_OK" == "1" ]]; then
  echo "Done. Apex should redirect to https://${WWW_HOST}/"
else
  echo "Partial setup complete (tunnel ingress + redirect rule)."
  echo "Finish by fixing apex DNS manually, then verify:"
fi
echo "Verify: curl -sI https://${ZONE_NAME}/ | grep -i location"

if [[ "$DNS_OK" != "1" ]]; then
  exit 2
fi
