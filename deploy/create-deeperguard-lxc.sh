#!/usr/bin/env bash
# Create a deeperguard LXC on Proxmox. Safe to run from a deploy workstation.
set -euo pipefail

PVE_HOST="${PVE_HOST:-192.168.1.10}"
CT="${NOTES_CT:-143}"
IP="${NOTES_IP:-192.168.1.100}"
GATEWAY="${NOTES_GATEWAY:-192.168.1.1}"
NAMESERVER="${NOTES_NAMESERVER:-192.168.1.1}"
SEARCH_DOMAIN="${NOTES_SEARCH_DOMAIN:-home.local}"
VPN_CIDR="${NOTES_VPN_CIDR:-10.0.0.0/24}"
VPN_GATEWAY="${NOTES_VPN_GATEWAY:-}"
HOSTNAME="${NOTES_HOSTNAME:-deeperguard}"
TEMPLATE="${NOTES_TEMPLATE:-/var/lib/vz/template/cache/debian-13-standard_13.1-2_amd64.tar.zst}"
PUB="${NOTES_SSH_PUB:-$HOME/.ssh/id_ed25519.pub}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)

if [[ ! -f "$PUB" ]]; then
  echo "Missing SSH public key: $PUB" >&2
  exit 1
fi
KEY="$(cat "$PUB")"

VPN_ROUTE_LINE=""
if [[ -n "$VPN_GATEWAY" ]]; then
  VPN_ROUTE_LINE="up ip route add ${VPN_CIDR} via ${VPN_GATEWAY} || true"
fi

ssh "${SSH_OPTS[@]}" "root@${PVE_HOST}" bash -s <<REMOTE
set -euo pipefail
if pct status ${CT} >/dev/null 2>&1; then
  echo "CT ${CT} already exists"
  pct status ${CT}
  exit 0
fi
if [[ ! -f "${TEMPLATE}" ]]; then
  echo "Missing template ${TEMPLATE}" >&2
  exit 1
fi
PASS="\$(openssl rand -base64 24)"
pct create ${CT} "${TEMPLATE}" \\
  --hostname ${HOSTNAME} \\
  --memory 1024 --cores 1 --swap 512 \\
  --unprivileged 1 --features nesting=1 --onboot 1 \\
  --ostype debian \\
  --nameserver ${NAMESERVER} --searchdomain ${SEARCH_DOMAIN} \\
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=${IP}/24,gw=${GATEWAY},type=veth \\
  --rootfs local-lvm:8 \\
  --password "\$PASS"
pct start ${CT}
for i in \$(seq 1 40); do
  if pct exec ${CT} -- true 2>/dev/null; then
    break
  fi
  sleep 1
done
pct exec ${CT} -- bash -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh'
printf '%s\n' '${KEY}' | pct exec ${CT} -- tee -a /root/.ssh/authorized_keys >/dev/null
pct exec ${CT} -- chmod 600 /root/.ssh/authorized_keys
pct exec ${CT} -- hostnamectl set-hostname ${HOSTNAME} || true
REMOTE

if [[ -n "$VPN_ROUTE_LINE" ]]; then
  ssh "${SSH_OPTS[@]}" "root@${PVE_HOST}" bash -s <<REMOTE
set -euo pipefail
pct exec ${CT} -- bash -c 'grep -q "${VPN_CIDR}" /etc/network/interfaces || printf "\n${VPN_ROUTE_LINE}\n" >> /etc/network/interfaces'
pct exec ${CT} -- ip route add ${VPN_CIDR} via ${VPN_GATEWAY} 2>/dev/null || true
REMOTE
fi

ssh "${SSH_OPTS[@]}" "root@${PVE_HOST}" "echo Created CT ${CT} ${HOSTNAME} ${IP}"
