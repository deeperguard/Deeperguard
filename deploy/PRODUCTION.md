# Production & WAN deployment

Deeperguard is designed as an encrypted notes app: **notes and attachments are always ciphertext on the server**. With `NOTES_STRICT_ZK=1` (default), **vault passwords are never sent to the server**.

This guide covers opening sign-up to the public internet safely.

## Zero-knowledge model (strict mode)

| Secret | On the wire | On the server |
|--------|-------------|---------------|
| Vault password | Never (client-only unlock) | Never stored |
| Account password (SRP) | Zero-knowledge proof only | SRP verifier only |
| Note / PDF / OCR text | AES-GCM ciphertext | Ciphertext only |
| Passkey | WebAuthn assertion | Public key only |

**Disabled in strict mode:** `POST /api/auth/verify-vault` (server decrypts samples).  
**Vault recovery:** requires an existing sign-in session; client sends only a new SRP verifier.

Set `NOTES_STRICT_ZK=0` only for break-glass homelab debugging (not recommended on WAN).

## Recommended architecture (WAN)

Do **not** port-forward raw HTTP to the LXC. Use one of:

1. **Cloudflare Tunnel** (recommended) — free HTTPS, DDoS shield, no open ports
2. **Tailscale / WireGuard** — private mesh; keep `NOTES_ALLOWED_CIDRS` for VPN only
3. **Reverse proxy** (Caddy/Traefik) — Let's Encrypt on a VPS or home edge

### Example: Cloudflare Tunnel

1. Point DNS `notes.yourdomain.com` to Cloudflare
2. Install `cloudflared` on CT 143 or a small edge VM
3. Tunnel `https://notes.yourdomain.com` → `http://127.0.0.1:80` (or `:443` with origin cert)
4. Set env:

```bash
NOTES_PUBLIC_HOST=notes.yourdomain.com
NOTES_WEBAUTHN_RP_ID=notes.yourdomain.com
NOTES_SECURE_COOKIES=1
NOTES_DISABLE_CIDR_GATE=1
NOTES_TRUST_PROXY_HOPS=1
NOTES_ALLOW_REGISTER=1
NOTES_STRICT_ZK=1
```

5. Use Cloudflare **Authenticated Origin Pulls** or restrict tunnel to your account

## Environment checklist

Copy `deploy/deeperguard.env.example` to `/opt/deeperguard/config/deeperguard.env`.

| Variable | Homelab | Public WAN |
|----------|---------|------------|
| `NOTES_STRICT_ZK` | `1` | `1` |
| `NOTES_ALLOW_REGISTER` | `1` | `1` (or `0` after you seed accounts) |
| `NOTES_DISABLE_CIDR_GATE` | `0` | `1` |
| `NOTES_ALLOWED_CIDRS` | `192.168.x.0/24,10.0.0.0/24` | ignored when gate disabled |
| `NOTES_SECURE_COOKIES` | `0` (LAN HTTP) | `1` (HTTPS only) |
| `NOTES_TRUST_PROXY_HOPS` | `0` | `1` behind one reverse proxy |
| `NOTES_MIN_PASSWORD_LENGTH` | `12` | `12`+ |
| `NOTES_SERVER_OCR` | `0` | `0` |
| `NOTES_SKIP_LOGIN` | `0` | `0` |
| `NOTES_SESSION_SECONDS` | `2592000` (30 days) | same — browser cookie uses this lifetime when signed in |

Persistent login cookies: after SRP sign-in the `session` cookie includes `Expires`/`Max-Age` (Flask permanent session). Ensure `/opt/deeperguard/keys/flask-secret` exists so gunicorn restarts do not invalidate every session.

## Free account sign-up flow

Already built in:

1. User opens `https://notes.yourdomain.com/register`
2. Browser generates SRP salt + verifier locally (**password never sent**)
3. `POST /api/auth/srp/register` creates account (rate-limited)
4. User is signed in → redirect to app → **vault unlock** with same password (or a separate vault password if you change it later)

**Hardening options:**

- Set `NOTES_ALLOW_REGISTER=0` after launch and create accounts manually
- Add invite tokens (future) or admin-only registration
- Enable **2FA (TOTP)** in Settings after first login
- Add **passkey** on iPhone for passwordless sign-in (hostname required, not IP)

## TLS

