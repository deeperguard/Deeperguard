#!/usr/bin/env bash
# Create a Cloudflare Tunnel + DNS for Deeperguard (API token required).
# Usage (on CT 143 or from deploy host with SSH):
#   export CLOUDFLARE_API_TOKEN='...'   # Account: Cloudflare Tunnel Edit + Zone DNS Edit
#   export CF_ZONE_NAME='deeperguard.com'
#   export CF_HOSTNAMES='www.deeperguard.com,deeperguard.com'
#   bash deploy/setup-cloudflare-tunnel.sh
set -euo pipefail

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ZONE_NAME="${CF_ZONE_NAME:-deeperguard.com}"
HOSTNAMES="${CF_HOSTNAMES:-www.deeperguard.com,deeperguard.com}"
TUNNEL_NAME="${CF_TUNNEL_NAME:-deeperguard}"
ORIGIN="${CF_ORIGIN:-http://127.0.0.1:80}"
CF_API="https://api.cloudflare.com/client/v4"

if [[ -z "$TOKEN" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN (Account: Cloudflare Tunnel Edit + Zone: DNS Edit)." >&2
  exit 1
fi

if [[ "$TOKEN" == cfat_* ]]; then
  echo "Using Account API token (cfat_ prefix)."
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

echo "Resolving Cloudflare account and zone…"
ACCOUNT_ID="$(cf_api GET "/accounts?per_page=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")"
ZONE_ID="$(cf_api GET "/zones?name=${ZONE_NAME}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")"
if [[ -z "$ACCOUNT_ID" ]]; then
  echo "Could not resolve Cloudflare account." >&2
  exit 1
fi
if [[ -z "$ZONE_ID" ]]; then
  echo "WARN: No access to zone ${ZONE_NAME}. Token needs Zone → DNS → Edit for that zone." >&2
  echo "Tunnel will be created; add DNS manually in Cloudflare:" >&2
  echo "  CNAME notes -> <TUNNEL_ID>.cfargotunnel.com (proxied)" >&2
  echo "  CNAME www  -> <TUNNEL_ID>.cfargotunnel.com (proxied)" >&2
  SKIP_DNS=1
fi
echo "Account: ${ACCOUNT_ID}"
echo "Zone:    ${ZONE_ID} (${ZONE_NAME})"

echo "Creating tunnel ${TUNNEL_NAME}…"
set +e
TUNNEL_JSON="$(cf_api POST "/accounts/${ACCOUNT_ID}/cfd_tunnel" "{\"name\":\"${TUNNEL_NAME}\",\"config_src\":\"cloudflare\"}")"
POST_OK="$(python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))" <<<"$TUNNEL_JSON" 2>/dev/null)"
set -e
if [[ "$POST_OK" != "True" ]]; then
  if python3 -c "import json,sys; errs=json.load(sys.stdin).get('errors',[]); print(any(e.get('code')==1013 for e in errs))" <<<"$TUNNEL_JSON" 2>/dev/null | grep -q True; then
    echo "Tunnel ${TUNNEL_NAME} already exists — reusing."
    TUNNEL_JSON="$(cf_api GET "/accounts/${ACCOUNT_ID}/cfd_tunnel" | python3 -c "
import json,sys
name='${TUNNEL_NAME}'
for t in json.load(sys.stdin).get('result',[]):
    if t.get('name')==name:
        print(json.dumps({'result': t}))
        break
")"
    TUNNEL_ID="$(python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])" <<<"$TUNNEL_JSON")"
    TUNNEL_TOKEN="$(cf_api GET "/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/token" | python3 -c "import json,sys; r=json.load(sys.stdin).get('result'); print(r if isinstance(r,str) else r.get('token',''))")"
  else
    echo "$TUNNEL_JSON" >&2
    exit 1
  fi
else
  TUNNEL_ID="$(python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])" <<<"$TUNNEL_JSON")"
  TUNNEL_TOKEN="$(python3 -c "import json,sys; print(json.load(sys.stdin)['result']['token'])" <<<"$TUNNEL_JSON")"
fi
echo "Tunnel ID: ${TUNNEL_ID}"

IFS=',' read -ra HOSTS <<<"$HOSTNAMES"
INGRESS_ITEMS=""
for host in "${HOSTS[@]}"; do
  host="$(echo "$host" | xargs)"
  [[ -z "$host" ]] && continue
  INGRESS_ITEMS+="{\"hostname\":\"${host}\",\"service\":\"${ORIGIN}\",\"originRequest\":{}},"
done
INGRESS_ITEMS+='{"service":"http_status:404"}'
CONFIG_JSON="{\"config\":{\"ingress\":[${INGRESS_ITEMS}]}}"

