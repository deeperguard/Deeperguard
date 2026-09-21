#!/usr/bin/env bash
# Migrate homelab-notes (CT 143) → deeperguard on a new LXC without losing vault data.
set -euo pipefail

PVE_HOST="${PVE_HOST:-192.168.178.100}"
OLD_CT="${OLD_CT:-143}"
OLD_HOST="${OLD_HOST:-192.168.178.143}"
NEW_CT="${NEW_CT:-145}"
NEW_HOST="${NEW_HOST:-192.168.178.145}"
SWAP_IP="${SWAP_IP:-1}"
NEW_DISK_GB="${NEW_DISK_GB:-12}"
TEMPLATE="${NOTES_TEMPLATE:-/var/lib/vz/template/cache/debian-13-standard_13.1-2_amd64.tar.zst}"
PUB="${NOTES_SSH_PUB:-$HOME/.ssh/id_ed25519.pub}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SRC="$(cd "$(dirname "$0")/.." && pwd)"

OLD_ROOT=/opt/homelab-notes
NEW_ROOT=/opt/deeperguard

if [[ ! -f "$PUB" ]]; then
  echo "Missing SSH public key: $PUB" >&2
  exit 1
fi
KEY="$(cat "$PUB")"

echo "=== 1. Create CT ${NEW_CT} (${NEW_HOST}) on ${PVE_HOST} ==="
ssh "${SSH_OPTS[@]}" "root@${PVE_HOST}" bash -s <<REMOTE
set -euo pipefail
if pct status ${NEW_CT} >/dev/null 2>&1; then
  echo "CT ${NEW_CT} already exists"
else
  [[ -f "${TEMPLATE}" ]] || { echo "Missing ${TEMPLATE}" >&2; exit 1; }
  PASS="\$(openssl rand -base64 24)"
  pct create ${NEW_CT} "${TEMPLATE}" \\
    --hostname deeperguard \\
    --memory 2048 --cores 2 --swap 1024 \\
    --unprivileged 1 --features nesting=1 --onboot 1 \\
    --ostype debian \\
    --nameserver 192.168.178.49 --searchdomain home \\
    --net0 name=eth0,bridge=vmbr0,firewall=1,ip=${NEW_HOST}/24,gw=192.168.178.1,type=veth \\
    --rootfs local-lvm:${NEW_DISK_GB} \\
    --password "\$PASS"
fi
pct start ${NEW_CT} 2>/dev/null || true
for i in \$(seq 1 60); do
  pct exec ${NEW_CT} -- true 2>/dev/null && break
  sleep 1
done
pct exec ${NEW_CT} -- bash -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh'
grep -qF '${KEY}' /var/lib/lxc/${NEW_CT}/rootfs/root/.ssh/authorized_keys 2>/dev/null || \\
  printf '%s\n' '${KEY}' | pct exec ${NEW_CT} -- tee -a /root/.ssh/authorized_keys >/dev/null
pct exec ${NEW_CT} -- chmod 600 /root/.ssh/authorized_keys
pct exec ${NEW_CT} -- hostnamectl set-hostname deeperguard || true
pct exec ${NEW_CT} -- bash -c 'grep -q "10.0.0.0/24" /etc/network/interfaces || printf "\nup ip route add 10.0.0.0/24 via 192.168.178.77 || true\n" >> /etc/network/interfaces'
pct exec ${NEW_CT} -- ip route add 10.0.0.0/24 via 192.168.178.77 2>/dev/null || true
REMOTE

echo "=== 2. Deploy deeperguard code to ${NEW_HOST} ==="
export NOTES_HOST="${NEW_HOST}"
export NOTES_REMOTE_DIR="${NEW_ROOT}"
export NOTES_LAN_CIDR=192.168.178.0/24
export NOTES_VPN_CIDR=10.0.0.0/24
export NOTES_VPN_GATEWAY=192.168.178.77
export NOTES_DEPLOY_SSH_HOST=192.168.178.174
bash "${SRC}/deploy/deploy-deeperguard.sh"

echo "=== 3. Stop old services on ${OLD_HOST} (brief downtime) ==="
ssh "${SSH_OPTS[@]}" "root@${OLD_HOST}" bash -s <<'STOP'
set -euo pipefail
systemctl stop homelab-notes-ocr homelab-notes-tls homelab-notes cloudflared 2>/dev/null || true
STOP

echo "=== 4. SQLite backup + copy vault data and keys ==="
ssh "${SSH_OPTS[@]}" "root@${OLD_HOST}" "${OLD_ROOT}/venv/bin/python -c \"
import sqlite3, os
src=sqlite3.connect('${OLD_ROOT}/data/notes.db')
dst=sqlite3.connect('/tmp/notes-clean.db')
src.backup(dst)
dst.close(); src.close()
print('users', sqlite3.connect('/tmp/notes-clean.db').execute('SELECT COUNT(*) FROM users').fetchone()[0])
\""

