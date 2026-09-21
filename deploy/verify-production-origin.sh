#!/usr/bin/env bash
# Compare LAN deploy build vs public URL (catches tunnel pointing at the wrong CT).
set -euo pipefail
LAN_HOST="${NOTES_LAN_HOST:-192.168.178.143}"
PUBLIC_HOST="${NOTES_HOST:-www.deeperguard.com}"
LAN_BASE="https://${LAN_HOST}"
PUBLIC_BASE="https://${PUBLIC_HOST}"

lan="$(curl -ksS --connect-timeout 8 "${LAN_BASE}/api/health" || true)"
pub="$(curl -ksS --connect-timeout 12 "${PUBLIC_BASE}/api/health" || true)"

lan_build="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('build',''))" "$lan" 2>/dev/null || true)"
pub_build="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('build',''))" "$pub" 2>/dev/null || true)"
lan_svc="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('service',''))" "$lan" 2>/dev/null || true)"
pub_svc="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('service',''))" "$pub" 2>/dev/null || true)"

echo "LAN  ${LAN_HOST}: build=${lan_build} service=${lan_svc}"
echo "WAN  ${PUBLIC_HOST}: build=${pub_build} service=${pub_svc}"

if [[ -z "$lan_build" || -z "$pub_build" ]]; then
  echo "FAIL: could not read health JSON from one or both hosts." >&2
  exit 1
fi
if [[ "$lan_build" != "$pub_build" ]]; then
  echo "FAIL: build mismatch — deploy may not be on the Cloudflare tunnel origin." >&2
  echo "      Check Zero Trust → Tunnels → connectors (homelab-notes vs deeperguard CT)." >&2
  exit 1
fi
echo "OK: public and LAN builds match (${pub_build})."