- **WAN:** Public CA (Let's Encrypt via Caddy/Cloudflare) — required for passkeys and `NOTES_SECURE_COOKIES=1`
- **LAN homelab:** Keep homelab CA (`deploy/generate-tls.sh`) and install `ca.crt` on devices

## Security verification

```bash
NOTES_HOST=notes.yourdomain.com NOTES_IP=<origin-ip> bash deploy/verify-zk-privacy.sh
bash deploy/verify-notes.sh
bash deploy/verify-ios-readiness.sh
```

Expect:

- Legacy register → `410`
- `verify-vault` → `410` when `NOTES_STRICT_ZK=1`
- SRP client + client-side `encryptObject` present

## Rate limits (in-memory)

Per IP + email, 24 attempts / 5 minutes on:

- `verify-vault` (legacy mode only)
- `vault-recovery`
- `repair-login`
- `srp/register`
- `srp/challenge`

For production WAN, add **fail2ban** or Cloudflare rate rules on `/api/auth/*`.

## Operational checklist before go-live

- [ ] HTTPS with trusted certificate
- [ ] `NOTES_SECURE_COOKIES=1`
- [ ] `NOTES_STRICT_ZK=1`
- [ ] `NOTES_SERVER_OCR=0`
- [ ] Registration policy decided (`NOTES_ALLOW_REGISTER`)
- [ ] Backups: SMTP and/or pCloud tested
- [ ] Firewall: no unnecessary open ports (prefer tunnel)
- [ ] Monitoring on CT 143 (disk, gunicorn, `journalctl -u deeperguard-tls`)
- [ ] Privacy policy / terms if offering free accounts to others

## Cloudflare Tunnel (deeperguard.com)

Production URL: **https://www.deeperguard.com/** (marketing) and **https://www.deeperguard.com/app** (notes PWA). Apex `deeperguard.com` redirects to www. Legacy host **`notes.deeperguard.com`** (if still in DNS) is redirected by the app to the same path on www (301/308).

### Automated setup

1. In Cloudflare dashboard → **My Profile → API Tokens → Create Token**
   - Template: **Edit Cloudflare Tunnel** + add **Zone → DNS → Edit** for `deeperguard.com`
2. On the notes host:

```bash
export CLOUDFLARE_API_TOKEN='your-token-here'
export CF_ZONE_NAME='deeperguard.com'
export CF_HOSTNAMES='www.deeperguard.com,deeperguard.com'
bash /opt/deeperguard/deploy/setup-cloudflare-tunnel.sh
```

3. Open `https://www.deeperguard.com/register` for sign-ups.

4. **Auth rate limits (required on WAN):** after the tunnel is live, run:

```bash
export CLOUDFLARE_API_TOKEN='your-token-here'   # Zone WAF Edit
export CF_ZONE_NAME='deeperguard.com'
bash /opt/deeperguard/deploy/setup-cloudflare-rate-limits.sh
```

This blocks `/api/auth/*` above 30 requests/minute per IP at the edge. The app also enforces in-process limits (`NOTES_AUTH_RATE_LIMIT_WAN=12` when `NOTES_DISABLE_CIDR_GATE=1`).

The script creates the tunnel, proxied CNAMEs for **www** and **apex**, `cloudflared` systemd service, and updates `deeperguard.env`:

- `NOTES_PUBLIC_HOST=www.deeperguard.com`
- `NOTES_WEBAUTHN_RP_ID=deeperguard.com` (passkeys on www + apex)
- `NOTES_PUBLIC_URL=https://www.deeperguard.com`
- `NOTES_DISABLE_CIDR_GATE=1`, `NOTES_TRUST_PROXY_HOPS=1`, `NOTES_SECURE_COOKIES=1`

**Apex redirect (recommended):** if `https://deeperguard.com` fails but `www` works, the apex DNS often still points at a home IP. Run:

```bash
export CLOUDFLARE_API_TOKEN='your-token'   # Zone DNS Edit + Dynamic URL Redirects Write
bash /opt/deeperguard/deploy/setup-cloudflare-apex-redirect.sh
```

This removes stale apex A records, CNAMEs `@` to the tunnel (proxied), and adds a 301 redirect to `https://www.deeperguard.com`.

**Host firewall:** leave UFW as-is (LAN-only 80/443). The tunnel connects **outbound** to Cloudflare — no WAN inbound rules needed.

## What the server still sees (metadata)

Even in strict ZK, the server learns:

- Email addresses
- Sync timing, item counts, ciphertext sizes
- IP addresses (for rate limiting)

It **cannot** read note titles, bodies, PDFs, or vault passwords without the user's device.
