# DeeperGuard Security Review — 2026-10-21

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `03f9d75` (Round 48 / #141). Includes everything after the 2026-10-20 review (`4abe83c`): UI/recovery rounds #117–#132 and client cloud-backup rounds #133–#141.
**Reviewer:** Cursor Cloud Agent — static review of current `main` plus local unit tests (`tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`, `tests/test_verification_send_limit.py`, `tests/test_uploads.py`, `tests/test_sync_push_partial.py`, `tests/test_sync_cursor.py`: 42/42 pass; `tests/test_app.py` auth/session/CSRF/SRP/TOTP/unlock/backup-verify/OCR-warning subset: 20/20 pass). No production access, no live penetration testing.
**Scope:** Auth (SRP, sessions, WebAuthn, TOTP/2FA, password change/recovery), vault/crypto (server and client), sync/API authorization, CSP/security headers, rate limits, deploy defaults, OCR/pCloud misconfiguration, and the new client-only Google Drive / Dropbox / iCloud backup surface (#133–#141).
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-20 review (`docs/SECURITY-REVIEW-2026-10-20.md`, draft-PR #116, branch only — prior reports are not on `main`) reviewed `main` at `4abe83c`. Everything that landed after it (#117–#141) is new surface covered here.

---

## Executive summary

**No new Critical or High findings. No new Medium that needs a code fix. No regressions of previously fixed items.** Carry-over Mediums are unchanged: pCloud WebDAV passwords on disk (still awaiting Dennis’s decision — **not** accepted) and server OCR when explicitly enabled (defaults remain safe). L-17 (session-cookie rebound via `X-Device-Id`) is unchanged.

The material delta since `4abe83c` is **client-only encrypted backups** to Google Drive (`drive.file` + GIS token client), Dropbox (OAuth 2 PKCE, App-folder intended), and the local filesystem / iCloud via Web Share. Tokens and provider calls stay in the browser; no new `/api/*` cloud-backup routes; env holds public client IDs / app keys only. Backup payloads are vault ciphertext (`.dgbackup`). Restore decrypts with the unlocked vault key and re-wraps through `persistLocal()` → `wrapItem()`.

Two **new Lows** come with that surface: Dropbox access + refresh tokens persist in plaintext `localStorage` (not cleared on vault lock), and CSP now allowlists Google GIS and Dropbox on every response even when the env keys are empty. Two hardenings also landed: backup-email verification uses `strict=True` (cooldown returns 429 instead of a silent “we sent a code”), and the admin self-host doc HTML-escapes markdown before rendering.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 2 (both carry-over) |
| Low | 14 (12 remaining carry-over, 2 new) |
| Informational | 10 (8 carry-over, 2 new) |

### Top findings (current)

1. **M-1 (Medium, carry-over — open product decision):** pCloud WebDAV passwords still stored in plaintext under `keys/`. **Not accepted.** Still awaiting Dennis’s decision.
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place.
3. **L-17 (Low, carry-over — code fix):** an authenticated request can adopt another live same-user session row by sending that row’s `X-Device-Id`, rotating the adopted row’s token.
4. **L-18 (Low, new — code fix):** Dropbox OAuth access + refresh tokens are stored in plaintext `localStorage`, scoped by email but not bound to vault lock.
5. **L-19 (Low, new — code fix):** CSP unconditionally allowlists `accounts.google.com` (script/frame/connect) and Dropbox API hosts on every response.

---

## What changed since the 2026-10-20 review (`4abe83c` → `03f9d75`)

Server-side security-relevant delta (small):

- **`app/auth.py` CSP:** `script-src` / `connect-src` / `frame-src` now include Google Identity Services and Dropbox API hosts. Not gated on `GOOGLE_OAUTH_CLIENT_ID` / `DROPBOX_APP_KEY`. `_align_session_with_request()` is byte-identical to `4abe83c`.
- **`app/config.py` / `deploy/deeperguard.env.example`:** public `GOOGLE_OAUTH_CLIENT_ID` and `DROPBOX_APP_KEY` (empty default; comments forbid secrets).
- **`app/app.py`:** those public keys are passed into `app.html` meta / `data-*` attributes. Backup-email unverified path now calls `send_*_code(..., strict=True)` and returns an explicit 429. **No new Drive/Dropbox API routes.**
- **`app/admin_api.py`:** `docs/SELF_HOST.md` is HTML-escaped then lightly markdown-rendered (`render_simple_markdown()`), instead of being passed through as raw body text.

`app/srp_auth.py`, `app/uploads.py`, `app/ocr_index.py`, `app/backup_pcloud.py`, `app/auth_rate_limit.py`, `app/vault_crypto.py`, `app/webauthn_helper.py`, and `deploy/systemd/` were **not** functionally changed in this window.

Client-side (security-relevant):

- **`app/static/js/cloud-backup.js`** (new module, ~926 lines): GIS token client (`drive.file`); Dropbox PKCE (S256, state, client-side token exchange, no app secret); iCloud via `navigator.share` of the encrypted `.dgbackup` blob; same-origin `postMessage` for the Dropbox popup; COOP-safe opener (never `popup.close()` / `popup.closed` — #141).
- **Per-user OAuth app IDs** live in encrypted vault global settings (`googleOauthClientId`, `dropboxAppKey`); `VAULT_ONLY_PREF_KEYS` keeps them out of device `localStorage` prefs.
- **`buildLocalBackup()`** uploads IDB ciphertext (or a fresh `encryptObject` with the unlocked `cryptoKey`). **`importBackup()`** `unwrapItem()`s with the current key, then `persistLocal()` → `wrapItem()`.
- Offline recovery / health-probe / empty-draft UI rounds do not change server authorization. `persistLocal()` still wraps before IndexedDB.

---

## Fixes verified since the 2026-10-20 review

No prior open High/Medium was closed in this window. The 10-20 closures (#96) still hold:

| Prior ID | Topic | Status on `03f9d75` |
|----------|-------|---------------------|
| **M-3** (10-19) | Backup verification mail unbounded | **Still fixed.** `strict=True` on the unverified backup-email path is additional hardening (`app/app.py` 1809–1824). |
| **L-10** (10-15/10-19) | Manual backup-attachment send uncapped | **Still fixed** for `POST /api/backup/email`. |
| **L-13** (10-19) | Unsalted SHA-256 verification codes | **Still fixed.** HMAC-SHA256 + `hmac.compare_digest` (`app/email_verify.py` 31, 84). |
| **L-14** (10-19) | Backup resend always sent | **Still fixed.** |
| **L-15** (10-19) | Markdown `href` unescaped | **Still fixed.** `escapeAttr()` (`app/static/js/markdown.js` 9–14, 116, 156, 203). |

---

## Fixes still holding (re-verified on `03f9d75`)

| Prior ID | Topic | Status on `03f9d75` |
|----------|-------|---------------------|
| SRP `A ≡ 0 (mod N)` | `app/srp_auth.py` `step2()` | **Still fixed** — rejects `A % N == 0`, malformed hex, `u == 0`; constant-time M1 compare. `tests/test_srp_auth.py` passes. |
| C-1 / #66 | SRP challenge state server-side | **Still fixed** — cookie holds only a random id; `srp_challenges` table, single-use consume, 300 s TTL. `tests/test_srp_server_challenge.py` passes. |
| L-11 / #68 | Login SRP consume re-binds current verifier | **Still fixed** — `auth.pop_srp_state()` passes current `srp_salt`/`srp_verifier` (608–625). |
| M-3 (10-13) / #68 | TOTP setup overwrite | **Still fixed** — `api_totp_setup()` requires a current code when TOTP is already enabled (`app/app.py` 1653–1657). |
| M2 required on client | `app/static/js/srp-auth.js` `login()` | **Still in place** — throws when `M2` is missing, then `step3` (245–250). |
| Two-phase ZK password change / #63 | `api_account/password/*` | **Still in place** — rotation token consume-on-commit; SRP commit clears leftover hash (1493–1536). |
| Ephemeral OCR store | `ocr_index.save_file_only()` | **Still in place** — refuses raw bytes when `NOTES_OCR_EPHEMERAL=1` (180–182). |
| rclone obscure via stdin | `backup_pcloud.write_rclone_config()` | **Still in place** — `rclone obscure -` with password on stdin (133–140). |
| Upload dirs keyed by `user_id` | `app/uploads.py` | **Still in place** (36–51). |
| Auth rate limits | unauthenticated auth endpoints | **Still in place**; WAN tightening when the CIDR gate is open. |
| Info-7 (10-13) | crypto-worker `fromB64` / salt | **Still fixed** — worker uses `charCodeAt(i)` and the real salt; params still Argon2id t=3, m=64 MiB, p=2, 32-byte key. |

---

## New surface reviewed (#117–#141) — High/Medium

- **No new High or Medium.** Drive/Dropbox/iCloud backups do not send vault keys, plaintext notes, or OAuth secrets to the DeeperGuard server. There is no new server-side IDOR surface for those providers.
- **Sync / IDOR:** no new item/blob/reminder/session/OCR-job endpoints. Existing queries remain `WHERE user_id = ?` with the authenticated id. Cloud restore merges into the **logged-in user’s** local vault and `pushDirty()`.
- **OAuth design (correct):** Dropbox PKCE S256 + state; token exchange in the browser with `client_id` only; Google GIS implicit/token client, `drive.file` only, access token in module memory (not `localStorage`); `postMessage` origin-checked (`event.origin === window.location.origin`); COOP-safe popup handling; per-user app IDs encrypted in vault settings.
- **Unlock / KDF / IndexedDB:** `persistLocal()` still `wrapItem()`s before `NotesIDB.putItem()` (`store.js` 1272–1310). `buildLocalBackup()` prefers stored ciphertext (`app.js` 19910–19960). Empty-vault unlock still requires SRP (or legacy password).
- **Service worker:** `isApi()` still short-circuits `/api/*` (`app/static/sw.js` 107–108).
- **Admin markdown:** escape-then-render; not a stored-XSS path (operator-controlled `docs/SELF_HOST.md`).

Residual issues on this surface are **L-18** and **L-19** (below). Dropbox tokens in `localStorage` are **not** raised to Medium: backups remain vault-encrypted, tokens are per-device (not a server-wide store like M-1), and same-origin XSS on an unlocked vault already has the notes.

---

## Findings

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext under `keys/` (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | Known (every review since 2026-10-08); **unchanged.** |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud *account* passwords (not vault passwords). |
| **File refs** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`); `app/backup_pcloud.py` `write_rclone_config()` (reversibly-obscured `pass=` in `keys/pcloud-rclone-{user_id}.conf`, mode `0600`). OAuth-token files (`write_pcloud_token()`, 325–329) are also plaintext on disk. |
| **Status** | **Still open — awaiting Dennis’s decision. Not accepted.** The #64 `rclone obscure` stdin fix remains in place; the OAuth-token path (`pcloud_token`) exists and is preferred when present. |
| **Needs a code fix?** | Yes, once the owner decides (store an OAuth token only, or encrypt the password at rest with the Flask secret / a server key). **Product decision**, then code. No code in this review. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged architecture. |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `server_ocr_enabled()` 100–102, `ocr_ephemeral()` 95–97, `log_server_ocr_startup_warning()` 108–133. Default client path (`app/static/js/ocr.js` 86–88) does not upload document bytes. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral `/api/ocr/store` still refuses to persist raw bytes (`ocr_index.save_file_only()` 180–182). |
| **Needs a code fix?** | No, unless server OCR is turned on. Keep the default off. **Product / ops decision.** |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)
`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The #63 SRP password-change commit path does clear it.
**File refs:** `app/app.py` `api_auth_srp_upgrade()` 1104–1126; `app/db.py` `upgrade_user_to_srp()`; `deploy/set-account-password.py`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts and no per-endpoint rate limit (carry-over, still open)
For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code; there is no `_auth_rate_limited` call on the endpoint. (Setup remains protected — prior M-3 of 10-13 fixed.)
**Still noted:** `POST /api/auth/webauthn/remove` is the same family — session + CSRF only, no password/TOTP/SRP step-up.
**File refs:** `app/app.py` `api_totp_disable()` 1687–1706.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, still open)
Authenticated `POST /api/account/vault-kdf` bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only (cannot downgrade), not a ciphertext oracle.
**File refs:** `app/app.py` `api_account_vault_kdf()` 1549–1563; `app/db.py` `update_user_vault_kdf_version()`.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)
`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits HSTS; a one-time startup warning is logged. **Status: owner-accepted as warning-only; status noted, not re-opened.**
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()` 143–158; `app/app.py` `SESSION_COOKIE_SECURE` 74; `app/auth.py` `security_headers()` 752–766.

#### L-5 — Account enumeration on auth endpoints (carry-over, still open; product decision)
`/api/auth/srp/register` returns `409` for existing emails; SRP challenge vs WebAuthn login options remain distinguishable (`401` vs `404 no passkeys registered`). All are rate-limited.
**File refs:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open; partially improved)
Limits reset on restart; production gunicorn is `--workers 1` so workers do not split buckets today. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP) — not `/api/account/*`, `/api/backup/*`, or `/api/totp/*`. The unbounded `_hits`/`_GEO_CACHE` dicts grow with distinct keys.
**Still improved by #96:** verification and backup-attachment sends use a SQLite log.
**File refs:** `app/auth_rate_limit.py`; `app/auth.py` `_GEO_CACHE`; `app/verification_send_limit.py`; `deploy/setup-cloudflare-rate-limits.sh`.

#### L-7 — Broad session cookie domain (carry-over, still open)
Default registrable-domain scope (`.deeperguard.com`) shares sessions with sibling subdomains; `request_is_same_origin()` still rejects bare `same-site` (Origin/Referer must match the notes host), and HttpOnly blocks JS reads.
**File refs:** `app/config.py` `session_cookie_domain()` 391–401; `DynamicDomainSessionInterface` in `app/app.py`; `app/auth.py` `request_is_same_origin()` 473–521.

#### L-8 — Predictable default IndexNow key (carry-over, still open)
Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY` 75.

#### L-9 — CSP residual hardening (carry-over, still open; **widened**)
`style-src 'unsafe-inline'`; no `report-to`/`report-uri`; `script-src` remains nonce-based with `'wasm-unsafe-eval'` (needed for Argon2 / OCR wasm). Markdown `href` interpolation is **fixed** (was L-15). **Changed this window:** Google GIS and Dropbox hosts are now in `script-src` / `connect-src` / `frame-src` on every response (see **L-19**).
**File refs:** `app/auth.py` `content_security_policy()` 721–749.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (carry-over, still open)
All three units omit `User=`/`Group=` and sandboxing directives, so gunicorn runs as root (binding `127.0.0.1:80` encourages this). The optional LAN-TLS unit still binds `0.0.0.0:443` as root (installer refuses it when the CIDR gate is open).
**File refs:** `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service`.
**Remediation outline:** dedicated user + `AmbientCapabilities=CAP_NET_BIND_SERVICE` (or socket activation) and standard `ProtectSystem=` / `PrivateTmp=` / `NoNewPrivileges=`. Deploy-only; no app code.

#### L-16 — Login/register boot handoff stashes derived vault-key bytes in `sessionStorage` (carry-over, still open)
`notes_boot_kdf` still holds AES-GCM ciphertext of the Argon2 output next to the boot storage key so `/app` can `adoptDerivedVaultKey()` and skip a second derive. Cleared on consume/lock; session-scoped. Same family as I-5. Not a remote issue.
**File refs:** `app/static/js/vault-secrets.js` `stashBootDerivedKey()` 101–123, `consumeBootPassword()` 131–168; `app/static/js/store.js` `adoptDerivedVaultKey()` 512–522.

#### L-17 — Session cookie can adopt another live same-user row via `X-Device-Id` (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over** (introduced in #112 / `766ebfd`; recorded as new on 10-20). **Unchanged** on `03f9d75` — the `app/auth.py` diff in this window is CSP only. |
| **Impact (one line)** | An already-authenticated request that names another live device id for the same account rotates that row’s token into this cookie, so the other browser’s cookie stops matching. Same-user only; device ids are high-entropy and are not returned by `GET /api/sessions`. Authenticated callers can already revoke sessions explicitly. |
| **File refs** | `app/auth.py` `_align_session_with_request()` 175–200, `ensure_device_session()` 222–236; `app/db.py` `get_active_session_for_device()` 774–786, `rotate_session_token()` 789–803. Covered by `tests/test_app.py` `test_this_device_is_the_request_session`. |
| **Remediation outline** | Rebound only when the cookie row’s stored `device_id` is empty or already equals the request’s device id. Do not rotate a *different* live row from a client-supplied header alone. |
| **Needs a code fix?** | Yes. |

#### L-18 — Dropbox OAuth tokens persist in plaintext `localStorage` and are not cleared on vault lock (new)

| | |
|---|---|
| **New vs known** | **New** (Rounds 42–48 / #135–#141). |
| **Impact (one line)** | A Dropbox access token and long-lived refresh token for the App-folder (or whatever app type the user registered) remain readable from `localStorage` after the vault is locked, and after the tab is closed; same-origin script or a copied browser profile can reuse them to read or overwrite encrypted `.dgbackup` files. Note plaintext is not exposed — backups stay vault-encrypted. Google Drive access tokens stay in JS memory only, but `NotesStore.lock()` also does not zero them. |
| **File refs** | `app/static/js/cloud-backup.js` `rememberDropboxTokens()` 512–523, `loadCachedDropboxToken()` 558–564, `writePrefs()` 76–81; `disconnectDropbox()` / `clearDropboxTokensLocal()` 526–537 exist but are not called from `store.js` `lock()` 816–857. |
| **Remediation outline** | Keep refresh tokens out of `localStorage` (sessionStorage or vault-encrypted blob). Clear Dropbox and Google module tokens from `NotesStore.lock()` / sign-out. Prefer the Google pattern (memory-only access token; re-prompt after unlock) for Dropbox as well. |
| **Needs a code fix?** | Yes. |

#### L-19 — CSP unconditionally allowlists Google GIS and Dropbox on every response (new)

| | |
|---|---|
| **New vs known** | **New** (`app/auth.py` CSP expansion in this window). Related to carry-over L-9. |
| **Impact (one line)** | Every response, including marketing and login, may load scripts from `https://accounts.google.com` and connect to Google / Dropbox API hosts even when `GOOGLE_OAUTH_CLIENT_ID` and `DROPBOX_APP_KEY` are empty and the page never uses cloud backup. Widens the third-party script/connect/frame surface if those origins are compromised. |
| **File refs** | `app/auth.py` `content_security_policy()` 721–749 (always concatenates `google_script` / `google_connect` / `google_frame` / `dropbox_connect`); applied globally via `app/app.py` `_headers` 399–402. GIS is loaded on demand with the page nonce (`cloud-backup.js` `loadGis()` 250–271), but the host source does not require a nonce. |
| **Remediation outline** | Emit the Google / Dropbox CSP tokens only when the corresponding env key is non-empty, and only on `/app` (or another authenticated notes document). Leave marketing/login on the previous `'self'` connect/script policy. |
| **Needs a code fix?** | Yes. |

### Informational

1. **I-1 (carry-over):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without requiring email verification for login — abuse surface; signup-notify emails are awareness only. Verification still gates backups (rate-limited; see #96).
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts (rate-limited, refuses SRP accounts); `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1).
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over):** Vendored JS under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) without an automated CVE gate in CI.
5. **I-5 (carry-over):** "Remember on device" password stash stores the AES-GCM key next to the ciphertext in web storage — obfuscation against casual inspection only; inherent to the opt-in feature. Extended by L-16 for the boot derived key.
6. **I-6 (carry-over):** when the session cookie names **no** account at all, `session_requires_wipe()` still falls back to the newest session for the client-supplied `X-Device-Id` across accounts. Availability nuisance; local cache is per-account ciphertext.
7. **I-7 (carry-over):** Deploy pipeline pushes as root over SSH with `StrictHostKeyChecking=accept-new` (TOFU) to the pinned production IP; tarball excludes `keys/` and `data/`; gunicorn stays on `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open.
8. **I-8 (carry-over):** service worker still caches session-scoped `/app` HTML (`networkFirstNavigate` + `putBoth`). Offline, a prior login’s `data-csrf` can be replayed from cache on the same profile. `/api/*` is not intercepted; API responses stay `no-store`.
9. **I-9 (new):** Deployment `GOOGLE_OAUTH_CLIENT_ID` / `DROPBOX_APP_KEY` are public identifiers rendered into `/app` meta tags (`app/templates/app.html` 13–14, 654; `app/app.py` 2460–2469). Expected for public OAuth clients; tenants sharing one origin see the same server default keys. Comments correctly forbid client secrets.
10. **I-10 (new):** The Dropbox popup forwards `window.location.search` (authorization `code` + `state`) via same-origin `postMessage` (`cloud-backup.js` 14–17, 631–635), then strips the URL (`700–706`). Origin-checked; short-lived. Hygiene: pass parsed `code` only after the popup validates state.

Contact-form header injection was re-checked and is **not** an issue: visitor name/subject flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values.

Positive in this window (not findings): Drive/Dropbox backups are client-encrypted ciphertext only; no OAuth secrets on the server; Dropbox PKCE + state; Google `drive.file`; `postMessage` origin checks; COOP-safe popups; per-user app IDs in the vault; backup-email cooldown is now strict 429; admin self-host markdown is escaped.

---

## Status of previously known open items (requested checklist)

| Item | Status on `03f9d75` |
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
| Auth rate limits | **Still in place** on unauthenticated auth endpoints; verification/backup mail still SQLite-capped |
| Signup notify | **Still in place** (`admin_notify.notify_new_user_signup`) |
| Unbounded backup-verification mail (M-3 of 10-19) | **Still closed** (#96); unverified path now `strict=True` |
| Unsalted OTP hashes / backup resend / markdown href (L-13–L-15) | **Still closed** (#96) |
| Manual backup-attachment cap (L-10) | **Still closed** (#96) for the user API |
| pCloud plaintext passwords | **Still open** (M-1) — awaiting Dennis; **not** accepted |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted |
| systemd unit hardening (L-12) | **Still open** |
| Session rebound via `X-Device-Id` (L-17) | **Still open** — unchanged |

---

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** all item/blob/reminder/session/OCR-job/upload queries scoped by authenticated `user_id`; device-session tokens stored as SHA-256 hashes; `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session (unlock still requires SRP/legacy proof) and pass the same-origin gate for POSTs. No new cloud-backup server endpoints.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match against the canonical www/apex set; bare `same-site` rejected; `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare). Unlock/challenge is not CSRF-exempt.
- **Headers:** nonce-based `script-src` (plus the new third-party hosts — L-19), `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; HSTS when Secure cookies are on; `/api/*` is `no-store`. No COOP/COEP response headers (OAuth COOP is handled in JS only).
- **AI relay:** `app/ai_relay.py` — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged; no SSRF surface (unchanged).
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`. Self-host doc now escaped.
- **Vault crypto:** Argon2id v2 params aligned between `app/vault_crypto.py`, `app/static/js/crypto.js`, and `crypto-worker.js` (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV).
- **Health:** `/api/health` still returns only `ok` / `service` / `build` for anonymous callers; extra fields remain admin-session-only.
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1` defaults; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`. Gunicorn stays on `127.0.0.1:80`; `NOTES_ENABLE_LAN_TLS` defaults off. New OAuth env keys default empty.
- **WebAuthn / recovery / password change:** no regressions vs 10-20. Vault recovery still requires session + CSRF + SRP proof against the stored verifier before verifier update.

---

## Recommended next steps (priority)

1. **M-1:** owner decision on pCloud password storage (OAuth-token only, or encrypt at rest). Not accepted as-is.
2. **L-17 (code fix):** rebound the cookie only when the cookie row already names this device (or has no device id yet).
3. **L-18 (code fix):** stop persisting Dropbox refresh tokens in plaintext `localStorage`; clear cloud tokens on vault lock.
4. **L-19 (code fix):** gate Google/Dropbox CSP hosts on configured keys and `/app` only.
5. **L-2 / L-16:** TOTP-disable (and passkey-remove) step-up + rate limit; drop or document the boot derived-key stash.
6. **L-1 / L-3 / L-12:** clear leftover Argon2 hashes on SRP upgrade; bind the vault-KDF bump; systemd `User=` + sandboxing (deploy-only).
7. **L-4 / M-2:** product/ops decisions unchanged (WAN warning-only; keep server OCR off).

*End of report.*
