#!/usr/bin/env bash
# Sync deeperguard code to Vienna (or NOTES_HOST) and restart the service.
set -euo pipefail
# Production is the Vienna VPS behind Cloudflare. Do not git pull on that host.
HOST="${NOTES_HOST:?Set NOTES_HOST to the Vienna origin host}"
REMOTE="${NOTES_REMOTE_DIR:-/opt/deeperguard}"
LAN_CIDR="${NOTES_LAN_CIDR:-192.168.178.0/24}"
VPN_CIDR="${NOTES_VPN_CIDR:-10.0.0.0/24}"
VPN_GATEWAY="${NOTES_VPN_GATEWAY:-}"
DEPLOY_SSH_HOST="${NOTES_DEPLOY_SSH_HOST:-}"
ENABLE_LAN_TLS="${NOTES_ENABLE_LAN_TLS:-0}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)

ssh "${SSH_OPTS[@]}" "root@${HOST}" true || { echo "SSH to NOTES_HOST failed"; exit 1; }

version=""
if git -C "$SRC" rev-parse --short HEAD >/dev/null 2>&1; then
  version="$(git -C "$SRC" rev-parse HEAD)"
fi
build_id="${version:0:8}"

chmod +x "$SRC/deploy/"*.sh
bash "$SRC/deploy/fetch-ocr-assets.sh"

# Deterministic client integrity manifest (hashed URLs + SRI digests).
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
python3 "$SRC/scripts/build-client-manifest.py"
client_hash="$(python3 "$SRC/scripts/build-client-manifest.py" --print-hash)"
echo "Client manifest_sha256=${client_hash}"

TAR_PATHS=(app deploy tests scripts requirements.txt requirements.lock README.md .python-version .nvmrc)
if [[ -f "$SRC/RELEASE_TAG" ]]; then
  TAR_PATHS+=(RELEASE_TAG)
fi
tar czf /tmp/deeperguard-deploy.tar.gz -C "$SRC" \
  --exclude=.git --exclude=venv --exclude=keys --exclude=data \
  --exclude='__pycache__' --exclude='*.pyc' \
  "${TAR_PATHS[@]}"
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
# Refresh the on-server manifest so SRI matches the files just unpacked.
SOURCE_DATE_EPOCH=0 python3 scripts/build-client-manifest.py
if [[ ! -x venv/bin/python ]]; then
  NOTES_ENABLE_LAN_TLS='${ENABLE_LAN_TLS}' NOTES_LAN_CIDR='${LAN_CIDR}' NOTES_VPN_CIDR='${VPN_CIDR}' NOTES_VPN_GATEWAY='${VPN_GATEWAY}' NOTES_DEPLOY_SSH_HOST='${DEPLOY_SSH_HOST}' NOTES_HOST='${HOST}' bash deploy/bootstrap.sh
else
  if [[ -f requirements.lock ]]; then
    venv/bin/pip install -q -r requirements.lock
  else
    venv/bin/pip install -q -r requirements.txt
  fi
  NOTES_ENABLE_LAN_TLS='${ENABLE_LAN_TLS}' bash deploy/install-services.sh
fi
if [[ '${ENABLE_LAN_TLS}' != "1" ]]; then
  systemctl disable --now deeperguard-tls || true
fi
systemctl is-active deeperguard
systemctl is-active deeperguard-tls || true
systemctl is-active deeperguard-ocr || true
REMOTE
rm -f /tmp/deeperguard-deploy.tar.gz
echo "Deployed to ${HOST}. Public site: https://www.deeperguard.com/  App: https://www.deeperguard.com/app"
if [[ "${NOTES_VERIFY_PUBLIC:-0}" == "1" ]]; then
  NOTES_LAN_HOST="${NOTES_LAN_HOST:-${HOST}}" NOTES_HOST="${NOTES_PUBLIC_HOST:-www.deeperguard.com}" \
    bash "${SRC}/deploy/verify-production-origin.sh" || true
fi
