# DeeperGuard Security Review — 2026-10-22

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `9c70d94` (Round 53 / #149). Includes everything after the 2026-10-21 review (`03f9d75`): Round 49 security hardening (#143) through Round 53 unlock/lock UX (#149), plus the AGPL-3.0 LICENSE (#148).
**Reviewer:** Cursor Cloud Agent — static review of current `main` plus local unit tests (`tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`, `tests/test_verification_send_limit.py`, `tests/test_uploads.py`, `tests/test_sync_push_partial.py`, `tests/test_sync_cursor.py`, `tests/test_round49_security.py`, `tests/test_round50_auto_unlock.py`: 55/56 pass; the one failure is `test_m5_anti_enumeration` expecting WebAuthn 200/400 and seeing 501 in this environment — not an application regression). No production access, no live penetration testing.
**Scope:** Auth (SRP, sessions, WebAuthn, TOTP/2FA, password change/recovery), vault/crypto (server and client), sync/API authorization, CSP/security headers, rate limits, deploy defaults, OCR/pCloud misconfiguration, and the client-only Google Drive / Dropbox / iCloud backup surface.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-21 review (`docs/SECURITY-REVIEW-2026-10-21.md`, draft-PR #142, branch only — prior reports are not on `main`) reviewed `main` at `03f9d75`. Everything that landed after it (#143–#149) is new surface covered here.

---

## Executive summary

**No Critical or High findings.** Round 49 (#143) is a real hardening pass: SRP Argon2id v2, host-only `__Host-session` cookies, narrowed post-login `/api/auth/*`, session revoke on credential changes, signup/verify caps, TOTP step reuse, generic client errors, verified-email gate for `NOTES_ADMIN_EMAILS`, configured WebAuthn origin, `security.txt`, COOP/CORP, pdf.js/jsPDF bumps, and attribute escaping. Rounds 50–53 fix unlock/KDF UX without weakening zero-knowledge (SRP KDF upgrades no longer bump `password_changed_at`; vault KDF is persisted only after decrypt proof; silent defer does not relock a proven vault).

**One new Medium that needs a code fix:** `POST /api/auth/srp/kdf-upgrade` (new in #143) installs a client-supplied v2 verifier from a fully authenticated session + CSRF with **no current-password / SRP proof**, bypassing the two-phase ZK password-change control for remaining v1 accounts. Vault ciphertext stays unreadable without the original password; the harm is persistent login-credential replacement and lockout.

Carry-over Mediums are unchanged: pCloud WebDAV passwords on disk (still awaiting Dennis’s decision — **not** accepted) and server OCR when explicitly enabled (defaults remain safe). **L-17, L-18, and L-19 are still open** (session-cookie rebound; Dropbox tokens in `localStorage`; unconditional Google/Dropbox CSP). **L-7 is fixed** (host-only cookies).

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 3 (2 carry-over, 1 new) |
| Low | 14 (13 remaining carry-over after L-7 closed, 1 new) |
| Informational | 10 (updates only; no new Info IDs) |

### Top findings (current)

1. **M-1 (Medium, carry-over — open product decision):** pCloud WebDAV passwords still stored in plaintext under `keys/`. **Not accepted.** Still awaiting Dennis’s decision.
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place.
3. **M-3 (Medium, new — code fix):** authenticated `POST /api/auth/srp/kdf-upgrade` replaces the stored SRP verifier without proving the current password. v1 accounts only; upgrade-only; does not decrypt the vault.
4. **L-17 (Low, carry-over — code fix):** an authenticated request can adopt another live same-user session row by sending that row’s `X-Device-Id`, rotating the adopted row’s token.
5. **L-18 (Low, carry-over — code fix):** Dropbox OAuth access + refresh tokens are stored in plaintext `localStorage`, scoped by email but not bound to vault lock.
6. **L-19 (Low, carry-over — code fix):** CSP unconditionally allowlists `accounts.google.com` (script/frame/connect) and Dropbox API hosts on every response.

---

## What changed since the 2026-10-21 review (`03f9d75` → `9c70d94`)

### Round 49 — security hardening (#143) — material

- **SRP Argon2id v2:** `app/srp_auth.py` derives `x` with Argon2id + HKDF-SHA256 (`srp-auth` + identity); new signups require v2; v1 still accepted and upgraded after login. Login Argon2 params are lighter than the vault KDF (t=2, 19 MiB, p=1 vs vault t=3, 64 MiB, p=2) — intentional for interactive login.
- **Sessions:** `HostOnlySessionInterface` (`app/app.py` 58–107) issues `__Host-session` when `NOTES_SECURE_COOKIES=1` and always sets `Domain=None`. Legacy `.deeperguard.com` cookies are cleared. `_revoke_other_sessions()` on password / TOTP enable-disable / passkey add-remove.
- **`public_path`:** no longer `startswith("/api/auth/")`. Only pre-login routes are public (`app/auth.py` 559–579). Post-login WebAuthn management now requires session + CSRF + 2FA. **`/api/auth/srp/upgrade` and recovery/resync routes remain public** (handlers still check session/password as applicable).
- **Enumeration:** fake SRP challenge for unknown/non-SRP emails; generic register error (400, not 409); WebAuthn empty allow-list for unknown emails; generic legacy-login error.
- **Caps:** per-IP signup (5/hour); unverified-user quota (default 1 MB); global verify-email daily cap (`NOTES_VERIFY_SEND_GLOBAL_DAILY_CAP`).
- **TOTP:** per-user rate limit + last-step reuse rejection (`app/auth.py` 408–428).
- **Admin / WebAuthn / headers:** `NOTES_ADMIN_EMAILS` requires verified email; `NOTES_WEBAUTHN_ORIGIN` is configured, not Host-derived; `/.well-known/security.txt`; COOP `same-origin-allow-popups` + CORP `same-origin`.
- **Client XSS hygiene:** `escapeAttr()` on markdown `data-lang` and spreadsheet `data-sheet`.
- **Deps:** pdf.js 4.10.38 ESM (`isEvalSupported: false`), jsPDF 3.0.1; Python pins including gunicorn 23.
- **Deploy:** `NOTES_HOST` required; origin IP removed from `deploy/deploy-deeperguard.sh` / `deploy/PRODUCTION.md`.

New endpoint: **`POST /api/auth/srp/kdf-upgrade`** (see **M-3**).

### Rounds 50–53 — unlock / KDF UX (security-relevant, no new High/Medium besides the above)

- **#144 / #145:** SRP v1→v2 no longer bumps `password_changed_at` (`touch_password_changed=False`). Client probes both vault KDFs and persists `vault_kdf_version` only after decrypt proof. Silent boot-unlock failure falls back without a false “Wrong password”.
- **#146 / #147:** `probeServerKey` pages past tombstones; live +r19 E2E hardened. Local decrypt of the caller’s own ciphertext only — not a cross-user oracle.
- **#149:** lock-reason logging; skip defer/abort relock when the vault key is already **proven** (`NotesStore.isKeyVerified()`). Unverified keys still lock. No lock-bypass of a wrong password.
- **#148:** AGPL-3.0 LICENSE only.

### Unchanged in this window (re-verified)

`app/backup_pcloud.py`, pCloud helpers in `app/config.py`, `app/ocr.py` / `app/ocr_index.py` / `app/ocr_jobs.py` / `app/static/js/ocr.js`, `app/static/js/cloud-backup.js` (Dropbox token storage), and the Google/Dropbox CSP host strings were **not** functionally changed. `_align_session_with_request()` is unchanged.

---

## New vs carry-over vs fixed (this window)

| ID | Topic | Status on `9c70d94` |
|----|-------|---------------------|
| **M-1** | pCloud plaintext passwords under `keys/` | **Carry-over — still open.** Product decision. Not accepted. |
| **M-2** | Server OCR when enabled | **Carry-over — still open.** Product/ops; defaults safe. |
| **M-3** | SRP kdf-upgrade without current-password proof | **New.** Code fix. |
| **L-1** | Leftover Argon2 hash after `/api/auth/srp/upgrade` | **Carry-over — still open.** Route still `public_path`. |
| **L-2** | TOTP disable / passkey remove lack step-up | **Carry-over — partially fixed** (other sessions now revoked). |
| **L-3** | Vault-KDF upgrade unbound | **Carry-over — partially fixed** (client gates; server still trusts POST). |
| **L-4** | WAN without Secure cookies only warns | **Carry-over — accepted warning-only.** |
| **L-5** | Account enumeration | **Carry-over — partially fixed**; residual is **L-20**. |
| **L-6** | In-memory auth rate limits | **Carry-over — still open.** |
| **L-7** | Broad session cookie domain | **Fixed** (host-only / `__Host-session`). |
| **L-8** | Predictable default IndexNow key | **Carry-over — still open.** |
| **L-9** | CSP residual (`unsafe-inline`, no report-to) | **Carry-over — still open** (see L-19). |
| **L-12** | systemd as root, no sandbox | **Carry-over — still open.** |
| **L-16** | Boot derived-key in `sessionStorage` | **Carry-over — still open.** |
| **L-17** | Session rebound via `X-Device-Id` | **Carry-over — still open.** Unchanged. |
| **L-18** | Dropbox tokens in plaintext `localStorage` | **Carry-over — still open.** Unchanged. |
| **L-19** | CSP always allowlists Google/Dropbox | **Carry-over — still open.** Unchanged (COOP/CORP added beside it). |
| **L-20** | SRP challenge `srp_kdf_version` distinguishes v2 accounts | **New** (residual of L-5). |
| L-10 / L-13–L-15 | Backup mail / OTP / markdown href | **Still closed** (#96). Fence/sheet attrs now escaped too. |
| L-11 (historical) | Login SRP verifier binding | **Still fixed.** |

---

## Fixes verified since the 2026-10-21 review

| Prior ID | Topic | Status on `9c70d94` |
|----------|-------|---------------------|
| **L-7** | Broad session cookie domain | **Closed.** `HostOnlySessionInterface.get_cookie_domain` → `None`; `__Host-session` when Secure; `session_cookie_domain()` opt-in only (`NOTES_ALLOW_COOKIE_DOMAIN=1`). |
| **L-5** (partial) | Register 409 / distinguishable WebAuthn 404 | **Mitigated.** Register is generic 400; fake SRP challenge; WebAuthn empty allow-list. Residual **L-20**. |
| **L-2** (partial) | Session lifetime after 2FA/passkey change | **Improved.** `_revoke_other_sessions` on TOTP enable/disable and passkey add/remove. Step-up still missing. |
| **L-3** (partial) | Client-trusted vault-KDF bump | **Client-hardened.** Server endpoint unchanged. |
| **I-4** (partial) | Vendored pdf.js 3.11.174 | **Upgraded** to 4.10.38 ESM + jsPDF 3.0.1. No automated CVE gate yet. |

The 10-20 / 10-21 closures still hold:

| Prior ID | Topic | Status on `9c70d94` |
|----------|-------|---------------------|
| **M-3** (10-19) | Backup verification mail unbounded | **Still fixed.** `strict=True` on the unverified backup-email path. |
| **L-10** (10-15/10-19) | Manual backup-attachment send uncapped | **Still fixed** for `POST /api/backup/email`. |
| **L-13** (10-19) | Unsalted SHA-256 verification codes | **Still fixed.** HMAC-SHA256 + `hmac.compare_digest`. |
| **L-14** (10-19) | Backup resend always sent | **Still fixed.** |
| **L-15** (10-19) | Markdown `href` unescaped | **Still fixed.** `escapeAttr()` also covers `data-lang` / `data-sheet` now. |

---

## Fixes still holding (re-verified on `9c70d94`)

| Prior ID | Topic | Status on `9c70d94` |
|----------|-------|---------------------|
| SRP `A ≡ 0 (mod N)` | `app/srp_auth.py` `step2()` 192–193 | **Still fixed** — rejects `A % N == 0`, malformed hex, `u == 0`; constant-time M1 compare. |
| C-1 / #66 | SRP challenge state server-side | **Still fixed** — cookie holds only a random id; `srp_challenges` table, single-use consume, 300 s TTL. |
| L-11 / #68 | Login SRP consume re-binds current verifier | **Still fixed** — `auth.pop_srp_state()` passes current `srp_salt`/`srp_verifier`. |
| M-3 (10-13) / #68 | TOTP setup overwrite | **Still fixed** — `api_totp_setup()` requires a current code when TOTP is already enabled (`app/app.py` 1821–1830). |
| M2 required on client | `app/static/js/srp-auth.js` `login()` 326–331 | **Still in place** — throws when `M2` is missing, then `step3`. |
| Two-phase ZK password change / #63 | `api_account/password/*` 1592–1714 | **Still in place** — rotation token consume-on-commit; SRP commit clears leftover hash. **M-3 is a bypass of this control on the new kdf-upgrade route.** |
| Ephemeral OCR store | `ocr_index.save_file_only()` 180–182 | **Still in place** — refuses raw bytes when `NOTES_OCR_EPHEMERAL=1`. |
| rclone obscure via stdin | `backup_pcloud.write_rclone_config()` 133–140 | **Still in place** — `rclone obscure -` with password on stdin. |
| Upload dirs keyed by `user_id` | `app/uploads.py` 36–51 | **Still in place.** |
| Auth rate limits | unauthenticated auth endpoints | **Still in place**; WAN tightening when the CIDR gate is open; TOTP now also per-user. |
| Info-7 (10-13) | crypto-worker `fromB64` / salt | **Still fixed** — worker uses `charCodeAt(i)` and the real salt; vault params still Argon2id t=3, m=64 MiB, p=2, 32-byte key. |

---

## Findings

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext under `keys/` (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | Known (every review since 2026-10-08); **unchanged** in `03f9d75..9c70d94`. |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud *account* passwords (not vault passwords). |
| **File refs** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`, 325–337); `app/backup_pcloud.py` `write_rclone_config()` (reversibly-obscured `pass=` in `keys/pcloud-rclone-{user_id}.conf`, mode `0600`, 117–153). OAuth-token files (`write_pcloud_token()`, 352–356) are also plaintext on disk. |
| **Status** | **Still open — awaiting Dennis’s decision. Not accepted.** The #64 `rclone obscure` stdin fix remains in place; the OAuth-token path (`pcloud_token`) exists and is preferred when present. |
| **Needs a code fix?** | Yes, once the owner decides (store an OAuth token only, or encrypt the password at rest with the Flask secret / a server key). **Product decision**, then code. No code in this review. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged architecture. Python/OCR-index code unchanged this window. |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `server_ocr_enabled()` 100–102, `ocr_ephemeral()` 95–97, `log_server_ocr_startup_warning()` 108–133. Default client path does not upload document bytes. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral `/api/ocr/store` still refuses to persist raw bytes (`ocr_index.save_file_only()` 180–182). Client OCR now loads pdf.js ESM with `isEvalSupported: false`. |
| **Needs a code fix?** | No, unless server OCR is turned on. Keep the default off. **Product / ops decision.** |

#### M-3 — SRP KDF upgrade accepts a new verifier without current-password proof (new)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | **New** (`POST /api/auth/srp/kdf-upgrade` landed in #143). |
| **Impact (one line)** | A fully authenticated session (cookie + CSRF, 2FA already satisfied) can replace the stored SRP verifier on a **v1** account without proving the current password, so login credentials can be swapped and the legitimate user locked out of new logins. Vault notes stay encrypted under the original password. |
| **File refs** | `app/app.py` `api_auth_srp_kdf_upgrade()` 1001–1027 — session + `csrf_ok()` only; `db.update_user_srp_verifier(..., touch_password_changed=False)` with client `srp_salt` / `srp_verifier`; no SRP proof, no `_revoke_other_sessions`. Client: `app/static/js/srp-auth.js` `maybeUpgradeSrpKdf()` 297–312 (honest client has the password; the server does not check). Contrast: two-phase password change 1592–1714 and vault-recovery 1225–1228 require a stored-verifier proof. Once `srp_kdf_version >= 2` the handler is a no-op (new signups are already v2). |
| **Status** | Open on remaining v1 accounts. Not exercised after a successful v2 upgrade. |
| **Remediation outline** | Bind the upgrade to proof of the current password: either consume a short-lived token issued by `/api/auth/srp/verify`, or require an SRP proof against the verifier on file (same pattern as vault-recovery). Reject a client-supplied verifier that is not so bound. Consider `_revoke_other_sessions` after a real upgrade. |
| **Needs a code fix?** | **Yes.** Not a product decision. |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)

`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The #63 SRP password-change commit path does clear it. The upgrade route is still in `public_path` (578), so the global CSRF + 2FA gate is skipped; the handler still requires a session and the current leftover hash (`app/app.py` 1257–1279).
**File refs:** `app/app.py` `api_auth_srp_upgrade()` 1257–1279; `app/db.py` `upgrade_user_to_srp()` 435–453 (does not touch `password_hash`); `app/app.py` `api_auth_srp_resync()` 1116–1142; `deploy/set-account-password.py`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts and no per-endpoint rate limit (carry-over, partially fixed)

For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code. **Improved this window:** `_revoke_other_sessions(..., reason="totp")` after disable/enable. Setup remains protected. `POST /api/auth/webauthn/remove` is the same family — session + CSRF + 2FA, no WebAuthn assertion; now also revokes other sessions.
**File refs:** `app/app.py` `api_totp_disable()` 1866–1891; `api_webauthn_remove_credential()` 1426–1438.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, partially fixed)

Authenticated `POST /api/account/vault-kdf` still bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only (cannot downgrade), not a ciphertext oracle. **Client this window:** persist `notes_vault_kdf_version` only after decrypt proof; `retryPendingVaultKdfUpgrade` probes v2 locally before POST (`store.js` 702–751, 795–812).
**File refs:** `app/app.py` `api_account_vault_kdf()` 1717–1731; `app/db.py` `update_user_vault_kdf_version()`.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)

`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits HSTS; a one-time startup warning is logged. When Secure *is* on, cookies are now `__Host-session` (see L-7 closed). **Status: owner-accepted as warning-only; status noted, not re-opened.**
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()` 143–158; `app/app.py` `SESSION_COOKIE_SECURE` 115; `app/auth.py` `security_headers()` 794–795.

#### L-5 — Account enumeration on auth endpoints (carry-over, partially fixed)

**Mitigated:** `/api/auth/srp/register` returns generic 400 (not 409); unknown emails get a deterministic fake SRP challenge; WebAuthn login options use an empty allow-list instead of `404 no passkeys registered`; legacy login is generic `invalid credentials`. All remain rate-limited. **Residual:** see **L-20**. Register success (200 + session) vs the generic 400 is still distinguishable by design.
**File refs:** `app/app.py` `api_auth_srp_register()` 916–920, `api_auth_srp_challenge()` 948–967, `api_webauthn_login_options()` 1447–1459.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open; partially improved)

Limits reset on restart; production gunicorn is `--workers 1` so workers do not split buckets today. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP) — not `/api/account/*`, `/api/backup/*`, or `/api/totp/*`. The unbounded `_hits`/`_GEO_CACHE` dicts grow with distinct keys. **Still improved by #96:** verification and backup-attachment sends use a SQLite log. **This window:** per-user TOTP bucket; per-IP signup cap; global verify-email cap.
**File refs:** `app/auth_rate_limit.py`; `app/auth.py` `_GEO_CACHE`; `app/verification_send_limit.py` 65–69; `deploy/setup-cloudflare-rate-limits.sh` 61.

#### L-8 — Predictable default IndexNow key (carry-over, still open)

Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY` 75.

#### L-9 — CSP residual hardening (carry-over, still open; still widened by L-19)

`style-src 'unsafe-inline'`; no `report-to`/`report-uri`; `script-src` remains nonce-based with `'wasm-unsafe-eval'` (needed for Argon2 / OCR wasm). Markdown `href` and fence/sheet attributes are escaped. Google GIS and Dropbox hosts remain in `script-src` / `connect-src` / `frame-src` on every response (see **L-19**). **This window:** COOP + CORP added (`auth.py` 789–792).
**File refs:** `app/auth.py` `content_security_policy()` 752–779.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (carry-over, still open)

All three units omit `User=`/`Group=` and sandboxing directives, so gunicorn runs as root (binding `127.0.0.1:80` encourages this). The optional LAN-TLS unit still binds `0.0.0.0:443` as root (installer refuses it when the CIDR gate is open).
**File refs:** `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service`.
**Remediation outline:** dedicated user + `AmbientCapabilities=CAP_NET_BIND_SERVICE` (or socket activation) and standard `ProtectSystem=` / `PrivateTmp=` / `NoNewPrivileges=`. Deploy-only; no app code.

#### L-16 — Login/register boot handoff stashes derived vault-key bytes in `sessionStorage` (carry-over, still open)

`notes_boot_kdf` still holds AES-GCM ciphertext of the Argon2 output next to the boot storage key so `/app` can `adoptDerivedVaultKey()` and skip a second derive. Cleared on consume/lock; session-scoped. Same family as I-5. Not a remote issue.
**File refs:** `app/static/js/vault-secrets.js` `stashBootDerivedKey()` 105–123, `consumeBootPassword()` 135–168; `app/static/js/store.js` `adoptDerivedVaultKey()` 512–521.

#### L-17 — Session cookie can adopt another live same-user row via `X-Device-Id` (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over** (introduced in #112 / `766ebfd`; recorded as new on 10-20). **Unchanged** on `9c70d94` — Round 49 edited CSP/headers/`public_path` in `app/auth.py`, not this function. |
| **Impact (one line)** | An already-authenticated request that names another live device id for the same account rotates that row’s token into this cookie, so the other browser’s cookie stops matching. Same-user only; device ids are high-entropy and are not returned by `GET /api/sessions`. Authenticated callers can already revoke sessions explicitly. |
| **File refs** | `app/auth.py` `_align_session_with_request()` 175–200, `ensure_device_session()` 222–236; `app/db.py` `get_active_session_for_device()` 902–914, `rotate_session_token()` 917–928. Covered by `tests/test_app.py` `test_this_device_is_the_request_session`. |
| **Remediation outline** | Rebound only when the cookie row’s stored `device_id` is empty or already equals the request’s device id. Do not rotate a *different* live row from a client-supplied header alone. |
| **Needs a code fix?** | Yes. |

#### L-18 — Dropbox OAuth tokens persist in plaintext `localStorage` and are not cleared on vault lock (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over** (new on 10-21). **`cloud-backup.js` unchanged** this window. |
| **Impact (one line)** | A Dropbox access token and long-lived refresh token for the App-folder (or whatever app type the user registered) remain readable from `localStorage` after the vault is locked, and after the tab is closed; same-origin script or a copied browser profile can reuse them to read or overwrite encrypted `.dgbackup` files. Note plaintext is not exposed — backups stay vault-encrypted. Google Drive access tokens stay in JS memory only, but `NotesStore.lock()` also does not zero them. |
| **File refs** | `app/static/js/cloud-backup.js` `rememberDropboxTokens()` 512–523, `loadCachedDropboxToken()` 558–564, `writePrefs()` 76–81; `disconnectDropbox()` / `clearDropboxTokensLocal()` 526–537 exist but are not called from `store.js` `lock()` 821–861 or `app.js` `lockVault` 3339–3343 (that path only clears vault pref keys `googleOauthClientId` / `dropboxAppKey`). |
| **Remediation outline** | Keep refresh tokens out of `localStorage` (sessionStorage or vault-encrypted blob). Clear Dropbox and Google module tokens from `NotesStore.lock()` / sign-out. Prefer the Google pattern (memory-only access token; re-prompt after unlock) for Dropbox as well. |
| **Needs a code fix?** | Yes. |

#### L-19 — CSP unconditionally allowlists Google GIS and Dropbox on every response (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over** (new on 10-21). Host strings **unchanged**; COOP/CORP were added next to them. |
| **Impact (one line)** | Every response, including marketing and login, may load scripts from `https://accounts.google.com` and connect to Google / Dropbox API hosts even when `GOOGLE_OAUTH_CLIENT_ID` and `DROPBOX_APP_KEY` are empty and the page never uses cloud backup. Widens the third-party script/connect/frame surface if those origins are compromised. |
| **File refs** | `app/auth.py` `content_security_policy()` 752–779 (always concatenates `google_script` / `google_connect` / `google_frame` / `dropbox_connect`); applied globally via `app/app.py` `_headers`. GIS is loaded on demand with the page nonce (`cloud-backup.js` `loadGis()`), but the host source does not require a nonce. |
| **Remediation outline** | Emit the Google / Dropbox CSP tokens only when the corresponding env key is non-empty, and only on `/app` (or another authenticated notes document). Leave marketing/login on the previous `'self'` connect/script policy. |
| **Needs a code fix?** | Yes. |

#### L-20 — SRP challenge `srp_kdf_version` distinguishes registered v2 accounts (new; residual of L-5)

Fake challenges for unknown / non-SRP emails always return `"srp_kdf_version": 1`. Real v2 accounts return `2`. Rate-limited; does not reveal v1 vs unknown (both look like v1 until verify).
**File refs:** `app/app.py` `api_auth_srp_challenge()` 948–951 vs 963–967; `app/srp_auth.py` `fake_srp_challenge()` 231–248.
**Remediation outline:** Return a constant version on the fake path (or omit the field until verify) so the challenge body shape matches a real v2 account.
**Needs a code fix?** Yes (low priority).

### Informational

1. **I-1 (carry-over):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without requiring email verification for login — abuse surface; signup-notify emails are awareness only. **This window:** per-IP signup cap (5/hour) and unverified quota (default 1 MB). Verification still gates backups (rate-limited; see #96).
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts (rate-limited, refuses SRP accounts); `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1).
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over, partially improved):** Vendored JS under `app/static/js/vendor/` without an automated CVE gate in CI. pdf.js is now 4.10.38 ESM; jsPDF 3.0.1; Python deps pinned including gunicorn 23. Upgrades still depend on manual version bumps (`deploy/fetch-ocr-assets.sh`, `tests/test_round49_assets.js`).
5. **I-5 (carry-over):** "Remember on device" password stash stores the AES-GCM key next to the ciphertext in web storage — obfuscation against casual inspection only; inherent to the opt-in feature. Extended by L-16 for the boot derived key.
6. **I-6 (carry-over, slightly improved):** remote sign-out wipe is scoped to `revoke_reason == "user"`. When the session cookie names **no** account at all, `session_requires_wipe()` still falls back to the newest session for the client-supplied `X-Device-Id` across accounts. Availability nuisance; local cache is per-account ciphertext.
7. **I-7 (carry-over):** Deploy pipeline pushes as root over SSH with `StrictHostKeyChecking=accept-new` (TOFU). **This window:** origin IP/SSH host is no longer hardcoded; `NOTES_HOST` is required. Tarball still excludes `keys/` and `data/`; gunicorn stays on `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open.
8. **I-8 (carry-over):** service worker still caches session-scoped `/app` HTML (`networkFirstNavigate` + `putBoth`). Offline, a prior login’s `data-csrf` can be replayed from cache on the same profile. `/api/*` is not intercepted; API responses stay `no-store`. pdf.js cache entries are now the `.mjs` builds.
9. **I-9 (carry-over):** Deployment `GOOGLE_OAUTH_CLIENT_ID` / `DROPBOX_APP_KEY` are public identifiers rendered into `/app` meta tags. Expected for public OAuth clients; tenants sharing one origin see the same server default keys. Comments correctly forbid client secrets.
10. **I-10 (carry-over):** The Dropbox popup forwards `window.location.search` (authorization `code` + `state`) via same-origin `postMessage` (`cloud-backup.js` 14–17, 631–635), then strips the URL. Origin-checked; short-lived. Hygiene: pass parsed `code` only after the popup validates state.

Contact-form header injection was re-checked and is **not** an issue: visitor name/subject flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values.

Positive in this window (not findings): SRP v2 for new accounts; host-only session cookies; post-login `/api/auth/*` no longer public; session revoke on credential changes; fake SRP challenge; signup/verify caps; TOTP step reuse; verified-email admin gate; configured WebAuthn origin; `security.txt`; COOP/CORP; pdf.js/jsPDF upgrades; `escapeAttr` on fence/sheet names; `NOTES_HOST` required; vault KDF persisted only after decrypt proof; silent defer does not relock a proven vault.

---

## Status of previously known open items (requested checklist)

| Item | Status on `9c70d94` |
|------|---------------------|
| SRP `A ≡ 0 (mod N)` bypass | **Still fixed** |
| SRP challenge state server-side (C-1, #66) | **Still fixed** |
| Login SRP verifier binding (L-11, #68) | **Still fixed** |
| TOTP setup overwrite (M-3 of 10-13, #68) | **Still fixed** |
| M2 required on client | **Still in place** (`srp-auth.js` 326–331) |
| Ephemeral OCR store | **Still in place** |
| rclone obscure via stdin | **Still in place** (`backup_pcloud.py` 133–140) |
| Two-phase ZK password change (#63) | **Still in place** (bypassed for v1 by new **M-3**) |
| Upload dirs keyed by `user_id` | **Still in place** |
| Auth rate limits | **Still in place** on unauthenticated auth endpoints; verification/backup mail still SQLite-capped; TOTP now per-user |
| Signup notify | **Still in place** (`admin_notify.notify_new_user_signup`) |
| Unbounded backup-verification mail (M-3 of 10-19) | **Still closed** (#96); unverified path still `strict=True` |
| Unsalted OTP hashes / backup resend / markdown href (L-13–L-15) | **Still closed** (#96); fence/sheet attrs escaped this window |
| Manual backup-attachment cap (L-10) | **Still closed** (#96) for the user API |
| pCloud plaintext passwords | **Still open** (M-1) — awaiting Dennis; **not** accepted |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted |
| systemd unit hardening (L-12) | **Still open** |
| Session rebound via `X-Device-Id` (L-17) | **Still open** — unchanged |
| Dropbox tokens in `localStorage` (L-18) | **Still open** — unchanged |
| CSP Google/Dropbox allowlist (L-19) | **Still open** — unchanged |
| Broad session cookie domain (L-7) | **Closed** this window |

---

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** all item/blob/reminder/session/OCR-job/upload queries scoped by authenticated `user_id`; device-session tokens stored as SHA-256 hashes; `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session (unlock still requires SRP/legacy proof) and pass the same-origin gate for POSTs. No new cloud-backup server endpoints. No new item/blob routes in this window.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match against the canonical www/apex set; bare `same-site` rejected; `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare). Unlock/challenge is not CSRF-exempt. Public API POSTs still require same-origin (`app/app.py` 535–538).
- **Headers:** nonce-based `script-src` (plus the third-party hosts — L-19), `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; HSTS when Secure cookies are on; `/api/*` is `no-store`. **New:** COOP `same-origin-allow-popups` (OAuth popups) and CORP `same-origin`.
- **AI relay:** `app/ai_relay.py` — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged; no SSRF surface (unchanged).
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`. Env-listed admins now also need a verified email. Self-host doc remains escaped.
- **Vault crypto:** Argon2id v2 params aligned between `app/vault_crypto.py`, `app/static/js/crypto.js`, and `crypto-worker.js` (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV). `persistLocal()` still `wrapItem()`s before IndexedDB (`store.js` 1277–1322). `buildLocalBackup()` still prefers stored ciphertext. Empty-vault unlock still requires SRP (or legacy password).
- **Rounds 50–53 unlock path:** dual-KDF probe is local decrypt of the user’s own samples; tombstone paging does not leak other users’ data; `vaultKeyProven()` requires `isKeyVerified()` after successful decrypt or empty-vault SRP/account unlock — silent defer does not skip lock for an unverified key.
- **Health:** `/api/health` still returns only `ok` / `service` / `build` for anonymous callers; extra fields remain admin-session-only.
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1` defaults; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`. Gunicorn stays on `127.0.0.1:80`; `NOTES_ENABLE_LAN_TLS` defaults off. OAuth env keys default empty. `NOTES_HOST` now required for deploy.
- **WebAuthn / recovery / password change:** no regressions vs 10-21 except **M-3** on the new kdf-upgrade route. Vault recovery still requires session + CSRF + SRP proof against the stored verifier before verifier update.
- **Client cloud backups:** still client-only; tokens never sent to the DeeperGuard server; Dropbox PKCE S256 + state; Google `drive.file`; `postMessage` origin-checked; COOP-safe popups; per-user app IDs in vault settings. Residual issues remain L-18 / L-19 / I-9 / I-10.

---

## High / Medium — code fix vs product decision

| ID | Needs |
|----|--------|
| **M-1** | **Product decision**, then code (OAuth-token only, or encrypt at rest). Not accepted as-is. |
| **M-2** | **Product / ops decision.** Keep `NOTES_SERVER_OCR=0`. No code unless it is turned on. |
| **M-3** | **Code fix.** Bind kdf-upgrade to current-password proof (or a verify-issued one-time token). |

No High findings.

---

## Recommended next steps (priority)

1. **M-3 (code fix):** bind `/api/auth/srp/kdf-upgrade` to a current-password proof or a one-time token from SRP verify; optionally revoke other sessions on a real upgrade.
2. **M-1:** owner decision on pCloud password storage (OAuth-token only, or encrypt at rest). Not accepted as-is.
3. **L-17 (code fix):** rebound the cookie only when the cookie row already names this device (or has no device id yet).
4. **L-18 (code fix):** stop persisting Dropbox refresh tokens in plaintext `localStorage`; clear cloud tokens on vault lock.
5. **L-19 (code fix):** gate Google/Dropbox CSP hosts on configured keys and `/app` only.
6. **L-1 / L-20:** `clear_user_legacy_password()` on SRP upgrade; drop `/api/auth/srp/upgrade` from `public_path`; make fake challenges look like v2.
7. **L-2 / L-16:** TOTP-disable (and passkey-remove) step-up + rate limit; drop or document the boot derived-key stash.
8. **L-3 / L-12:** bind the vault-KDF bump; systemd `User=` + sandboxing (deploy-only).
9. **L-4 / M-2:** product/ops decisions unchanged (WAN warning-only; keep server OCR off).

*End of report.*
