#!/usr/bin/env bash
# Copy client-integrity GitHub Actions into .github/workflows/.
# Requires a git remote credential with the `workflow` OAuth scope to push.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${ROOT}/.github/workflows"
cp -f "${ROOT}/deploy/github-workflows/"*.yml "${ROOT}/.github/workflows/"
echo "Installed:"
ls -la "${ROOT}/.github/workflows/"
echo "Commit and push with a token that includes the workflow scope."
