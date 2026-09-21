# Deeperguard

Zero-knowledge encrypted notes at **[www.deeperguard.com](https://www.deeperguard.com)**. Notes are encrypted on your device before sync — the server only stores ciphertext.

Inspired by [Standard Notes](https://standardnotes.com/), but **stricter on privacy**: SRP login (password never sent), strict zero-knowledge vault unlock, client-side OCR, and reminder emails without note titles.

**Self-host:** [docs/SELF_HOST.md](docs/SELF_HOST.md) · **AI design notes:** [docs/AI_NOTES.md](docs/AI_NOTES.md)

**License:** [AGPL-3.0](LICENSE) · **Privacy:** [docs/PRIVACY.md](docs/PRIVACY.md)

## Production (www.deeperguard.com)

Public beta runs behind **Cloudflare Tunnel** — no home router ports open.

```bash
export CLOUDFLARE_API_TOKEN='your-token'
export CF_ZONE_NAME='deeperguard.com'
export CF_HOSTNAMES='www.deeperguard.com,deeperguard.com'
bash deploy/setup-cloudflare-tunnel.sh
bash deploy/setup-cloudflare-apex-redirect.sh   # 301 apex -> www
bash deploy/setup-cloudflare-rate-limits.sh
```

See **[deploy/PRODUCTION.md](deploy/PRODUCTION.md)** for the full WAN checklist.

## Why self-host?

- Your data stays on **your** machine
- No vendor cloud dependency
- Full source code — audit the crypto and sync path yourself
- LAN-first with optional WAN via Cloudflare Tunnel or VPN

## Features

- **End-to-end encryption** — AES-256-GCM in the browser; Argon2id vault keys (v2) with legacy SHA-256 (v1) support
- **SRP zero-knowledge login** — account password never sent to the server
- **Tags, search, pin / archive / trash** — familiar note workflow
- **Document OCR** — Tesseract in the browser (WASM); decrypted documents never leave the device for text extraction
- **Markdown** — live preview, toolbar, checklists
- **2FA** — account TOTP plus in-vault authenticator storage
- **Passkeys (WebAuthn)** — passwordless sign-in (vault unlock stays local)
- **Encrypted backups** — download or email `.enc.json` blobs; daily backup cron (on by default per account)
- **Offline PWA** — encrypted vault in IndexedDB; iOS-friendly layout and swipe-to-trash
- **Admin dashboard** — per-user quotas and storage overview

## Upgrade loop

Work in this Mac clone. **GitHub is the source of truth.** Production is the **Vienna VPS** (`62.83.35.198`, SSH host `netcup`). Do **not** `git pull` on Vienna, and do **not** develop on LXC 145.

```bash
# 1. edit here, then commit
git push origin main

# 2. ship code only (data and keys stay on Vienna)
bash deploy/deploy-deeperguard.sh
```

The deploy script SSHes to Vienna, unpacks `app/`, `deploy/`, and tests, writes `VERSION`, and restarts gunicorn on `127.0.0.1:80` behind Cloudflare. LAN TLS stays off.

- Marketing: https://www.deeperguard.com/
- Notes app: https://www.deeperguard.com/app
- Pool (separate tunnel on knots): https://pool.deeperguard.com/

## Quick start (local development)

Needs Python 3.11+. On this Mac use `python3.12`.

```bash
git clone https://github.com/deeperguard/Deeperguard.git
cd deeperguard
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
bash deploy/fetch-ocr-assets.sh
export NOTES_ROOT="$(pwd)" NOTES_DATA="$(pwd)/data" NOTES_KEYS="$(pwd)/keys"
mkdir -p data keys config
cp deploy/deeperguard.env.example config/deeperguard.env
./venv/bin/gunicorn -b 127.0.0.1:8080 'app:create_app()'
```

Open `http://127.0.0.1:8080/` and create an account.

## Other install paths

Scripts for a **Proxmox LXC** or a fresh Linux host are still in `deploy/`. Those are optional; live production is Vienna.

LAN-only TLS (`0.0.0.0:443`) is opt-in: `NOTES_ENABLE_LAN_TLS=1`. Leave it unset for Cloudflare.

See **[deploy/PRODUCTION.md](deploy/PRODUCTION.md)** for WAN exposure (Cloudflare Tunnel, rate limits, cookies).

### Configuration

All settings live in `config/deeperguard.env`. Important defaults:

| Variable | Default | Purpose |
|----------|---------|---------|
| `NOTES_STRICT_ZK` | `1` | Vault password never sent to server |
| `NOTES_SERVER_OCR` | `0` | No server-side document OCR |
| `NOTES_PUBLIC_HOST` | `www.deeperguard.com` | HTTPS links, passkeys |
| `NOTES_ALLOWED_CIDRS` | `192.168.1.0/24,10.0.0.0/24` | LAN + VPN firewall |

### Email backups

Configure SMTP in `deeperguard.env`:

```
NOTES_SMTP_HOST=smtp.example.com
NOTES_SMTP_PORT=587
NOTES_SMTP_FROM=notes@example.com
NOTES_SMTP_TLS=1
```

`NOTES_SMTP_FROM` must match what your mail provider allows as the sender address.

## iOS / PWA

1. Open **`https://www.deeperguard.com/`** (add to Home Screen from Safari)
2. Optional: **Add passkey** for sign-in; vault unlock still needs your master password locally
3. For self-hosted LAN installs, trust the local CA via `/ca.crt` first

Run `NOTES_HOST=www.deeperguard.com bash deploy/verify-ios-readiness.sh` before manual testing.

## Security model

- **Vault** — note bodies, tags, attachments encrypted client-side before sync
- **SRP-6a** — server stores verifier only, not your password
- **Strict ZK** — `/api/auth/verify-vault` disabled; server never checks vault password
- **Client OCR** — Tesseract.js, pdf.js; OCR text encrypted into vault before upload
- **LAN-only default** — UFW restricts HTTP/HTTPS to configured CIDRs

Details: [docs/PRIVACY.md](docs/PRIVACY.md)

## Tests

```bash
./venv/bin/python -m unittest discover -s tests -p 'test_*.py' -q
for f in tests/test_*.js; do node "$f"; done
NOTES_HOST=www.deeperguard.com bash deploy/verify-notes.sh
NOTES_HOST=www.deeperguard.com bash deploy/verify-zk-privacy.sh
```

Optional E2E (needs Chromium + Tesseract):

```bash
E2E_OFFLINE=1 ./venv/bin/python tests/e2e_offline_vault.py
```

## Publishing to GitHub

See **[docs/GITHUB.md](docs/GITHUB.md)** for account setup, naming, and first push.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).
