# DeeperGuard Security Review — 2026-10-15

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `e25f213` (includes #68 TOTP-setup step-up + login SRP verifier binding, #70–#76 notes/UI fixes, crypto-worker salt/key fixes and network-first worker fetch, #77 sync push/conflict rework, #78 per-account IndexedDB + scoped wipe check).
**Reviewer:** Cursor Cloud Agent — static code review plus local test runs (`tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`: 17/17 pass; `tests/test_app.py` auth/session/CSRF/origin/admin/quota/unlock/wipe/password subset: 50/50 pass; `tests/test_uploads.py`, `test_sync_push_partial.py`, `test_sync_cursor.py`: pass. Remaining `test_app.py` failures in this sandbox are environmental — missing `pdftoppm`/`rclone` binaries and un-fetched vendor wasm assets — not security regressions). No production access, no live penetration testing.
**Scope:** Auth (SRP, sessions, WebAuthn, TOTP/2FA, password change/recovery), vault/crypto (server and client), sync/API authorization, CSP/security headers, rate limits, deploy defaults, OCR/pCloud misconfiguration risks.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-13 review (`docs/SECURITY-REVIEW-2026-10-13.md`, draft-PR branch only — prior reports are not on `main`) reviewed `main` at `f345793`. Everything that landed after it (#68 and #70–#78, ~5,000 added lines, mostly client sync/store) is new surface covered here.

---

## Executive summary

**No new Critical or High findings. No new actionable Medium code issues.** The two fixes recommended on 2026-10-13 both landed in [PR #68](https://github.com/deeperguard/Deeperguard/pull/68) and verify as sound on current `main` (prior **M-3** TOTP-setup overwrite and **L-11** login-challenge verifier binding — both **fixed**). The large sync/client rework (#77/#78) introduces no server-side authorization regressions: every item, blob, conflict, reminder, session, and OCR-job query remains scoped by the authenticated `user_id`, and the new conflict path (`db._conflict_server_item`) only ever returns the caller's own row. Local persistence on the client remains ciphertext-only (verified in `store.js` `persistLocal()` / `persistCipherRowFromServer()` — plaintext `content` is never written to IndexedDB).

The remaining Mediums are the two known carry-overs: pCloud plaintext WebDAV passwords (open product decision) and server-side OCR when explicitly enabled (defaults safe). One **new Low** is recorded (systemd unit hardening); everything else is carried-over Lows whose status is re-verified below.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 2 (both carry-over, status-only) |
| Low | 11 (10 carry-over, 1 new) |
| Informational | 7 |

### Top findings (current)

1. **M-1 (Medium, carry-over — product decision):** pCloud WebDAV passwords still stored in plaintext under `keys/` (owner decision previously recorded as accepted-for-now).
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place.
3. **L-12 (Low, new):** systemd units run gunicorn without `User=` or sandboxing directives (root by default; the optional LAN-TLS unit binds `0.0.0.0:443`).

---

## Fixes verified since the 2026-10-13 review (`f345793` → `e25f213`)

| Prior ID | Topic | Status on `e25f213` |
|----------|-------|---------------------|
| **M-3** (10-13) | `/api/totp/setup` overwrote an enabled TOTP secret without step-up | **Fixed** (#68). `api_totp_setup()` now requires a valid current code (`403` without one, `400` on a wrong one) before rotating the secret when `totp_enabled` is set. |
| **L-11** (10-13) | Login SRP consume did not re-bind the current stored verifier | **Fixed** (#68). `auth.pop_srp_state()` now passes the account's current `srp_salt`/`srp_verifier` into `db.consume_srp_challenge()`, which refuses the row on mismatch — a login challenge issued before a password change can no longer complete against the old verifier. Covered by `tests/test_srp_server_challenge.py` (passes locally). |
| **Info-7** (10-13) | `crypto-worker.js` `fromB64` wrote `charCodeAt(0)` into every index (worker decrypt broken) | **Fixed.** The worker now decodes correctly (`charCodeAt(i)`), derives the key from the real salt, and the service worker fetches `crypto-worker.js` network-first with an activate-time purge of stale cached copies (`sw.js` `networkFirstCryptoWorker()` / `purgeCachedCryptoWorker()`) — a positive change: key-derivation code can no longer be pinned stale by `?v=` caching. |

---

## New surface reviewed (#70–#78) — no new High/Medium

- **Sync push rework (#77):** the new `base_rev` / `conflict` / `stale` / `partial` logic in `app/db.py` (`_plan_sync_item`, `upsert_items_batch`, `_conflict_server_item`) operates entirely on rows selected `WHERE user_id = ?` with the authenticated id; conflict responses return only the caller's own server row (ciphertext only, blob via the same user-scoped `/api/sync/blobs`). Quota accounting (including the kept-blob metadata-only case) cannot be bypassed by the new statuses. Client clock skew is clamped (`SYNC_MAX_CLOCK_SKEW_SEC`); per-item size is capped (`SYNC_MAX_ITEM_BYTES`); page size is capped at 50 items / `NOTES_SYNC_PAGE_BYTES`.
- **Per-account IndexedDB (#78):** `app/static/js/idb.js` now keys the local database per signed-in account (legacy DB stays with the first owner, recorded in `localStorage` `notes_idb_owner`); `auth-pages.js` assigns ownership before switching accounts. This prevents one account's sign-in from reading another's locally cached rows on a shared browser. Note this is correctness isolation, not a cryptographic boundary — IndexedDB is origin-scoped — but all persisted rows are **ciphertext only** (verified: `store.js` `persistLocal()` encrypts via `wrapItem()` before `NotesIDB.putItem()`; `persistCipherRowFromServer()` stores server ciphertext as-is; no code path writes decrypted `content` to IndexedDB).
- **Scoped wipe check (#78):** `auth.session_requires_wipe()` now scopes the device-id fallback to the account named in the (possibly expired) cookie, so account B's remote sign-out no longer wipes account A's local vault when A's cookie still names A. Residual noted as **I-6** below.
- **Service worker:** still never intercepts `/api/*`; the only new fetch behavior is the network-first crypto worker (see above). API responses keep `Cache-Control: no-store`.
- **Search (`search.js`):** index is in-memory only; no plaintext search index is persisted (no `localStorage`/IndexedDB use in the module).

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
| **Status** | **Still open — recorded owner decision (Dennis), accepted-for-now.** The #64 `rclone obscure` stdin fix remains in place; the OAuth-token path (`pcloud_token`) exists and is preferred when present. Not re-opened as actionable. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged. |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `log_server_ocr_startup_warning()`. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral `/api/ocr/store` still refuses to persist raw bytes (`ocr_index.save_file_only()` returns `{stored: false}`); `purge_legacy_plaintext_indexes()` runs when ephemeral; OCR jobs remain user-scoped with per-user queue caps (`ocr_jobs.get_job()`, `_MAX_JOBS_PER_USER`). |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)
`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The #63 SRP password-change commit path does clear it.
**File refs:** `app/app.py` `api_auth_srp_upgrade()`; `app/db.py` `upgrade_user_to_srp()`; `deploy/set-account-password.py`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts and no per-endpoint rate limit (carry-over, still open)
For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code; there is no `_auth_rate_limited` call on the endpoint. (Setup is now protected — prior M-3 fixed.)
**File refs:** `app/app.py` `api_totp_disable()`.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, still open)
Authenticated `POST /api/account/vault-kdf` bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only (cannot downgrade), not a ciphertext oracle.
**File refs:** `app/app.py` `api_account_vault_kdf()`; `app/db.py` `update_user_vault_kdf_version()`.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)
`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits HSTS; a one-time startup warning is logged and `deploy/deeperguard.env.example` documents the pairing. **Status: owner-accepted as warning-only; status noted, not re-opened.**
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()`; `app/app.py` `SESSION_COOKIE_SECURE`; `app/auth.py` `security_headers()`.

#### L-5 — Account enumeration on auth endpoints (carry-over, still open; product decision)
`/api/auth/srp/register` returns `409` for existing emails; SRP challenge vs WebAuthn login options remain distinguishable (`401` vs `404 no passkeys registered`). All are rate-limited.
**File refs:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open)
Limits reset on restart; production gunicorn is `--workers 1` so workers do not split buckets today. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP) — not `/api/account/password/*` or `/api/totp/*`. The unbounded `_hits`/`_GEO_CACHE` dicts grow with distinct keys (minor memory concern on WAN).
**File refs:** `app/auth_rate_limit.py`; `app/auth.py` `_GEO_CACHE`; `deploy/setup-cloudflare-rate-limits.sh`.

#### L-7 — Broad session cookie domain (carry-over, still open)
Default registrable-domain scope (`.deeperguard.com`) shares sessions with sibling subdomains; `request_is_same_origin()` rejects bare `same-site`, and HttpOnly blocks JS reads.
**File refs:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py`.

#### L-8 — Predictable default IndexNow key (carry-over, still open)
Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY`.

#### L-9 — CSP residual hardening (carry-over, still open)
`style-src 'unsafe-inline'`; no `report-to`/`report-uri`; at least one inline `onclick` remains (`app/templates/app.html` line ~511, blocked by the nonce-based `script-src` but it prevents tightening `script-src-attr`). `script-src` remains nonce-based with `'wasm-unsafe-eval'` (needed for Argon2/ OCR wasm).
**File refs:** `app/auth.py` `content_security_policy()`; `app/templates/app.html`.

#### L-10 — Authenticated `/api/backup/email` has no per-endpoint rate limit (carry-over, still open)
A hijacked session can direct the (encrypted) backup attachment to any address via the configured SMTP relay. Outbound-mail abuse, not a vault leak.
**File refs:** `app/app.py` `api_backup_email()`; `app/backup_mail.py`.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (new)
| | |
|---|---|
| **New vs known** | **New** (prior reviews covered the deploy pipeline and port binding, not unit hardening). |
| **Impact (one line)** | All three units omit `User=`/`Group=`, so gunicorn runs as root (binding `127.0.0.1:80` encourages this); a Flask/gunicorn RCE would be root RCE, and `keys/` (Flask secret, pCloud credentials) plus `data/` are directly writable. The optional LAN-TLS unit binds `0.0.0.0:443` as root (installer refuses it when the CIDR gate is open, which limits exposure). |
| **File refs** | `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service` (no `User=`, `NoNewPrivileges=`, `ProtectSystem=`, `ProtectHome=`, `PrivateTmp=`, or `CapabilityBoundingSet=`). |
| **Remediation outline** | Run as a dedicated user with `AmbientCapabilities=CAP_NET_BIND_SERVICE` (keeps the required `127.0.0.1:80` bind) or systemd socket activation; add standard sandboxing directives. **Deploy change, no code.** |

### Informational

1. **I-1 (carry-over):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without email verification — abuse surface; signup-notify emails are awareness only.
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts (rate-limited, refuses SRP accounts); `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1).
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over):** Vendored JS under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) without an automated CVE gate in CI.
5. **I-5 (carry-over):** "Remember on device" password stash stores the AES-GCM key next to the ciphertext in web storage — obfuscation against casual inspection only; inherent to the opt-in feature.
6. **I-6 (new, residual of #78):** when the session cookie names **no** account at all, `session_requires_wipe()` still falls back to the newest session for the client-supplied `X-Device-Id` across accounts (`db.get_latest_session_for_device(device_id, user_id=None)`), so on a shared browser one account's remote sign-out can tell another signed-out account's client to wipe its local (per-account, ciphertext-only) cache. Availability nuisance, not a confidentiality issue; the common case (cookie names an account) is correctly scoped.
7. **I-7 (carry-over):** Deploy pipeline pushes as root over SSH with `StrictHostKeyChecking=accept-new` (TOFU) to the pinned production IP; tarball excludes `keys/` and `data/`; gunicorn stays on `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open.

Contact-form header injection was checked and is **not** an issue: user-controlled subject/name flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values (the endpoint's catch-all returns 503).

---

## Status of previously known open items (requested checklist)

| Item | Status on `e25f213` |
|------|---------------------|
| SRP `A ≡ 0 (mod N)` bypass | **Still fixed** (`app/srp_auth.py` `step2()` rejects `A % N == 0`, malformed hex, `u == 0`; constant-time M1 compare). `tests/test_srp_auth.py` passes. |
| SRP challenge state server-side (C-1, #66) | **Still fixed** — `srp_challenges` table, single-use `DELETE … RETURNING`, 300 s TTL, purpose/user/email binding; cookie holds only a random id. `tests/test_srp_server_challenge.py` passes. |
| Login SRP verifier binding (L-11, #68) | **Fixed and verified** (see above). |
| TOTP setup overwrite (M-3, #68) | **Fixed and verified** (see above). |
| M2 required on client | **Still in place** (`auth-pages.js` login flow throws when `M2` is missing/wrong). |
| Ephemeral OCR store | **Still in place** (`ocr_index.save_file_only()` refuses raw bytes when ephemeral). |
| rclone obscure via stdin | **Still in place** (`backup_pcloud.py` `rclone obscure -`). |
| Two-phase ZK password change (#63) | **Still in place** (SRP step-up challenge → hashed, session-bound, 10-min rotation token → consume-on-commit; SRP commit clears leftover hash). |
| Upload dirs keyed by `user_id` | **Still in place** (`app/uploads.py`). |
| Auth rate limits | **Still in place** on every unauthenticated auth endpoint; WAN tightening applies when the CIDR gate is open. |
| Signup notify | **Still in place** (`admin_notify.notify_new_user_signup`). |
| pCloud plaintext passwords | **Still open** (M-1) — recorded product decision. |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted. |

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** all item/blob/reminder/session/OCR-job/upload queries in `app/db.py`, `app/ocr_jobs.py`, `app/ocr_index.py`, `app/uploads.py` scoped by authenticated `user_id`; device-session tokens stored as SHA-256 hashes; `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session and pass the same-origin gate for POSTs.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match against the canonical www/apex set; bare `same-site` rejected; `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare).
- **Headers/CSP:** nonce-based `script-src`, `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; HSTS when Secure cookies are on; `/api/*` is `no-store`; the cookie-stripping shell-cache paths never carry per-user data.
- **AI relay:** `app/ai_relay.py` — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged; no SSRF surface.
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`; self-demotion/self-deletion blocked; env-locked admins cannot be demoted; audit lines logged.
- **Vault crypto:** Argon2id v2 params aligned between `app/vault_crypto.py`, `app/static/js/crypto.js`, and `crypto-worker.js` (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV).
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1` defaults; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`.

---

## Recommended next steps (priority — none urgent)

1. **L-2 / L-10:** add a step-up and rate limit to TOTP disable; rate-limit (or recipient-pin) backup email.
2. **L-1 / L-3:** clear leftover Argon2 hashes on SRP upgrade; bind the vault-KDF bump to an unlock or SRP proof.
3. **L-12:** add `User=` + `AmbientCapabilities=CAP_NET_BIND_SERVICE` and sandboxing directives to the systemd units (deploy-only change).
4. **M-1 / L-4:** product decisions unchanged (pCloud password storage; WAN warning-only) — no action unless the owner's call changes.

*End of report.*
