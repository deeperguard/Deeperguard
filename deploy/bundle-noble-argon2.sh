#!/usr/bin/env bash
# Bundle @noble/hashes argon2 for in-browser vault key derivation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app/static/js/vendor/noble-argon2.js"
NOBLE_ROOT="${NOBLE_ROOT:-/tmp/noble-bundle}"
ESBUILD="${ESBUILD:-/tmp/package/bin/esbuild}"

if [[ ! -f "$NOBLE_ROOT/node_modules/@noble/hashes/esm/argon2.js" ]]; then
  echo "Missing @noble/hashes at $NOBLE_ROOT — install with npm in that directory first." >&2
  exit 1
fi
if [[ ! -x "$ESBUILD" ]]; then
  echo "Missing esbuild at $ESBUILD" >&2
  exit 1
fi

"$ESBUILD" "$NOBLE_ROOT/node_modules/@noble/hashes/esm/argon2.js" \
  --bundle \
  --format=iife \
  --global-name=NobleArgon2 \
  --platform=browser \
  --outfile="$OUT" \
  --minify

printf '\n/*! noble-hashes argon2 - MIT License (c) Paul Miller (paulmillr.com) */\n' >> "$OUT"
echo "Wrote $(wc -c < "$OUT") bytes to $OUT"