ssh "${SSH_OPTS[@]}" "root@${OLD_HOST}" 'tar cf - -C /opt/homelab-notes data/keys /tmp/notes-clean.db' \
  | ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" "tar xf - -C /tmp && \
    systemctl stop deeperguard deeperguard-tls deeperguard-ocr cloudflared 2>/dev/null || true && \
    cp /tmp/notes-clean.db ${NEW_ROOT}/data/notes.db && \
    rm -f ${NEW_ROOT}/data/notes.db-wal ${NEW_ROOT}/data/notes.db-shm && \
    rsync -a /tmp/data/ ${NEW_ROOT}/data/ && \
    rsync -a /tmp/keys/ ${NEW_ROOT}/keys/"

ssh "${SSH_OPTS[@]}" "root@${OLD_HOST}" "cat ${OLD_ROOT}/config/homelab-notes.env" \
  | ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" "cat > ${NEW_ROOT}/config/deeperguard.env && chmod 600 ${NEW_ROOT}/config/deeperguard.env"

echo "=== 5. Update production env for www.deeperguard.com ==="
ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" bash -s <<'ENV'
set -euo pipefail
ENV_FILE=/opt/deeperguard/config/deeperguard.env
ensure_kv() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"; else printf '%s=%s\n' "$k" "$v" >>"$ENV_FILE"; fi
}
ensure_kv NOTES_PUBLIC_HOST www.deeperguard.com
ensure_kv NOTES_WEBAUTHN_RP_ID deeperguard.com
ensure_kv NOTES_PUBLIC_URL https://www.deeperguard.com
ensure_kv NOTES_STRICT_ZK 1
ensure_kv NOTES_DISABLE_CIDR_GATE 1
ensure_kv NOTES_TRUST_PROXY_HOPS 1
ensure_kv NOTES_SECURE_COOKIES 1
/opt/deeperguard/venv/bin/python -c "import sqlite3; c=sqlite3.connect('/opt/deeperguard/data/notes.db'); print('users', c.execute('SELECT id,email FROM users').fetchall())"
ENV

echo "=== 6. Cloudflared tunnel ==="
ssh "${SSH_OPTS[@]}" "root@${OLD_HOST}" 'cat /etc/cloudflared/tunnel.token' \
  | ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" 'install -d -m 700 /etc/cloudflared && cat > /etc/cloudflared/tunnel.token && chmod 600 /etc/cloudflared/tunnel.token'

ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" bash -s <<'CF'
set -euo pipefail
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  apt-get install -y /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
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
systemctl enable cloudflared
systemctl restart deeperguard deeperguard-tls cloudflared
sleep 2
systemctl is-active deeperguard cloudflared
curl -fsS http://127.0.0.1/api/health
CF

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "=== 7. Update Cloudflare DNS ==="
  export CF_ZONE_NAME="${CF_ZONE_NAME:-deeperguard.com}"
  # notes.deeperguard.com may remain in DNS for legacy bookmarks; the app 301s it to www.
  export CF_HOSTNAMES="${CF_HOSTNAMES:-www.deeperguard.com,deeperguard.com,notes.deeperguard.com}"
  ssh "${SSH_OPTS[@]}" "root@${NEW_HOST}" \
    "CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN}' CF_ZONE_NAME='${CF_ZONE_NAME}' CF_HOSTNAMES='${CF_HOSTNAMES}' bash ${NEW_ROOT}/deploy/setup-cloudflare-tunnel.sh" || true
fi

if [[ "$SWAP_IP" == "1" && "$NEW_HOST" != "$OLD_HOST" ]]; then
  echo "=== 8. Move ${OLD_HOST} to new container (stop old CT ${OLD_CT}) ==="
  ssh "${SSH_OPTS[@]}" "root@${PVE_HOST}" bash -s <<REMOTE
pct stop ${OLD_CT} 2>/dev/null || true
pct stop ${NEW_CT}
pct set ${NEW_CT} -net0 name=eth0,bridge=vmbr0,firewall=1,ip=${OLD_HOST}/24,gw=192.168.178.1,type=veth
pct start ${NEW_CT}
REMOTE
  ssh-keygen -f "$HOME/.ssh/known_hosts" -R "${OLD_HOST}" 2>/dev/null || true
fi

echo ""
echo "Migration complete."
echo "  LAN:      https://${OLD_HOST}/"
echo "  Public:   https://www.deeperguard.com/"
echo "  Old CT ${OLD_CT} is stopped (data kept on disk as backup)."
