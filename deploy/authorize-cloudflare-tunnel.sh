#!/usr/bin/env bash
# One-time: authorize cloudflared on this host (when you cannot use an API token).
# 1. Run this script on CT 143 — it prints a URL.
# 2. Log in to Cloudflare in your browser and open that URL.
# 3. Re-run setup-cloudflare-tunnel.sh with CLOUDFLARE_API_TOKEN (preferred), or:
#    cloudflared tunnel create deeperguard && cloudflared tunnel route dns ...
set -euo pipefail
echo "Starting cloudflared tunnel login (leave running until browser auth completes)…"
cloudflared tunnel login
