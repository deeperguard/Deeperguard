# Self-hosting Deeperguard

Deeperguard runs as a Python app behind Gunicorn with optional TLS termination. This guide covers LAN homelab installs and WAN exposure.

## Quick paths

| Goal | Start here |
|------|------------|
| Proxmox LXC (homelab) | `deploy/create-deeperguard-lxc.sh` → `deploy/bootstrap.sh` → `deploy/install-services.sh` |
| Update running server | `deploy/deploy-deeperguard.sh` (set `NOTES_HOST`) |
| Public HTTPS (Cloudflare) | `deploy/setup-cloudflare-tunnel.sh` + `deploy/PRODUCTION.md` |
| iPhone / LAN HTTPS trust | Open `http://<host>/` once → install `/ca.crt` |

## First boot checklist

1. Copy `deploy/deeperguard.env.example` → `/opt/deeperguard/config/deeperguard.env`
2. Set `NOTES_ADMIN_EMAILS` to the email you will register with
3. Set `NOTES_PUBLIC_HOST` / `NOTES_PUBLIC_URL` for passkeys and PWA
4. Run `deploy/fetch-ocr-assets.sh` (client OCR for document search)
5. Run `deploy/install-services.sh` and `systemctl restart deeperguard deeperguard-tls`
6. Register at `/register`, then open `/admin` to manage users

## Health & monitoring

- `GET /api/health` — build, database size, OCR mode, readiness checks
- Admin dashboard → **Server** — disk, database, search index size
- Post-deploy smoke: `deploy/verify-notes.sh`, `deploy/verify-zk-privacy.sh`

## Configuration reference

See `deploy/deeperguard.env.example` for SMTP, quotas, registration policy (`NOTES_ALLOW_REGISTER`), OCR, and session lifetime.

## Backups

Daily encrypted vault backups run via cron (`deploy/cron/deeperguard-backup`). Pro users can also enable email and pCloud backups in app Settings.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| iPhone cannot unlock offline | Enable **Remember password** in Settings → Security; trust HTTPS cert |
| Document search empty | Wait for **Indexing…** badge to clear; run Settings → Advanced → Re-OCR |
| Passkeys fail | Use `https://www.deeperguard.com/` hostname or set `NOTES_PUBLIC_HOST` |
| Admin 403 | Add your email to `NOTES_ADMIN_EMAILS` and restart |
