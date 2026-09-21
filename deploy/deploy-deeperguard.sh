#!/usr/bin/env bash
# Sync deeperguard code to the LXC and restart the service.
set -euo pipefail
HOST="${NOTES_HOST:-www.deeperguard.com}"
REMOTE="${NOTES_REMOTE_DIR:-/opt/deeperguard}"
LAN_CIDR="${NOTES_LAN_CIDR:-192.168.178.0/24}"
VPN_CIDR="${NOTES_VPN_CIDR:-10.0.0.0/24}"
VPN_GATEWAY="${NOTES_VPN_GATEWAY:-192.168.178.77}"
DEPLOY_SSH_HOST="${NOTES_DEPLOY_SSH_HOST:-192.168.178.174}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)

ssh "${SSH_OPTS[@]}" "root@${HOST}" true || { echo "SSH to $HOST failed"; exit 1; }

version=""
if git -C "$SRC" rev-parse --short HEAD >/dev/null 2>&1; then
  version="$(git -C "$SRC" rev-parse HEAD)"
fi
build_id="${version:0:8}"

chmod +x "$SRC/deploy/"*.sh
bash "$SRC/deploy/fetch-ocr-assets.sh"

tar czf /tmp/deeperguard-deploy.tar.gz -C "$SRC" \
  --exclude=.git --exclude=venv --exclude=keys --exclude=data \
  --exclude='__pycache__' --exclude='*.pyc' \
  app deploy tests requirements.txt README.md
ssh "${SSH_OPTS[@]}" "root@${HOST}" "mkdir -p ${REMOTE}"
scp "${SSH_OPTS[@]}" /tmp/deeperguard-deploy.tar.gz "root@${HOST}:/tmp/deeperguard-deploy.tar.gz"
ssh "${SSH_OPTS[@]}" "root@${HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE}"
tar xzf /tmp/deeperguard-deploy.tar.gz
rm -f /tmp/deeperguard-deploy.tar.gz
chmod +x deploy/*.sh
printf '%s\n' "${version}" > VERSION
if [[ -n "${build_id}" && -f /opt/deeperguard/config/deeperguard.env ]]; then
  if grep -q '^NOTES_BUILD=' /opt/deeperguard/config/deeperguard.env; then
    sed -i "s/^NOTES_BUILD=.*/NOTES_BUILD=${build_id}/" /opt/deeperguard/config/deeperguard.env
  else
    printf '\nNOTES_BUILD=%s\n' "${build_id}" >> /opt/deeperguard/config/deeperguard.env
  fi
fi
if [[ ! -x venv/bin/python ]]; then
  NOTES_LAN_CIDR='${LAN_CIDR}' NOTES_VPN_CIDR='${VPN_CIDR}' NOTES_VPN_GATEWAY='${VPN_GATEWAY}' NOTES_DEPLOY_SSH_HOST='${DEPLOY_SSH_HOST}' NOTES_HOST='${HOST}' bash deploy/bootstrap.sh
else
  venv/bin/pip install -q -r requirements.txt
  bash deploy/install-services.sh
fi
systemctl is-active deeperguard
systemctl is-active deeperguard-tls || true
systemctl is-active deeperguard-ocr || true
REMOTE
rm -f /tmp/deeperguard-deploy.tar.gz
echo "Open http://${HOST}/  (HTTPS: https://${HOST}/ after installing http://${HOST}/ca.crt )"
if [[ "${NOTES_VERIFY_PUBLIC:-0}" == "1" ]]; then
  NOTES_LAN_HOST="${NOTES_LAN_HOST:-${HOST}}" NOTES_HOST="${NOTES_PUBLIC_HOST:-www.deeperguard.com}" \
    bash "${SRC}/deploy/verify-production-origin.sh" || true
fi
