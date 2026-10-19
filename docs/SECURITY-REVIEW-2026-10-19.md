# DeeperGuard Security Review — 2026-10-19

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `60eeb3a` (Round 12 / #94). Includes everything after the 2026-10-15 review (`e25f213`): email-verification for account/backup recipients, 404 handling, app-shell cache tightening, unlock/KDF UX (`keyVerified` / `probeServerKey` / boot derived-key stash), on-device photo OCR, search/Files-view work, and UI rounds #80–#94.
**Reviewer:** Cursor Cloud Agent — static review of current `main` plus local unit tests (`tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`, `tests/test_uploads.py`, `tests/test_sync_push_partial.py`, `tests/test_sync_cursor.py`, and the new email-verify / signed-in register cases in `tests/test_app.py`: 38/38 pass). No production access, no live penetration testing.
**Scope:** Auth (SRP, sessions, WebAuthn, TOTP/2FA, password change/recovery), vault/crypto (server and client), sync/API authorization, CSP/security headers, rate limits, deploy defaults, OCR/pCloud misconfiguration, and the new email-verification control.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-15 review (`docs/SECURITY-REVIEW-2026-10-15.md`, draft-PR branch only — prior reports are not on `main`) reviewed `main` at `e25f213`. Everything that landed after it (#80–#94 plus the email-verify / marketing pages) is new surface covered here.

---

## Executive summary

**No new Critical or High findings. No regressions of previously fixed items.** The large client UI/OCR/search delta does not change server authorization: item, blob, reminder, session, and OCR-job queries remain scoped by the authenticated `user_id`. Local persistence is still ciphertext-only. CSP is unchanged. Deploy/OCR/pCloud defaults are unchanged.

The material new control is **email verification for encrypted backup recipients** (`app/email_verify.py`). That is a net improvement over the previous “any session can mail a backup to any address” path, but two new issues need a code fix: (1) **Medium** — `/api/backup/settings` and the unverified branch of `/api/backup/email` send mail to a caller-chosen address with no per-endpoint rate limit or cooldown, while registration stays open; (2) **Low** — 6-digit codes are stored as unsalted SHA-256. Carry-over Mediums (pCloud plaintext passwords; server OCR when enabled) are unchanged product/ops decisions.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 3 (2 carry-over, 1 new) |
| Low | 15 (11 carry-over, 4 new) |
| Informational | 8 (7 carry-over, 1 new) |

### Top findings (current)

1. **M-3 (Medium, new — code fix):** `/api/backup/settings` and unverified `/api/backup/email` send verification messages to a caller-chosen address with no dedicated rate limit or cooldown. Combined with default-open registration this is an outbound-mail relay (branded OTP mail), distinct from the older backup-attachment issue (L-10).
2. **M-1 (Medium, carry-over — product decision):** pCloud WebDAV passwords still stored in plaintext under `keys/` (owner decision previously recorded as accepted-for-now).
3. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place.

---

## What changed since the 2026-10-15 review (`e25f213` → `60eeb3a`)

Server-side security-relevant delta is small and concentrated:

- **New module** `app/email_verify.py` and four authenticated POST routes: `/api/account/email/verify`, `/api/account/email/resend`, `/api/backup/email/verify`, `/api/backup/email/resend`.
- **Backup gating:** cron and manual backup now require `email_verify.recipient_verified()` (`app/backup_cron.py`, `app/app.py` `api_backup_email`). New SRP users start with `email_verified=0`; existing rows are grandfathered verified.
- **404 vs login bounce** for unmatched URLs (`app/app.py` `_gate` / `not_found`).
- **App-shell cache:** `/app` and `/manifest.json` now `must-revalidate` (dropped `stale-while-revalidate`).
- **Public paths:** `/contact`, `/download` (GET pages only; `POST /api/contact` already existed and remains 6/hour/IP).
- **Client:** unlock now treats a derived key as unverified until ciphertext decrypts or the server vault is empty (`store.js` `keyVerified` / `probeServerKey`); login/register can stash the derived key in `sessionStorage` for a faster first unlock; markdown gained `https`/`mailto` links; service worker still never intercepts `/api/*`.

`app/srp_auth.py`, `app/uploads.py`, `app/ocr.py`, `app/ocr_index.py`, `app/backup_pcloud.py`, `app/config.py` (defaults), and `deploy/` were **not** functionally changed in this window.

---

## Fixes still holding (re-verified on `60eeb3a`)

| Prior ID | Topic | Status on `60eeb3a` |
|----------|-------|---------------------|
| SRP `A ≡ 0 (mod N)` | `app/srp_auth.py` `step2()` | **Still fixed** — rejects `A % N == 0`, malformed hex, `u == 0`; constant-time M1 compare. `tests/test_srp_auth.py` passes. |
| C-1 / #66 | SRP challenge state server-side | **Still fixed** — cookie holds only a random id; `srp_challenges` table, single-use consume, 300 s TTL. `tests/test_srp_server_challenge.py` passes. |
| L-11 / #68 | Login SRP consume re-binds current verifier | **Still fixed** — `auth.pop_srp_state()` passes current `srp_salt`/`srp_verifier`. |
| M-3 (10-13) / #68 | TOTP setup overwrite | **Still fixed** — `api_totp_setup()` requires a current code when TOTP is already enabled (`app/app.py` 1573–1577). |
| M2 required on client | `app/static/js/srp-auth.js` `login()` | **Still in place** — throws when `M2` is missing, then `step3`. |
| Two-phase ZK password change / #63 | `api_account/password/*` | **Still in place** — rotation token consume-on-commit; SRP commit clears leftover hash. |
| Ephemeral OCR store | `ocr_index.save_file_only()` | **Still in place** — refuses raw bytes when `NOTES_OCR_EPHEMERAL=1`. |
| rclone obscure via stdin | `backup_pcloud.write_rclone_config()` | **Still in place** — `rclone obscure -` with password on stdin. |
| Upload dirs keyed by `user_id` | `app/uploads.py` | **Still in place**. |
| Auth rate limits | unauthenticated auth endpoints | **Still in place**; WAN tightening when the CIDR gate is open. |
| Info-7 (10-13) | crypto-worker `fromB64` / salt | **Still fixed** — worker uses `charCodeAt(i)` and the real salt; params still Argon2id t=3, m=64 MiB, p=2, 32-byte key. |

---

## New surface reviewed (#80–#94 + email verify) — High/Medium other than M-3

- **Sync / IDOR:** `app/db.py` in this window only adds email-verify columns and helpers. Existing item/blob/reminder/session queries are unchanged and remain `WHERE user_id = ?` with the authenticated id. Conflict rows still return only the caller’s own ciphertext.
- **Unlock / KDF:** `resolveUnlockKdfVersion` / `kdfFastReject` skip a server pull when local samples fail both KDF versions (availability/UX). A derived key cannot push until `probeServerKey` or a local decrypt marks `keyVerified`. Empty vaults are treated as verified (correct for a new account). No salt skip, no param downgrade.
- **IndexedDB:** `persistLocal()` still `wrapItem()`s before `NotesIDB.putItem()`; `persistCipherRowFromServer()` stores server ciphertext as-is. Search index is in-memory only (`search.js` `noteIndex`).
- **Service worker:** `isApi()` still short-circuits `/api/*`. New marketing paths (`/contact`, `/download`) are treated as marketing (not cached as the app shell). Cached shell still uses `credentials: 'same-origin'` for `/app` (same model as 10-15; see I-7 carry-over).
- **CSP:** `content_security_policy()` is unchanged. `app.html` **removed** leftover inline `onsubmit`/`onclick` (helps future `script-src-attr` tightening).
- **OCR:** new work is client-side (`client-ocr-engine.js`, `photo-ocr-preprocess.js`). Server OCR defaults remain off/ephemeral.
- **Email verify authz:** verify/resend use `auth.current_user_id()` and `check_code(uid, …)` for that same uid. Codes are POSTed in JSON, not in URLs. New routes are not CSRF-exempt (same-origin + CSRF token). No open redirect.

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
| **Status** | **Still open — recorded owner decision, accepted-for-now.** The #64 `rclone obscure` stdin fix remains in place; the OAuth-token path (`pcloud_token`) exists and is preferred when present. Not re-opened as actionable. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged. |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `log_server_ocr_startup_warning()`. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral `/api/ocr/store` still refuses to persist raw bytes (`ocr_index.save_file_only()`); `purge_legacy_plaintext_indexes()` runs when ephemeral; OCR jobs remain user-scoped. |

#### M-3 — Backup verification mail has no per-endpoint rate limit or cooldown (new — code fix)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | **New.** Distinct from carry-over **L-10** (sending the *encrypted backup attachment* via `/api/backup/email`). This is the new “send a branded OTP” path that landed with email verification. |
| **Impact (one line)** | Any authenticated account can send official-looking “Verify your Deeperguard backup email” messages (with a live 6-digit code) to a chosen address as fast as the app will accept POSTs; default-open registration makes an account cheap to obtain. Cloudflare’s `/api/auth/*` rule does not cover these paths. |
| **File refs** | `app/app.py` `api_backup_settings()` 1699–1704 (sends on every save while `verified` is false, including re-saves of the same unverified address); `app/app.py` `api_backup_email()` 1724–1732 (sends a code on the unverified 403 path); `app/email_verify.py` `send_backup_code()` / `send_account_code()` 110–143. Contrast: `api_contact()` is capped at 6/hour/IP (`app/app.py` 544–545) and only mails `CONTACT_EMAIL`; the dedicated resend routes *are* `_auth_rate_limited`. |
| **Verified** | `api_backup_settings` has no `_auth_rate_limited` / cooldown / “code still live” short-circuit. `issue_code()` always replaces the hash and resets the attempt counter. Registration remains `NOTES_ALLOW_REGISTER=1` by default. |

**Fix recommendation:** Rate-limit backup-settings and the unverified `/api/backup/email` branch **per `user_id`** (not only per IP), and add a send cooldown (reuse the outstanding hash until TTL or a small resend interval). Cap sends per account per hour. Do not send again when a non-expired code for that recipient already exists. Optionally refuse to send backup-verification mail until the *account* email is verified, so a fresh signup cannot aim the SMTP relay at strangers.

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)
`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The #63 SRP password-change commit path does clear it.
**File refs:** `app/app.py` `api_auth_srp_upgrade()` 1089–1111; `app/db.py` `upgrade_user_to_srp()`; `deploy/set-account-password.py`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts and no per-endpoint rate limit (carry-over, still open)
For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code; there is no `_auth_rate_limited` call on the endpoint. (Setup remains protected — prior M-3 fixed.)
**File refs:** `app/app.py` `api_totp_disable()` 1607–1626.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, still open)
Authenticated `POST /api/account/vault-kdf` bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only (cannot downgrade), not a ciphertext oracle.
**File refs:** `app/app.py` `api_account_vault_kdf()`; `app/db.py` `update_user_vault_kdf_version()`.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)
`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits HSTS; a one-time startup warning is logged. **Status: owner-accepted as warning-only; status noted, not re-opened.**
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()`; `app/app.py` `SESSION_COOKIE_SECURE`; `app/auth.py` `security_headers()`.

#### L-5 — Account enumeration on auth endpoints (carry-over, still open; product decision)
`/api/auth/srp/register` returns `409` for existing emails; SRP challenge vs WebAuthn login options remain distinguishable (`401` vs `404 no passkeys registered`). All are rate-limited.
**File refs:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open)
Limits reset on restart; production gunicorn is `--workers 1` so workers do not split buckets today. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP) — not `/api/account/*`, `/api/backup/*`, or `/api/totp/*`. The unbounded `_hits`/`_GEO_CACHE` dicts grow with distinct keys.
**File refs:** `app/auth_rate_limit.py`; `app/auth.py` `_GEO_CACHE`; `deploy/setup-cloudflare-rate-limits.sh`.

#### L-7 — Broad session cookie domain (carry-over, still open)
Default registrable-domain scope (`.deeperguard.com`) shares sessions with sibling subdomains; `request_is_same_origin()` still rejects bare `same-site` (Origin/Referer must match the notes host), and HttpOnly blocks JS reads.
**File refs:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py`; `app/auth.py` `request_is_same_origin()` 464–467.

#### L-8 — Predictable default IndexNow key (carry-over, still open)
Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY`.

#### L-9 — CSP residual hardening (carry-over, still open)
`style-src 'unsafe-inline'`; no `report-to`/`report-uri`; `script-src` remains nonce-based with `'wasm-unsafe-eval'` (needed for Argon2 / OCR wasm). The leftover inline `onclick` on `app.html` noted on 10-15 is **gone** (positive). Markdown link `href` interpolation is a new residual — see **L-15**.
**File refs:** `app/auth.py` `content_security_policy()`.

#### L-10 — Authenticated `/api/backup/email` has no per-endpoint rate limit for the backup attachment (carry-over, still open)
A hijacked session that has already verified a recipient can still direct the encrypted backup attachment at that address via the configured SMTP relay. Outbound-mail abuse, not a vault leak. Email verification now blocks the *unverified* case (and then sends an OTP — see **M-3**).
**File refs:** `app/app.py` `api_backup_email()`; `app/backup_mail.py`.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (carry-over from 10-15, still open)
All three units omit `User=`/`Group=` and sandboxing directives, so gunicorn runs as root (binding `127.0.0.1:80` encourages this). The optional LAN-TLS unit still binds `0.0.0.0:443` as root (installer refuses it when the CIDR gate is open).
**File refs:** `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service`.
**Remediation outline:** dedicated user + `AmbientCapabilities=CAP_NET_BIND_SERVICE` (or socket activation) and standard `ProtectSystem=` / `PrivateTmp=` / `NoNewPrivileges=`. Deploy-only; no app code.

#### L-13 — 6-digit verification codes stored as unsalted SHA-256 (new)

| | |
|---|---|
| **New vs known** | **New** (email-verify module). |
| **Impact (one line)** | A copy of the `users` table (DB backup, leftover `data/*.db`) recovers any outstanding 30-minute code — the secret is 20 bits. Submitting the code still requires a session for that user; a writeable DB can also flip `email_verified` directly. Defense-in-depth for mailbox proof, not a remote vault break. |
| **File refs** | `app/email_verify.py` `_hash()` 18–19, `issue_code()` 40–48, `check_code()` 51–78 (`!=` compare, not `hmac.compare_digest`). |
| **Remediation outline** | Store `HMAC-SHA256(server_pepper, user_id\|purpose\|recipient\|code)` or a high-entropy token; compare with `hmac.compare_digest`. Do not reset the attempt counter on resend without a cooldown (already covered under M-3). |

#### L-14 — Backup resend has no “already verified” short-circuit (new)

Account resend returns early when verified (`app/app.py` `api_account_email_resend()` 2431–2432). `api_backup_email_resend()` 2453–2466 always sends if the (IP-scoped) rate limit allows. Authenticated nuisance mail to the configured backup address.
**Remediation outline:** if `recipient_verified(user, recipient)`, return `{ok: true}` without sending. Key the verify rate-limit on the recipient (resend already does) rather than the account email (`api_backup_email_verify()` 2445).

#### L-15 — Markdown link renderer interpolates `href` without attribute escaping (new)

| | |
|---|---|
| **New vs known** | **New** (markdown link support since `e25f213`). |
| **Impact (one line)** | Note markup of the form `[x](https://example.com" …)` can break out of the `href` attribute when preview sets `innerHTML`. Current CSP (`script-src` nonce-only, no `'unsafe-inline'`) blocks inline handlers; this is defense-in-depth. `escapeHtml()` does not encode `"`. |
| **File refs** | `app/static/js/markdown.js` 44–47; consumed via `ui.preview.innerHTML = NotesMarkdown.render(...)` in `app/static/js/app.js`. `NotesSanitize.escapeAttr()` already exists and encodes quotes. |
| **Remediation outline** | After the `https?://` / `mailto:` check, emit `href="${NotesSanitize.escapeAttr(raw)}"` (or reject `"`, `'`, `<`, `>`). Keep the scheme allowlist. |

#### L-16 — Login/register boot handoff now stashes derived vault-key bytes in `sessionStorage` (new; same family as I-5)

| | |
|---|---|
| **New vs known** | **New stash** (`notes_boot_kdf`). The pre-existing boot *password* stash (`notes_boot_password_enc` + `notes_boot_key`) is I-5; this adds AES-GCM ciphertext of the Argon2 output next to that same storage key so `/app` can `adoptDerivedVaultKey()` and skip a second derive. |
| **Impact (one line)** | Same-origin / same-profile read of `sessionStorage` during the login→`/app` hop yields decrypt-capable key bytes without re-doing Argon2. Cleared on consume/lock; session-scoped. Not a remote issue. |
| **File refs** | `app/static/js/vault-secrets.js` `stashBootDerivedKey()` 101–123, `consumeBootPassword()` 131–168; `app/static/js/auth-pages.js` 377–390; `app/static/js/store.js` `adoptDerivedVaultKey()` 474–484. |
| **Remediation outline** | Prefer an in-memory-only handoff (`pendingBootDerived` is already there). If the stash stays for UX, document it as accepted (same as I-5) and clear `BOOT_KDF` on every auth failure path. |

### Informational

1. **I-1 (carry-over):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without requiring email verification for login — abuse surface; signup-notify emails are awareness only. New accounts *do* get a verification mail, but it only gates backups (see M-3).
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts (rate-limited, refuses SRP accounts); `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1).
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over):** Vendored JS under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) without an automated CVE gate in CI.
5. **I-5 (carry-over):** "Remember on device" password stash stores the AES-GCM key next to the ciphertext in web storage — obfuscation against casual inspection only; inherent to the opt-in feature. Extended by L-16 for the boot derived key.
6. **I-6 (carry-over):** when the session cookie names **no** account at all, `session_requires_wipe()` still falls back to the newest session for the client-supplied `X-Device-Id` across accounts. Availability nuisance; local cache is per-account ciphertext.
7. **I-7 (carry-over):** Deploy pipeline pushes as root over SSH with `StrictHostKeyChecking=accept-new` (TOFU) to the pinned production IP; tarball excludes `keys/` and `data/`; gunicorn stays on `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open.
8. **I-8 (new, residual of #78 / shell cache):** service worker still caches session-scoped `/app` HTML (`networkFirstNavigate` + `putBoth`). Offline, a prior login’s `data-csrf` can be replayed from cache on the same profile. `/api/*` is not intercepted; API responses stay `no-store`. Optional hardening: cache a static offline stub, or strip session attributes before `putBoth`.

Contact-form header injection was re-checked and is **not** an issue: visitor name/subject flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values (the endpoint’s catch-all returns 503). Verification subjects are static strings; the recipient is `EMAIL_RE`-validated before send from settings.

---

## Status of previously known open items (requested checklist)

| Item | Status on `60eeb3a` |
|------|---------------------|
| SRP `A ≡ 0 (mod N)` bypass | **Still fixed** |
| SRP challenge state server-side (C-1, #66) | **Still fixed** |
| Login SRP verifier binding (L-11, #68) | **Still fixed** |
| TOTP setup overwrite (M-3 of 10-13, #68) | **Still fixed** |
| M2 required on client | **Still in place** (`srp-auth.js` 245–250) |
| Ephemeral OCR store | **Still in place** |
| rclone obscure via stdin | **Still in place** (`backup_pcloud.py` 133–136) |
| Two-phase ZK password change (#63) | **Still in place** |
| Upload dirs keyed by `user_id` | **Still in place** |
| Auth rate limits | **Still in place** on unauthenticated auth endpoints |
| Signup notify | **Still in place** (`admin_notify.notify_new_user_signup`) |
| pCloud plaintext passwords | **Still open** (M-1) — recorded product decision |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted |
| systemd unit hardening (L-12) | **Still open** |

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** all item/blob/reminder/session/OCR-job/upload queries scoped by authenticated `user_id`; device-session tokens stored as SHA-256 hashes; `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session and pass the same-origin gate for POSTs.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match against the canonical www/apex set; bare `same-site` rejected; `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare). New email-verify routes are not exempt.
- **Headers/CSP:** nonce-based `script-src`, `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; HSTS when Secure cookies are on; `/api/*` is `no-store`; cookie-stripping shell-cache paths never carry per-user vault data. `/app` cache is now `must-revalidate`.
- **AI relay:** `app/ai_relay.py` — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged; no SSRF surface (unchanged).
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`; this window only added legal-page nav helpers (`_site_nav`).
- **Vault crypto:** Argon2id v2 params aligned between `app/vault_crypto.py`, `app/static/js/crypto.js`, and `crypto-worker.js` (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV).
- **Health:** `/api/health` still returns only `ok` / `service` / `build` for anonymous callers; extra fields remain admin-session-only.
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1` defaults; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`.

---

## Recommended next steps (priority)

1. **M-3 (code fix):** per-`user_id` rate limit + send cooldown on `/api/backup/settings` and the unverified `/api/backup/email` branch; do not re-issue a live code on every settings save. Consider requiring account-email verify before backup-OTP mail.
2. **L-13 / L-14 / L-15 (code fix):** peppered (or high-entropy) OTPs; short-circuit verified backup resend; attribute-escape markdown `href`.
3. **L-2 / L-10 / L-16:** TOTP-disable step-up + rate limit; rate-limit verified backup-attachment sends; drop or document the boot derived-key stash.
4. **L-1 / L-3 / L-12:** clear leftover Argon2 hashes on SRP upgrade; bind the vault-KDF bump; systemd `User=` + sandboxing (deploy-only).
5. **M-1 / L-4:** product decisions unchanged (pCloud password storage; WAN warning-only) — no action unless the owner's call changes.

*End of report.*
