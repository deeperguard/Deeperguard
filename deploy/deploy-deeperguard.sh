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

# Round 72.2: About/verify meta notes-release-tag comes from RELEASE_TAG.
# Require an explicit tag (env) or an exact-match git tag on HEAD — never ship
# a stale RELEASE_TAG from an old commit (that pinned live to v0.62.1).
release_tag="${NOTES_RELEASE_TAG:-}"
if [[ -z "${release_tag}" ]]; then
  release_tag="$(git -C "$SRC" describe --tags --exact-match HEAD 2>/dev/null || true)"
fi
if [[ -z "${release_tag}" ]]; then
  echo "deploy: set NOTES_RELEASE_TAG=vX.Y.Z (or checkout an exact release tag)" >&2
  exit 1
fi
printf '%s\n' "${release_tag}" > "${SRC}/RELEASE_TAG"
chmod +x "${SRC}/scripts/check-release-tag.sh"
NOTES_RELEASE_TAG="${release_tag}" bash "${SRC}/scripts/check-release-tag.sh"
echo "Release tag ${release_tag}"

chmod +x "$SRC/deploy/"*.sh
bash "$SRC/deploy/fetch-ocr-assets.sh"

# Deterministic client integrity manifest (hashed URLs + SRI digests).
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
python3 "$SRC/scripts/build-client-manifest.py"
client_hash="$(python3 "$SRC/scripts/build-client-manifest.py" --print-hash)"
echo "Client manifest_sha256=${client_hash}"

TAR_PATHS=(app content deploy docs tests scripts requirements.txt requirements.lock README.md .python-version .nvmrc RELEASE_TAG)
tar czf /tmp/deeperguard-deploy.tar.gz -C "$SRC" \
  --exclude=.git --exclude=venv --exclude=keys --exclude=data \
  --exclude='__pycache__' --exclude='*.pyc' \
  "${TAR_PATHS[@]}"
ssh "${SSH_OPTS[@]}" "root@${HOST}" "mkdir -p ${REMOTE}"
scp "${SSH_OPTS[@]}" /tmp/deeperguard-deploy.tar.gz "root@${HOST}:/tmp/deeperguard-deploy.tar.gz"
ssh "${SSH_OPTS[@]}" "root@${HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE}"
# Drop stale static JS/CSS (AppleDouble ._* files, old vendor UMD copies) so
# the client manifest hashes only the tree we just shipped.
rm -rf app/static/js app/static/css
tar xzf /tmp/deeperguard-deploy.tar.gz
rm -f /tmp/deeperguard-deploy.tar.gz
chmod +x deploy/*.sh
# Remove any AppleDouble metadata that slipped into the tarball.
find app/static -name '._*' -type f -delete 2>/dev/null || true
printf '%s\n' "${version}" > VERSION
# Pin the served notes-release-tag (client_assets.release_tag reads this file).
printf '%s\n' "${release_tag}" > RELEASE_TAG
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
# Fail closed: remote RELEASE_TAG must match what we intended to ship.
remote_tag="\$(tr -d '[:space:]' < RELEASE_TAG)"
if [[ "\${remote_tag}" != "${release_tag}" ]]; then
  echo "deploy: remote RELEASE_TAG=\${remote_tag} != ${release_tag}" >&2
  exit 1
fi
REMOTE
rm -f /tmp/deeperguard-deploy.tar.gz
echo "Deployed to ${HOST}. Public site: https://www.deeperguard.com/  App: https://www.deeperguard.com/app"
echo "RELEASE_TAG=${release_tag} client_hash=${client_hash}"

# Fail closed when a GitHub Release for this tag already exists: its
# manifest_sha256 must equal the hash we just built (About compares them).
if [[ "${NOTES_VERIFY_RELEASE_HASH:-1}" == "1" ]]; then
  rel_json="$(curl -fsS -A 'deeperguard-deploy' \
    "https://api.github.com/repos/deeperguard/Deeperguard/releases/tags/${release_tag}" \
    || true)"
  if [[ -n "${rel_json}" ]] && echo "${rel_json}" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
    asset_url="$(echo "${rel_json}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for a in d.get("assets") or []:
  if a.get("name")=="client-manifest.json":
    print(a.get("browser_download_url") or "")
    break
')"
    if [[ -n "${asset_url}" ]]; then
      rel_hash="$(curl -fsSL -A 'deeperguard-deploy' "${asset_url}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest_sha256"])')"
      if [[ "${rel_hash}" != "${client_hash}" ]]; then
        echo "deploy: GitHub Release ${release_tag} manifest_sha256=${rel_hash} != built ${client_hash}" >&2
        exit 1
      fi
      echo "GitHub Release ${release_tag} manifest_sha256 matches build"
    fi
  fi
fi

if [[ "${NOTES_VERIFY_PUBLIC:-0}" == "1" ]]; then
  NOTES_LAN_HOST="${NOTES_LAN_HOST:-${HOST}}" NOTES_HOST="${NOTES_PUBLIC_HOST:-www.deeperguard.com}" \
    bash "${SRC}/deploy/verify-production-origin.sh" || true
  public_host="${NOTES_PUBLIC_HOST:-www.deeperguard.com}"
  meta_tag="$(curl -fsS -A 'deeperguard-deploy' "https://${public_host}/app" \
    | python3 -c 'import re,sys; m=re.search(r"notes-release-tag\"\s+content=\"([^\"]+)\"", sys.stdin.read()); print(m.group(1) if m else "")')"
  if [[ "${meta_tag}" != "${release_tag}" ]]; then
    echo "deploy: public notes-release-tag='${meta_tag}' != '${release_tag}'" >&2
    exit 1
  fi
  echo "Public notes-release-tag=${meta_tag} ok"
fi