echo "Publishing tunnel ingress…"
cf_api PUT "/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" "$CONFIG_JSON" >/dev/null

if [[ "${SKIP_DNS:-0}" != "1" ]]; then
DNS_FAIL=0
for host in "${HOSTS[@]}"; do
  host="$(echo "$host" | xargs)"
  [[ -z "$host" ]] && continue
  if [[ "$host" == "$ZONE_NAME" ]]; then
    record_name="@"
  elif [[ "$host" == *".${ZONE_NAME}" ]]; then
    record_name="${host%.$ZONE_NAME}"
  else
    record_name="$host"
  fi
  echo "DNS CNAME ${host} -> ${TUNNEL_ID}.cfargotunnel.com"
  for rtype in A AAAA; do
    old_resp="$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=${rtype}&name=${host}")"
    old="$(python3 -c "import json,sys; r=json.load(sys.stdin).get('result',[]); print(r[0]['id'] if r else '')" <<<"$old_resp")"
    if [[ -n "$old" ]]; then
      echo "  removing old ${rtype} record for ${host}"
      cf_api DELETE "/zones/${ZONE_ID}/dns_records/${old}" >/dev/null
    fi
  done
  existing_resp="$(cf_api GET "/zones/${ZONE_ID}/dns_records?type=CNAME&name=${host}")"
  existing="$(python3 -c "import json,sys; r=json.load(sys.stdin).get('result',[]); print(r[0]['id'] if r else '')" <<<"$existing_resp")"
  body="{\"type\":\"CNAME\",\"proxied\":true,\"name\":\"${record_name}\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"ttl\":1}"
  if [[ -n "$existing" ]]; then
    dns_resp="$(cf_api PUT "/zones/${ZONE_ID}/dns_records/${existing}" "$body")"
  else
    dns_resp="$(cf_api POST "/zones/${ZONE_ID}/dns_records" "$body")"
  fi
  if ! python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('success') else 1)" <<<"$dns_resp"; then
    DNS_FAIL=1
    echo "  DNS API failed for ${host}: $(python3 -c "import json,sys; print(json.load(sys.stdin).get('errors'))" <<<"$dns_resp")" >&2
  fi
done
if [[ "$DNS_FAIL" == "1" ]]; then
  echo "" >&2
  echo "DNS API denied. Add records manually in Cloudflare DNS:" >&2
  echo "  https://dash.cloudflare.com/${ZONE_ID}/${ZONE_NAME}/dns/records" >&2
  echo "  CNAME notes -> ${TUNNEL_ID}.cfargotunnel.com (proxied)" >&2
  echo "  CNAME www  -> ${TUNNEL_ID}.cfargotunnel.com (proxied)" >&2
  echo "  Remove old A records for notes/www pointing at your home IP." >&2
  echo "Tip: create a User API Token (cfut_) with Zone DNS Edit, not only an Account token." >&2
fi
else
  echo "Skipping DNS API (add CNAMEs manually to ${TUNNEL_ID}.cfargotunnel.com)."
fi

install -d -m 700 /etc/cloudflared
umask 077
printf '%s' "$TUNNEL_TOKEN" > /etc/cloudflared/tunnel.token
chmod 600 /etc/cloudflared/tunnel.token

cat > /etc/systemd/system/cloudflared.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel (Deeperguard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel run --token-file /etc/cloudflared/tunnel.token
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now cloudflared
sleep 3
systemctl is-active cloudflared

PRIMARY_HOST="$(echo "${HOSTS[0]}" | xargs)"
ENV=/opt/deeperguard/config/deeperguard.env
if [[ -f "$ENV" ]]; then
  ensure_kv() {
    local k="$1" v="$2"
    if grep -q "^${k}=" "$ENV"; then sed -i "s|^${k}=.*|${k}=${v}|" "$ENV"; else printf '%s=%s\n' "$k" "$v" >>"$ENV"; fi
  }
  ensure_kv NOTES_PUBLIC_HOST "$PRIMARY_HOST"
  ensure_kv NOTES_WEBAUTHN_RP_ID "$ZONE_NAME"
  ensure_kv NOTES_PUBLIC_URL "https://${PRIMARY_HOST}"
  ensure_kv NOTES_DISABLE_CIDR_GATE 1
  ensure_kv NOTES_TRUST_PROXY_HOPS 1
  ensure_kv NOTES_SECURE_COOKIES 1
  ensure_kv NOTES_STRICT_ZK 1
  ensure_kv NOTES_ALLOW_REGISTER 1
  systemctl restart deeperguard deeperguard-tls || true
fi

echo ""
echo "Tunnel is running. Open https://${PRIMARY_HOST}/"
echo "Verify: NOTES_HOST=${PRIMARY_HOST} bash deploy/verify-zk-privacy.sh"
