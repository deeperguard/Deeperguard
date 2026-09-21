#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYS="${NOTES_KEYS:-/opt/deeperguard/keys}"
DATA="${NOTES_DATA:-/opt/deeperguard/data}"
CFG="${NOTES_ROOT:-/opt/deeperguard}/config"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng poppler-utils \
    libheif1 libheif-examples >/dev/null
fi

install -d -m 755 /opt/deeperguard "$CFG" "$DATA"
install -d -m 700 "$KEYS"

if [[ ! -f "$CFG/deeperguard.env" ]]; then
  install -m 600 "$ROOT/deploy/deeperguard.env.example" "$CFG/deeperguard.env"
fi

if [[ ! -s "$KEYS/flask-secret" ]]; then
  openssl rand -hex 32 > "$KEYS/flask-secret"
  chmod 600 "$KEYS/flask-secret"
fi
touch "$KEYS/smtp-password"
chmod 600 "$KEYS/smtp-password"

if ! command -v rclone >/dev/null 2>&1; then
  RCLONE_VERSION="${RCLONE_VERSION:-1.68.2}"
  RCLONE_DEB="/tmp/rclone-${RCLONE_VERSION}-linux-amd64.deb"
  curl -fsSL "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.deb" -o "$RCLONE_DEB"
  apt-get install -y "$RCLONE_DEB"
  rm -f "$RCLONE_DEB"
fi

hour=3
if [[ -f "$CFG/deeperguard.env" ]]; then
  raw="$(grep -E '^NOTES_BACKUP_CRON_HOUR=' "$CFG/deeperguard.env" | tail -1 | cut -d= -f2- || true)"
  raw="$(printf '%s' "$raw" | tr -d '[:space:]\"')"
  if [[ "$raw" =~ ^[0-9]{1,2}$ ]] && [ "$raw" -ge 0 ] && [ "$raw" -le 23 ]; then
    hour="$raw"
  fi
fi
install -d -m 755 /etc/cron.d
printf '0 %s * * * root /opt/deeperguard/venv/bin/python /opt/deeperguard/app/backup_cron.py >> /var/log/deeperguard-backup.log 2>&1\n' "$hour" \
  > /etc/cron.d/deeperguard-backup
chmod 644 /etc/cron.d/deeperguard-backup
install -m 644 "$ROOT/deploy/cron/deeperguard-warnings" /etc/cron.d/deeperguard-warnings

ENABLE_LAN_TLS="${NOTES_ENABLE_LAN_TLS:-0}"

install -m 644 "$ROOT/deploy/systemd/deeperguard.service" /etc/systemd/system/deeperguard.service
install -m 644 "$ROOT/deploy/systemd/deeperguard-tls.service" /etc/systemd/system/deeperguard-tls.service
if [[ -f "$ROOT/deploy/systemd/deeperguard-ocr.service" ]]; then
  install -m 644 "$ROOT/deploy/systemd/deeperguard-ocr.service" /etc/systemd/system/deeperguard-ocr.service
fi
if [[ -f "$ROOT/deploy/logrotate/deeperguard" ]]; then
  install -m 644 "$ROOT/deploy/logrotate/deeperguard" /etc/logrotate.d/deeperguard
fi
systemctl daemon-reload
systemctl enable deeperguard.service
if [[ -f /etc/systemd/system/deeperguard-ocr.service ]]; then
  systemctl enable deeperguard-ocr.service || true
fi

if [[ "${ENABLE_LAN_TLS}" == "1" ]]; then
  bash "$ROOT/deploy/generate-tls.sh"
  systemctl enable deeperguard-tls.service
else
  systemctl disable --now deeperguard-tls.service || true
fi

systemctl restart deeperguard.service
if [[ "${ENABLE_LAN_TLS}" == "1" && -s "$KEYS/tls/server.crt" && -s "$KEYS/tls/server.key" ]]; then
  systemctl restart deeperguard-tls.service
fi
if [[ -f /etc/systemd/system/deeperguard-ocr.service ]]; then
  systemctl restart deeperguard-ocr.service
fi
if [[ "${ENABLE_LAN_TLS}" == "1" ]]; then
  LAN_CIDR="${NOTES_LAN_CIDR:-192.168.1.0/24}"
  VPN_CIDR="${NOTES_VPN_CIDR:-10.0.0.0/24}"
  ufw allow from "${LAN_CIDR}" to any port 443 proto tcp || true
  ufw allow from "${VPN_CIDR}" to any port 443 proto tcp || true
fi
