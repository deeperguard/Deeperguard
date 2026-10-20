# DeeperGuard Security Review — 2026-10-20

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `4abe83c` (Round 29 / #115). Includes everything after the 2026-10-19 review (`60eeb3a`): security fixes #96 and UI/unlock rounds #97–#115.
**Reviewer:** Cursor Cloud Agent — static review of current `main` plus local unit tests (`tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`, `tests/test_verification_send_limit.py`, `tests/test_uploads.py`, `tests/test_sync_push_partial.py`, `tests/test_sync_cursor.py`: 42/42 pass; `tests/test_app.py` auth/session/CSRF/SRP/TOTP/unlock/backup-verify subset: 46/46 pass). No production access, no live penetration testing.
**Scope:** Auth (SRP, sessions, WebAuthn, TOTP/2FA, password change/recovery), vault/crypto (server and client), sync/API authorization, CSP/security headers, rate limits, deploy defaults, OCR/pCloud misconfiguration, and the #96 email-verify / markdown controls.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-19 review (`docs/SECURITY-REVIEW-2026-10-19.md`, draft-PR #95, branch only — prior reports are not on `main`) reviewed `main` at `60eeb3a`. Everything that landed after it (#96 plus #97–#115) is new surface covered here.

---

## Executive summary

**No new Critical or High findings. No new Medium that needs a code fix. No regressions of previously fixed items.** The #96 security PR closed the only new Medium from 10-19 (unbounded backup-verification mail) and the four new Lows that went with it (OTP hashing, backup-resend short-circuit, markdown `href` escaping, and the backup-attachment send cap). Vault unlock is stronger than on 10-19: `/api/account/unlock` now requires an SRP proof (or a legacy password), and an empty server vault is no longer treated as proof of the derived key.

The large client UI delta (#97–#115: session UX, GFM tables, hash/autolinks, account stats, offline recovery) does not change server authorization. Item, blob, reminder, session, and OCR-job queries remain scoped by the authenticated `user_id`. Local persistence is still ciphertext-only. CSP, deploy defaults, and pCloud/OCR defaults are unchanged.

One **new Low** is recorded: session-cookie rebound via client `X-Device-Id` (same-user “this device” adoption, introduced with #112). Carry-over Mediums are unchanged: pCloud WebDAV passwords on disk (still awaiting Dennis’s decision — **not** accepted) and server OCR when explicitly enabled (defaults remain safe). WAN Secure-cookie remains warning-only.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 2 (both carry-over; 10-19’s M-3 is **closed**) |
| Low | 12 (11 remaining carry-over, 1 new; 10-19’s L-10 / L-13 / L-14 / L-15 are **closed**) |
| Informational | 8 (all carry-over) |

### Top findings (current)

1. **M-1 (Medium, carry-over — open product decision):** pCloud WebDAV passwords still stored in plaintext under `keys/`. **Not accepted.** Still awaiting Dennis’s decision.
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place.
3. **L-17 (Low, new — code fix):** an authenticated request can adopt another live same-user session row by sending that row’s `X-Device-Id`, rotating the adopted row’s token.

---

## What changed since the 2026-10-19 review (`60eeb3a` → `4abe83c`)

Server-side security-relevant delta:

- **#96 (`175a4f3`):** new `app/verification_send_limit.py` (SQLite `email_send_log`, 60 s cooldown, 5/day verify caps, 12/day backup-attachment cap). `app/email_verify.py` now HMAC-SHA256s codes with the Flask secret and recipient, and compares with `hmac.compare_digest`. Backup settings / unverified backup-email / resend paths catch `VerificationSendLimited`. Backup resend short-circuits when the recipient is already verified. Markdown `href` uses `escapeAttr()`.
- **Unlock hardening (#102 / #104 / related):** `POST /api/account/unlock` requires SRP `A`/`M1` (or a legacy password). New `POST /api/account/unlock/challenge` is stored-verifier SRP step-1 (`SRP_PURPOSE_UNLOCK`). Empty vaults stay `keyVerified = false` until `proveEmptyVaultWithAccountPassword`.
- **Session alignment (#112):** `_align_session_with_request()` can rebound the cookie onto the live row for the request’s `X-Device-Id` (same `user_id` only) and rotate that row’s token. See **L-17**.
- **`GET /api/boot-account`:** signed-out probe returns `{signed_out: true}`; authenticated callers get `api_account()`. No extra fields.
- **Account stats:** `GET /api/account` embeds `db.user_vault_stats(uid)` (storage bytes / quota). Self-scoped.
- **OCR:** `app/ocr.py` list-preview constants only (larger JPEGs when server OCR is on). Defaults unchanged.
- **Public path:** `/favicon.ico` added to `public_path` / `cacheable_shell`.

`app/srp_auth.py`, `app/uploads.py`, `app/ocr_index.py`, `app/backup_pcloud.py`, `app/config.py` (defaults), `app/auth_rate_limit.py`, and `deploy/` were **not** functionally changed in this window.

Client-side (security-relevant): empty-vault / wrong-password unlock; dead/expired session returns to sign-in; offline recovery after a local decrypt proof (`notes_offline_unlock_verified` is a UX flag, not a crypto gate); GFM tables + hash/autolinks (scheme allowlist + `escapeAttr`); `persistLocal()` still wraps before IndexedDB.

---

## Fixes verified since the 2026-10-19 review

| Prior ID | Topic | Status on `4abe83c` |
|----------|-------|---------------------|
| **M-3** (10-19) | Backup verification mail unbounded | **Fixed** (#96). `verification_send_limit.check_verification_send()`: 60 s cooldown, 5/day per user and per recipient. Settings and the unverified `/api/backup/email` branch catch `VerificationSendLimited` (`app/app.py` 1779–1787, 1808–1814). |
| **L-10** (10-15/10-19) | Manual backup-attachment send uncapped | **Fixed** (#96) for `POST /api/backup/email`. `check_backup_attachment_send` / `record_backup_attachment_send` (12/day). Cron `backup_cron.send_user_backup` is still uncapped (one mail per enabled user per run; not the abuse path). |
| **L-13** (10-19) | Unsalted SHA-256 verification codes | **Fixed** (#96). HMAC-SHA256(`flask_secret`, `user_id:purpose:recipient:code`); `hmac.compare_digest` (`app/email_verify.py` 24–31, 83–84). |
| **L-14** (10-19) | Backup resend always sent | **Fixed** (#96). `api_backup_email_resend()` returns early when `recipient_verified` (`app/app.py` 2580–2581). Verify rate-limit key is the recipient (2565). |
| **L-15** (10-19) | Markdown `href` unescaped | **Fixed** (#96). `escapeAttr()` on both inline render paths (`app/static/js/markdown.js` 9–15, 113–116, 153–156). Hash/autolink additions keep the scheme allowlist. |

---

## Fixes still holding (re-verified on `4abe83c`)

| Prior ID | Topic | Status on `4abe83c` |
|----------|-------|---------------------|
| SRP `A ≡ 0 (mod N)` | `app/srp_auth.py` `step2()` | **Still fixed** — rejects `A % N == 0`, malformed hex, `u == 0`; constant-time M1 compare. `tests/test_srp_auth.py` passes. |
| C-1 / #66 | SRP challenge state server-side | **Still fixed** — cookie holds only a random id; `srp_challenges` table, single-use consume, 300 s TTL. `tests/test_srp_server_challenge.py` passes. |
| L-11 / #68 | Login SRP consume re-binds current verifier | **Still fixed** — `auth.pop_srp_state()` passes current `srp_salt`/`srp_verifier`. |
| M-3 (10-13) / #68 | TOTP setup overwrite | **Still fixed** — `api_totp_setup()` requires a current code when TOTP is already enabled (`app/app.py` 1653–1657). |
| M2 required on client | `app/static/js/srp-auth.js` `login()` | **Still in place** — throws when `M2` is missing, then `step3` (245–250). |
| Two-phase ZK password change / #63 | `api_account/password/*` | **Still in place** — rotation token consume-on-commit; SRP commit clears leftover hash. |
| Ephemeral OCR store | `ocr_index.save_file_only()` | **Still in place** — refuses raw bytes when `NOTES_OCR_EPHEMERAL=1`. |
| rclone obscure via stdin | `backup_pcloud.write_rclone_config()` | **Still in place** — `rclone obscure -` with password on stdin (133–140). |
| Upload dirs keyed by `user_id` | `app/uploads.py` | **Still in place**. |
| Auth rate limits | unauthenticated auth endpoints | **Still in place**; WAN tightening when the CIDR gate is open. |
| Info-7 (10-13) | crypto-worker `fromB64` / salt | **Still fixed** — worker uses `charCodeAt(i)` and the real salt; params still Argon2id t=3, m=64 MiB, p=2, 32-byte key. |

---

## New surface reviewed (#96 + #97–#115) — High/Medium

- **Sync / IDOR:** `app/db.py` in this window adds `email_send_log` helpers and `user_vault_stats()`. Existing item/blob/reminder/session queries are unchanged and remain `WHERE user_id = ?` with the authenticated id. Conflict rows still return only the caller’s own ciphertext. Account stats are self-scoped.
- **Unlock / KDF:** `probeServerKey` returns `{empty: true}` without setting `keyVerified`. Writes stay blocked while `cryptoKey && !keyVerified`. No salt skip, no param downgrade. Empty-vault proof is SRP (or legacy password) via `/api/account/unlock`.
- **Offline recovery (#115):** after a successful local decrypt, the client may set `notes_offline_unlock_verified` (onboarding/UX). It does not skip `wrapItem()`, does not persist plaintext, and does not unlock an empty device offline.
- **IndexedDB:** `persistLocal()` still `wrapItem()`s before `NotesIDB.putItem()`; `persistCipherRowFromServer()` stores server ciphertext as-is. Search index is in-memory only.
- **Service worker:** `isApi()` still short-circuits `/api/*`.
- **CSP:** `content_security_policy()` is unchanged. GFM table `align` values are only `left`/`right`/`center`; link labels are escaped before interpolation.
- **OCR:** new work remains client-side. Server OCR defaults remain off/ephemeral. Preview JPEG caps grew only on the legacy server-OCR path.
- **Email verify authz:** verify/resend use `auth.current_user_id()` and `check_code(uid, …)` for that same uid. Codes are POSTed in JSON. New/changed send paths are rate-limited. No open redirect.
- **`GET /api/boot-account`:** no account metadata when signed out.

---

## Findings

### Critical

None.

### High

None.

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext on disk (carry-over; open product decision)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | Known (every review since 2026-10-08); unchanged. |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud *account* passwords (not vault passwords). |
| **File refs** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`); `app/backup_pcloud.py` `write_rclone_config()` (reversibly-obscured `pass=` in `keys/pcloud-rclone-{user_id}.conf`, mode `0600`). |
| **Status** | **Still open — awaiting Dennis’s decision. Not accepted.** The #64 `rclone obscure` stdin fix remains in place; the OAuth-token path (`pcloud_token`) exists and is preferred when present. Not a new finding. |
| **Needs a code fix?** | Yes, once the owner decides (store an OAuth token only, or encrypt the password at rest with the Flask secret / a server key). No code in this review. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged architecture. Preview constants only (`app/ocr.py` 19–21: 432 px / 160 KiB / 144 DPI when server OCR is on). |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `log_server_ocr_startup_warning()`. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral `/api/ocr/store` still refuses to persist raw bytes (`ocr_index.save_file_only()`); `purge_legacy_plaintext_indexes()` runs when ephemeral; OCR jobs remain user-scoped. |
| **Needs a code fix?** | No, unless server OCR is turned on. Keep the default off. |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)
`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The #63 SRP password-change commit path does clear it.
**File refs:** `app/app.py` `api_auth_srp_upgrade()` 1104–1126; `app/db.py` `upgrade_user_to_srp()`; `deploy/set-account-password.py`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts and no per-endpoint rate limit (carry-over, still open)
For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code; there is no `_auth_rate_limited` call on the endpoint. (Setup remains protected — prior M-3 of 10-13 fixed.)
**Newly noted, unchanged:** `POST /api/auth/webauthn/remove` is the same family — session + CSRF only, no password/TOTP/SRP step-up (`app/app.py` 1272–1283).
**File refs:** `app/app.py` `api_totp_disable()` 1687–1706.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, still open)
Authenticated `POST /api/account/vault-kdf` bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only (cannot downgrade), not a ciphertext oracle.
**File refs:** `app/app.py` `api_account_vault_kdf()` 1549–1563; `app/db.py` `update_user_vault_kdf_version()`.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)
`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits HSTS; a one-time startup warning is logged. **Status: owner-accepted as warning-only; status noted, not re-opened.**
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()`; `app/app.py` `SESSION_COOKIE_SECURE`; `app/auth.py` `security_headers()`.

#### L-5 — Account enumeration on auth endpoints (carry-over, still open; product decision)
`/api/auth/srp/register` returns `409` for existing emails; SRP challenge vs WebAuthn login options remain distinguishable (`401` vs `404 no passkeys registered`). All are rate-limited.
**File refs:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open; partially improved)
Limits reset on restart; production gunicorn is `--workers 1` so workers do not split buckets today. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP) — not `/api/account/*`, `/api/backup/*`, or `/api/totp/*`. The unbounded `_hits`/`_GEO_CACHE` dicts grow with distinct keys.
**Improved by #96:** verification and backup-attachment sends now use a SQLite log (survives restart; shared by the single worker).
**File refs:** `app/auth_rate_limit.py`; `app/auth.py` `_GEO_CACHE`; `app/verification_send_limit.py`; `deploy/setup-cloudflare-rate-limits.sh`.

#### L-7 — Broad session cookie domain (carry-over, still open)
Default registrable-domain scope (`.deeperguard.com`) shares sessions with sibling subdomains; `request_is_same_origin()` still rejects bare `same-site` (Origin/Referer must match the notes host), and HttpOnly blocks JS reads.
**File refs:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py`; `app/auth.py` `request_is_same_origin()` 473–521.

#### L-8 — Predictable default IndexNow key (carry-over, still open)
Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY`.

#### L-9 — CSP residual hardening (carry-over, still open)
`style-src 'unsafe-inline'`; no `report-to`/`report-uri`; `script-src` remains nonce-based with `'wasm-unsafe-eval'` (needed for Argon2 / OCR wasm). Markdown `href` interpolation is **fixed** (was L-15).
**File refs:** `app/auth.py` `content_security_policy()`.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (carry-over, still open)
All three units omit `User=`/`Group=` and sandboxing directives, so gunicorn runs as root (binding `127.0.0.1:80` encourages this). The optional LAN-TLS unit still binds `0.0.0.0:443` as root (installer refuses it when the CIDR gate is open).
**File refs:** `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service`.
**Remediation outline:** dedicated user + `AmbientCapabilities=CAP_NET_BIND_SERVICE` (or socket activation) and standard `ProtectSystem=` / `PrivateTmp=` / `NoNewPrivileges=`. Deploy-only; no app code.

#### L-16 — Login/register boot handoff stashes derived vault-key bytes in `sessionStorage` (carry-over, still open)
`notes_boot_kdf` still holds AES-GCM ciphertext of the Argon2 output next to the boot storage key so `/app` can `adoptDerivedVaultKey()` and skip a second derive. Cleared on consume/lock; session-scoped. Same family as I-5. Not a remote issue.
**File refs:** `app/static/js/vault-secrets.js` `stashBootDerivedKey()` 101–123, `consumeBootPassword()` 131–168; `app/static/js/store.js` `adoptDerivedVaultKey()`.

#### L-17 — Session cookie can adopt another live same-user row via `X-Device-Id` (new)

| | |
|---|---|
| **New vs known** | **New** (introduced in #112 / `766ebfd` for the “this device” badge). |
| **Impact (one line)** | An already-authenticated request that names another live device id for the same account rotates that row’s token into this cookie, so the other browser’s cookie stops matching. Same-user only; device ids are high-entropy and are not returned by `GET /api/sessions`. Authenticated callers can already revoke sessions explicitly. |
| **File refs** | `app/auth.py` `_align_session_with_request()` 175–200, `ensure_device_session()` 222–236; `app/db.py` `get_active_session_for_device()` 774–786, `rotate_session_token()` 789–803. Covered by `tests/test_app.py` `test_this_device_is_the_request_session`. |
| **Remediation outline** | Rebound only when the cookie row’s stored `device_id` is empty or already equals the request’s device id. Do not rotate a *different* live row from a client-supplied header alone. |

### Informational

1. **I-1 (carry-over):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without requiring email verification for login — abuse surface; signup-notify emails are awareness only. Verification still gates backups (now rate-limited; see #96).
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts (rate-limited, refuses SRP accounts); `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1).
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over):** Vendored JS under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) without an automated CVE gate in CI.
5. **I-5 (carry-over):** "Remember on device" password stash stores the AES-GCM key next to the ciphertext in web storage — obfuscation against casual inspection only; inherent to the opt-in feature. Extended by L-16 for the boot derived key.
6. **I-6 (carry-over):** when the session cookie names **no** account at all, `session_requires_wipe()` still falls back to the newest session for the client-supplied `X-Device-Id` across accounts. Availability nuisance; local cache is per-account ciphertext.
7. **I-7 (carry-over):** Deploy pipeline pushes as root over SSH with `StrictHostKeyChecking=accept-new` (TOFU) to the pinned production IP; tarball excludes `keys/` and `data/`; gunicorn stays on `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open.
8. **I-8 (carry-over):** service worker still caches session-scoped `/app` HTML (`networkFirstNavigate` + `putBoth`). Offline, a prior login’s `data-csrf` can be replayed from cache on the same profile. `/api/*` is not intercepted; API responses stay `no-store`.

Contact-form header injection was re-checked and is **not** an issue: visitor name/subject flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values.

Positive in this window (not findings): session-only vault unlock is gone; empty vaults require an SRP (or legacy) proof; verification/backup mail is capped.

---

## Status of previously known open items (requested checklist)

| Item | Status on `4abe83c` |
|------|---------------------|
| SRP `A ≡ 0 (mod N)` bypass | **Still fixed** |
| SRP challenge state server-side (C-1, #66) | **Still fixed** |
| Login SRP verifier binding (L-11, #68) | **Still fixed** |
| TOTP setup overwrite (M-3 of 10-13, #68) | **Still fixed** |
| M2 required on client | **Still in place** (`srp-auth.js` 245–250) |
| Ephemeral OCR store | **Still in place** |
| rclone obscure via stdin | **Still in place** (`backup_pcloud.py` 133–140) |
| Two-phase ZK password change (#63) | **Still in place** |
| Upload dirs keyed by `user_id` | **Still in place** |
| Auth rate limits | **Still in place** on unauthenticated auth endpoints; verification/backup mail now SQLite-capped |
| Signup notify | **Still in place** (`admin_notify.notify_new_user_signup`) |
| Unbounded backup-verification mail (M-3 of 10-19) | **Closed** (#96) |
| Unsalted OTP hashes / backup resend / markdown href (L-13–L-15) | **Closed** (#96) |
| Manual backup-attachment cap (L-10) | **Closed** (#96) for the user API |
| pCloud plaintext passwords | **Still open** (M-1) — awaiting Dennis; **not** accepted |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted |
| systemd unit hardening (L-12) | **Still open** |

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** all item/blob/reminder/session/OCR-job/upload queries scoped by authenticated `user_id`; device-session tokens stored as SHA-256 hashes; `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session (unlock now also requires SRP/legacy proof) and pass the same-origin gate for POSTs.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match against the canonical www/apex set; bare `same-site` rejected; `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare). Unlock/challenge is not CSRF-exempt.
- **Headers/CSP:** nonce-based `script-src`, `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; HSTS when Secure cookies are on; `/api/*` is `no-store`.
- **AI relay:** `app/ai_relay.py` — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged; no SSRF surface (unchanged).
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`.
- **Vault crypto:** Argon2id v2 params aligned between `app/vault_crypto.py`, `app/static/js/crypto.js`, and `crypto-worker.js` (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV).
- **Health:** `/api/health` still returns only `ok` / `service` / `build` for anonymous callers; extra fields remain admin-session-only.
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1` defaults; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`. Gunicorn stays on `127.0.0.1:80`; `NOTES_ENABLE_LAN_TLS` defaults off.

---

## Recommended next steps (priority)

1. **M-1:** owner decision on pCloud password storage (OAuth-token only, or encrypt at rest). Not accepted as-is.
2. **L-17 (code fix):** rebound the cookie only when the cookie row already names this device (or has no device id yet).
3. **L-2 / L-16:** TOTP-disable (and passkey-remove) step-up + rate limit; drop or document the boot derived-key stash.
4. **L-1 / L-3 / L-12:** clear leftover Argon2 hashes on SRP upgrade; bind the vault-KDF bump; systemd `User=` + sandboxing (deploy-only).
5. **L-4 / M-2:** product/ops decisions unchanged (WAN warning-only; keep server OCR off).

*End of report.*
