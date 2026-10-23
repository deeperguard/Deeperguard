#!/usr/bin/env bash
# Fail closed when RELEASE_TAG does not match the release being cut or deployed.
# Usage:
#   scripts/check-release-tag.sh [--expect v0.64.5]
#   NOTES_RELEASE_TAG=v0.64.5 scripts/check-release-tag.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPECT="${NOTES_RELEASE_TAG:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECT="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 [--expect vX.Y.Z]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${EXPECT}" ]]; then
  echo "check-release-tag: set NOTES_RELEASE_TAG or pass --expect vX.Y.Z" >&2
  exit 1
fi
if [[ ! "${EXPECT}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
  echo "check-release-tag: invalid tag '${EXPECT}' (want vX.Y.Z…)" >&2
  exit 1
fi

tag_file="${ROOT}/RELEASE_TAG"
if [[ ! -f "${tag_file}" ]]; then
  echo "check-release-tag: missing ${tag_file}" >&2
  exit 1
fi
have="$(tr -d '[:space:]' < "${tag_file}")"
if [[ "${have}" != "${EXPECT}" ]]; then
  echo "check-release-tag: RELEASE_TAG is '${have}' but expected '${EXPECT}'" >&2
  echo "Update RELEASE_TAG in the commit before tagging/deploying." >&2
  exit 1
fi
echo "check-release-tag ok ${have}"
