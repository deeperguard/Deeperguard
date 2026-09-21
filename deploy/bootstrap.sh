#!/usr/bin/env bash
# First-boot setup inside the deeperguard LXC.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

LAN_CIDR="${NOTES_LAN_CIDR:-192.168.1.0/24}"
VPN_CIDR="${NOTES_VPN_CIDR:-10.0.0.0/24}"
VPN_GATEWAY="${NOTES_VPN_GATEWAY:-}"
DEPLOY_SSH_HOST="${NOTES_DEPLOY_SSH_HOST:-}"
HOST="${NOTES_HOST:-www.deeperguard.com}"

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl openssl python3 python3-venv python3-pip \
  tesseract-ocr tesseract-ocr-eng poppler-utils \
  libheif1 libheif-examples \
  ufw

RCLONE_VERSION="${RCLONE_VERSION:-1.68.2}"
RCLONE_DEB="/tmp/rclone-${RCLONE_VERSION}-linux-amd64.deb"
curl -fsSL "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.deb" -o "$RCLONE_DEB"
apt-get install -y "$RCLONE_DEB"
rm -f "$RCLONE_DEB"

if [[ -n "$VPN_GATEWAY" ]]; then
  ip route add "${VPN_CIDR}" via "${VPN_GATEWAY}" 2>/dev/null || true
fi

rm -rf /opt/deeperguard/venv
python3 -m venv /opt/deeperguard/venv
/opt/deeperguard/venv/bin/pip install -q -U pip
/opt/deeperguard/venv/bin/pip install -q -r "$ROOT/requirements.txt"

bash "$ROOT/deploy/install-services.sh"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow from "${LAN_CIDR}" to any port 22 proto tcp
if [[ -n "$DEPLOY_SSH_HOST" ]]; then
  ufw allow from "${DEPLOY_SSH_HOST}" to any port 22 proto tcp
fi
ufw allow from "${LAN_CIDR}" to any port 80 proto tcp
ufw allow from "${VPN_CIDR}" to any port 80 proto tcp
ufw allow from "${LAN_CIDR}" to any port 443 proto tcp
ufw allow from "${VPN_CIDR}" to any port 443 proto tcp
ufw --force enable

cat >/etc/ssh/sshd_config.d/99-hardening.conf <<'SSH'
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
SSH
systemctl restart ssh || true

install -d -m 755 /etc/cron.d
install -m 644 "$ROOT/deploy/cron/deeperguard-backup" /etc/cron.d/deeperguard-backup

echo
echo "Open http://${HOST}/ on LAN or VPN"
echo "Create your account on first visit"
