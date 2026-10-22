# DeeperGuard Security Review — 2026-10-02

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard) (`main` at `1440b5a`, includes signup admin notify #47 and recent PWA fixes)  
**Reviewer:** Cursor Cloud Agent (code review, no production access)  
**Method:** Static analysis of server (`app/`), client (`app/static/js/`), PWA (`sw.js`), deploy samples, and existing tests. No live penetration testing or dependency CVE scanning beyond lockfile inspection.

---

## Executive summary

DeeperGuard’s security posture is **strong for a self-hosted E2E notes PWA**: SRP-6a login, strict zero-knowledge defaults, per-user sync isolation in SQLite, CSRF + same-origin checks on mutating API calls, HttpOnly session cookies, and deliberate avoidance of caching authenticated API responses. The main gaps are **session-bound account recovery paths** that can rotate login credentials without re-proving the vault password, **client-side caching of derived key material**, **missing CSP**, and **operational risks** when legacy endpoints or server OCR are enabled.

No change to production crypto design is recommended from this review alone; several items warrant product-owner prioritization and follow-up PRs.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 8 |
| Informational | 6 |

---

## What is already solid

- **SRP-6a authentication** (`app/srp_auth.py`, `/api/auth/srp/*`): Password never sent during normal SRP login; server stores verifier only. RFC 5054 2048-bit group, Thinbus-compatible client.
- **Strict ZK default** (`NOTES_STRICT_ZK=1` in `deploy/deeperguard.env.example`): Server-side vault password verification disabled (`/api/auth/verify-vault` returns 410 when strict).
- **Session model** (`app/auth.py`, `app/app.py`): HttpOnly cookies, `SameSite=Lax`, optional `Secure`, sliding expiration, server-side session rows with remote revoke and “wipe local vault” on user-initiated sign-out.
- **CSRF + origin** (`app/auth.py` `csrf_ok`, `request_is_same_origin`): Required on authenticated `POST`/`PUT`/`PATCH`/`DELETE`; public auth routes still require same-origin for mutating requests.
- **Multi-tenant sync** (`app/db.py`): All item queries scoped by `user_id`; tests cover session IDOR and cross-user boundaries.
- **OCR privacy defaults** (`app/ocr_index.py`, `NOTES_OCR_EPHEMERAL=1`): Ephemeral server OCR responses; legacy plaintext indexes can be purged; **server OCR off by default** (`NOTES_SERVER_OCR=0`).
- **AI relay** (`app/ai_relay.py`): Fixed upstream host, field allowlist, size caps, no storage/logging of keys or prompts by design.
- **HTML rendering** (`app/static/js/markdown.js`, `search.js` `highlightPlain`, `superscript.js` `safeHref`, `link-overlay.js`): Escape-then-markdown pattern; `javascript:` URLs blocked in link sanitization.
- **Service worker** (`app/static/sw.js`): Does not intercept `/api/*` or auth pages; only caches shell and static assets.
- **Secrets handling** (`app/config.py`): Flask secret and SMTP password read from `keys/` or env; deploy tarball excludes `keys/` and `data/`.
- **Argon2** for legacy account password hashes (`app/passwords.py`) and vault KDF v2 alignment with client (`app/vault_crypto.py`).
- **2FA** (TOTP): Enforced in `before_request` until `/api/totp/verify` succeeds; rate limited per user id.
- **Contact form**: Honeypot field, IP rate limit, origin check, length bounds (`app/app.py` `api_contact`).

---

## Findings

### High

#### H-1 — Strict-ZK `vault-recovery` can rotate SRP credentials with only a hijacked session

| | |
|---|---|
| **Location** | `app/app.py` — `api_auth_vault_recovery()`, strict branch (~lines 870–889) |
| **Impact** | An attacker with a valid session cookie (XSS, malware, physical access before lock, or subdomain cookie scope) can POST new `srp_salt` / `srp_verifier` and regain **account login** without knowing the vault password. Encrypted notes remain protected unless the victim reused the same password for vault and account, but the victim can be locked out of SRP login and the attacker can establish known login credentials. |
| **Evidence** | In `strict_zk()` mode the handler requires `auth.current_user_id()`, CSRF, and matching email, but **does not** verify vault password, legacy hash, or prior SRP proof. Tests explicitly expect success with session + CSRF only (`tests/test_app.py`, vault-recovery test). |
| **Recommended fix** | Require a second factor for credential rotation: completed SRP step2 in the same session, WebAuthn assertion, or TOTP when enabled. Alternatively, require a client proof that the new verifier corresponds to a password that decrypts recovery sample notes (without sending the password—e.g. client-only check before calling API). Document the threat model if session-only recovery is intentional. |

#### H-2 — `repair-login` sends the account password to the server (undermines strict-ZK login narrative)

| | |
|---|---|
| **Location** | `app/app.py` — `api_auth_repair_login()` (~774–807), `_verify_login_password()` / `_srp_verifier_matches()` |
| **Impact** | On mobile recovery, the **plaintext account password** is POSTed to the server over HTTPS. With default `NOTES_STRICT_ZK=1`, vault verification is disabled, but the server still receives and processes the login password to validate/realign SRP verifiers. Server compromise, logging misconfiguration, or a malicious operator could capture passwords for users who use repair-login. |
| **Evidence** | `password = str(body.get("password") or "")` and `_verify_login_password(user, email, password)` which calls `generate_verifier_hex` / `verify_password` on the server. Client references in tests (`test_app.py` repair-login). |
| **Recommended fix** | Prefer client-only SRP repair (extend timeout UX on slow devices) or a zero-knowledge proof that the supplied verifier matches without sending the password (e.g. force SRP verify path only). If repair-login must remain, gate it behind env flag default-off on public deployments and audit that nothing logs request bodies. |

---

### Medium

#### M-1 — Derived vault key bytes cached in `sessionStorage`

| | |
|---|---|
| **Location** | `app/static/js/store.js` — `rememberDerivedKdf()` / `notes_kdf_cache` |
| **Impact** | After unlock, raw KDF output (base64) is stored in `sessionStorage` keyed by a short password fingerprint. Any XSS, malicious extension, or forensic access to the browser profile can decrypt the vault **without re-entering the password** until the tab session ends. |
| **Evidence** | `sessionStorage.setItem('notes_kdf_cache', JSON.stringify({ raw: btoa(binary), fp: passwordFingerprint(...) }))`. |
| **Recommended fix** | Default off or use non-extractable Web Crypto keys in memory only; optional “remember unlock on this device” with explicit user consent and shorter TTL. Document in privacy model. |

#### M-2 — pCloud backup passwords stored on disk in plaintext

| | |
|---|---|
| **Location** | `app/config.py` — `write_pcloud_password()`, `KEYS_DIR/pcloud-password-{user_id}` |
| **Impact** | Server filesystem compromise exposes users’ pCloud credentials (not vault passwords, but cloud backup channel). Files are mode `0600` but not encrypted at rest. |
| **Evidence** | `path.write_text(password.strip())` with no application-level encryption. |
| **Recommended fix** | Encrypt at rest with a server master key, or store only rclone OAuth tokens; encourage token-only flow in UI. |

#### M-3 — No Content-Security-Policy

| | |
|---|---|
| **Location** | `app/auth.py` — `security_headers()`; `app/app.py` `_headers` |
| **Impact** | XSS in any future template or script bug has full execution in the app origin (including access to session cookies on non-HttpOnly surfaces, `sessionStorage`, and IndexedDB). |
| **Evidence** | Headers include `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, optional HSTS — no `Content-Security-Policy`. |
| **Recommended fix** | Add a strict CSP for `/app` (nonce or hash for inline boot scripts), `script-src` limited to self, `frame-ancestors 'none'`, report-only phase first. |

#### M-4 — Server OCR exposes document plaintext when enabled

| | |
|---|---|
| **Location** | `app/app.py` `/api/ocr*`, `app/ocr.py` (subprocess to `pdftoppm`, `tesseract`, etc.) |
| **Impact** | If `NOTES_SERVER_OCR=1`, uploaded files are processed server-side; plaintext exists in process memory and may be returned in JSON. Misconfiguration on a public instance breaks the ZK story. |
| **Evidence** | `server_ocr_enabled()` gate; `ocr_mod.extract()`; subprocess usage in `ocr.py`. |
| **Recommended fix** | Keep default off; add startup warning if enabled on WAN; admin dashboard already surfaces `ocr_mode`. |

#### M-5 — Legacy `/api/auth/login` lacks rate limiting

| | |
|---|---|
| **Location** | `app/app.py` — `api_login()` (~928–941) |
| **Impact** | Remaining Argon2 legacy accounts can be targeted with online password guessing without the in-app limits applied to SRP/repair/TOTP endpoints. |
| **Evidence** | No `_auth_rate_limited()` call; SRP challenge uses `_auth_rate_limited("srp-challenge", ...)`. |
| **Recommended fix** | Apply the same `auth_rate_limit` keying as SRP (email + IP); prefer deprecating legacy login entirely. |

---

### Low

#### L-1 — Public `/api/health` information disclosure

| | |
|---|---|
| **Location** | `app/app.py` — `health()` |
| **Impact** | Unauthenticated callers learn DB size, disk free/total, build id, OCR queue depth, registration openness. Aids reconnaissance; not direct data breach. |
| **Evidence** | `public_path` includes `/api/health`; response includes `server`, `db_bytes`, `checks`. |
| **Recommended fix** | Minimal public probe (`ok` only) vs authenticated ops detail; or restrict by network (CIDR) on LAN deployments. |

#### L-2 — Email enumeration on registration

| | |
|---|---|
| **Location** | `app/app.py` — `api_auth_srp_register()` returns **409** `"account already exists"` |
| **Impact** | Attackers can learn which emails have accounts. |
| **Recommended fix** | Generic message + identical timing; or always return “check your email” if email verification is added. |

#### L-3 — In-memory auth rate limits

| | |
|---|---|
| **Location** | `app/auth_rate_limit.py` |
| **Impact** | Limits reset on process restart; ineffective across multiple workers without shared store. Edge WAF script exists (`deploy/setup-cloudflare-rate-limits.sh`) but must be operated separately. |
| **Recommended fix** | Document dependency on Cloudflare for WAN; optional Redis-backed limiter for multi-worker. |

#### L-4 — Session IP geolocation via third party

| | |
|---|---|
| **Location** | `app/auth.py` — `_lookup_ip_location()` → `ip-api.com` |
| **Impact** | User IPs leak to external service when Cloudflare geo headers absent (`NOTES_GEOIP=1` default). |
| **Recommended fix** | Disable off production (`NOTES_GEOIP=0`) or use only `CF-IPCity` / `CF-IPCountry`. |

#### L-5 — Broad session cookie domain

| | |
|---|---|
| **Location** | `app/config.py` — `session_cookie_domain()` → `.deeperguard.com` by default |
| **Impact** | Any compromised or malicious **subdomain** under the registrable domain can potentially steal session cookies (same-site cookie jar). |
| **Recommended fix** | Host notes only on `www`; avoid untrusted sibling subdomains; consider host-only cookies if subdomains are required for other products. |

#### L-6 — Local vault data at rest after unlock

| | |
|---|---|
| **Location** | `app/static/js/idb.js`, `store.js` |
| **Impact** | Decrypted notes and blobs in IndexedDB after unlock; expected for offline PWA, relevant for shared-device threat model. |
| **Recommended fix** | User education; vault lock modes (`vaultlock.js`); optional “clear local data on lock”. |

#### L-7 — Signup notify default recipient in source

| | |
|---|---|
| **Location** | `app/admin_notify.py` — `DEFAULT_SIGNUP_NOTIFY_RECIPIENTS` |
| **Impact** | Hardcoded personal email if `NOTES_SIGNUP_NOTIFY_EMAILS` unset; privacy/metadata leak to that mailbox on every new signup. |
| **Recommended fix** | Empty default; require explicit env on production. |

#### L-8 — Predictable default IndexNow key in config

| | |
|---|---|
| **Location** | `app/config.py` — `INDEXNOW_KEY` default string |
| **Impact** | Low; only proves URL ownership for search engines if attacker can host the path. |
| **Recommended fix** | Require env override in production. |

---

### Informational

1. **Open registration** (`NOTES_ALLOW_REGISTER=1`): No email verification; spam/abuse signups possible; admin notify (#47) helps ops awareness only.
2. **CSRF exemptions** (`/api/sync/pull`, `/api/account/unlock`): Mutations still require same-origin; cross-site responses not readable — acceptable with `SameSite=Lax`.
3. **Repair-login / vault-recovery** documented in tests as intentional UX tradeoffs for mobile and credential drift.
4. **Deploy script** (`deploy/deploy-deeperguard.sh`) references example LAN IPs — operational metadata in repo, not secrets.
5. **Vendor JS** (pdf.js, tesseract, etc.) vendored under `app/static/js/vendor/` with version pins in SW precache — standard supply-chain hygiene; no automated CVE gate in CI observed.
6. **`/api/promo`** public JSON — marketing copy only, no secrets.

---

## Prioritized recommendations

1. **H-1** — Tighten strict-ZK vault recovery (re-auth or cryptographic proof before SRP rotation).
2. **H-2** — Reduce or flag server-side password handling on `repair-login`.
3. **M-3** — CSP rollout (report-only → enforce).
4. **M-1** — Revisit KDF session cache policy and user-visible setting.
5. **M-5** — Rate-limit legacy login or remove endpoint.
6. **M-2** — Encrypt pCloud secrets at rest or push token-only auth.

---

## Out of scope (per request)

- Production crypto redesign, live deploy changes, or dependency CVE database audit.
- Findings without file-level evidence were not reported.

---

## Suggested verification for follow-up PRs

- Add integration test: strict-ZK `vault-recovery` denied without step-up auth (once implemented).
- Add rate-limit test for `/api/auth/login`.
- Manual: CSP report-only on staging PWA; confirm inline boot scripts and PDF worker blobs still load.
