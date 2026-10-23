# DeeperGuard Security Review — 2026-10-23

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `70097dd` (Round 62 / #162). Includes everything after the 2026-10-22 review (`9c70d94`): #151 (M-3 / L-20) through #162 (marketing KDF copy). Live Vienna `/api/health` reports the same build (`70097ddb`) and a client manifest hash.
**Reviewer:** Cursor Cloud Agent — static review of current `main` plus local unit tests (`tests/test_srp_kdf_upgrade.py`, `tests/test_round49_security.py`, `tests/test_round56_security.py`, `tests/test_round57_turnstile.py`, `tests/test_no_hardcoded_e2e_credentials.py`, `tests/test_srp_server_challenge.py`, `tests/test_round59_server_copy.py`, `tests/test_round60_client_integrity.py`: 59/59 pass). Header check of `https://www.deeperguard.com`. No production SSH, no live penetration testing.
**Scope:** Auth (SRP, TOTP, WebAuthn, sessions/cookies, password change, kdf-upgrade), vault/crypto, sync/API authorization, CSP and security headers, rate limits, deploy defaults (`deploy/` scripts, env defaults), and OCR / pCloud / cloud-backup misconfiguration. New surface since 10-22: Turnstile, signup auto-unlock, View server copy, `/verify`, client integrity (SRI / hashed assets / Sigstore).
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Baseline: the 2026-10-22 review (`docs/SECURITY-REVIEW-2026-10-22.md`, draft-PR #150, branch only — prior reports are not on `main`) reviewed `main` at `9c70d94`. Everything that landed after it (#151–#162) is new surface covered here.

---

## Executive summary

**No Critical or High findings on current `main`.** #151 correctly and completely closed the 10-22 **M-3** (kdf-upgrade now needs a fresh stored-verifier SRP proof, and is not 2FA-exempt) and the original **L-20** (fake challenges report `srp_kdf_version: 2`). A later same-day pass, Round 56 (#153), closed a *separate* review’s C1 / H1–H3 / M1–M5 (repair-login prove-only, burned E2E defaults removed from the tree, vault-recovery KDF version stamp, dependency bumps, fake repair challenges, reject KDF v1 on rotation, signup honeypot + tighter IP cap, monotonic TOTP steps, Dropbox tokens moved into the encrypted vault). Rounds 57–62 add Turnstile (fail-closed when the secret is set), empty-vault signup auto-unlock, View server copy, a public `/verify` page, and client SRI / hashed static / optional Sigstore. Those do not weaken zero-knowledge.

**No new Medium that needs a code fix.** Carry-over Mediums are unchanged: pCloud WebDAV passwords on disk (still awaiting Dennis — **not** accepted) and server OCR when explicitly enabled (defaults remain safe; off on Vienna).

**L-18 is closed** for new Dropbox connects (tokens live in encrypted vault settings). **L-17 and L-19 stay open.** **L-20**’s original bug is closed; a smaller residual remains (real leftover v1 accounts still advertise version 1). Two **new Lows** come from the new surface: unpaired Turnstile keys fail open, and `vault-recovery` can still rotate a verifier from a password-only session because it is `public_path` (the 2FA gate that #151 added for kdf-upgrade does not apply).

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 2 (both carry-over; M-3 closed) |
| Low | 15 (12 unchanged carry-over, L-20 residual, 2 new) |
| Informational | 11 (I-1 / I-4 updated; I-11 new for client integrity) |

### Top findings (current)

1. **M-1 (Medium, carry-over — open product decision):** pCloud WebDAV passwords (and OAuth token JSON) still stored in plaintext under `keys/`. **Not accepted.** Still awaiting Dennis’s decision.
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe and the startup warning is in place. Off in production.
3. **L-17 (Low, carry-over — code fix):** an authenticated request can adopt another live same-user session row by sending that row’s `X-Device-Id`, rotating the adopted row’s token.
4. **L-19 (Low, carry-over — code fix):** CSP still unconditionally allowlists Google GIS and Dropbox on every response, including marketing and login. Turnstile is now gated (good); Google/Dropbox are not. Confirmed on live `www.deeperguard.com`.
5. **L-21 (Low, new — code fix):** if `NOTES_TURNSTILE_SITE_KEY` is set without `NOTES_TURNSTILE_SECRET_KEY`, the widget renders but register is not enforced (`_verify_turnstile_token` returns `ok` when the secret is empty).
6. **L-22 (Low, new — code fix):** `/api/auth/vault-recovery` remains `public_path`, so the post-login 2FA gate does not apply; a password-only session plus CSRF can rotate the stored verifier. kdf-upgrade was deliberately *not* given this exemption.

---

## What changed since the 2026-10-22 review (`9c70d94` → `70097dd`)

### #151 — kdf-upgrade proof + fake-challenge v2 (material; closes M-3 and original L-20)

- New `POST /api/auth/srp/kdf-upgrade/challenge` issues a server-side `srp_challenges` row with purpose `kdf-upgrade` (5-minute TTL, single-use, bound to user + stored salt/verifier).
- `POST /api/auth/srp/kdf-upgrade` requires a fresh A/M1 against that challenge, returns M2, and only then installs the client-supplied v2 salt/verifier. Missing proof / replay / wrong purpose / already-v2 are rejected.
- **Not** in `public_path`. The global 2FA gate therefore applies. Client `login()` skips `maybeUpgradeSrpKdf` when `totp_required`; `totp-page.js` finishes the upgrade after `/api/totp/verify` using `peekBootPassword` (does not consume the stash).
- Fake SRP challenges for unknown / non-SRP emails now report `srp_kdf_version: 2`.
- `password_changed_at` is still not bumped (Round 50 UX). Vault ciphertext is untouched. Other sessions are **not** revoked (residual, see M-3 status).

**Verification:** implementation matches the #151 write-up. 8 kdf-upgrade tests plus Round 49 / 56 / 57 suites pass locally. No regression of the two-phase password-change control.

### #153 — Round 56 (material; separate review’s C1 / H1–H3 / M1–M5)

These IDs are **not** the 10-22 M-1/M-2/M-3 scheme. Status on `70097dd`:

| #153 ID | Topic | Status now |
|---------|-------|------------|
| **C1** | `repair-login` prove-only; submitted salt/verifier ignored | **Holds.** `api_auth_repair_login()` 1205–1250. |
| **H1** | Live E2E credential defaults removed; CI grep | **Holds in tree.** `tests/test_no_hardcoded_e2e_credentials.py`. Git-history purge still deferred (owner). |
| **H2** | Vault-recovery persists `srp_kdf_version=2`; lockout count/repair helper | **Holds.** `db.update_user_srp_verifier`; `deploy/repair-srp-kdf-lockouts.py` (count-only unless `--apply`). |
| **H3** | Pillow 13 / pillow-heif 1.8.1 / Flask 3.1.3 / Werkzeug 3.1.9 / jsPDF 4.2.1 | **Holds** (`requirements.txt`, `deploy/fetch-ocr-assets.sh`). |
| **M1** | Fake repair challenges; unified verify errors; fresh B | **Holds.** |
| **M2** | Reject KDF v1 on rotation endpoints | **Holds** (password change, vault-recovery, srp/upgrade). |
| **M3** | Register IP 3/h; honeypot; Turnstile behind config | **Holds**; Turnstile later enabled (#154). |
| **M4** | TOTP monotonic `step <= last_step` | **Holds.** `totp.verify_and_step()` 26–49. |
| **M5** | Dropbox tokens in encrypted vault settings | **Holds** — closes 10-22 **L-18** for new connects. |

Also this window: `/ca.crt` gated (`NOTES_SERVE_CA_CRT` default 0); in-memory rate-limit key bound; markdown emphasis outside tags; `/sw.js` `Cache-Control: public, max-age=0, must-revalidate`.

### #154 / #155 — Turnstile + empty-vault signup auto-unlock (security-relevant)

- Register requires a valid Turnstile token when `NOTES_TURNSTILE_SECRET_KEY` is set; Cloudflare unreachable → 503, no account. Login/SRP unchanged. CSP allowlists `challenges.cloudflare.com` **only** when the site key is set.
- After sign-up, the empty vault may auto-unlock using the boot-password stash **and** an SRP `/api/account/unlock` proof. Not a cookie-only unlock. `NOTES_STRICT_ZK=1` still rejects `current_password` on unlock.

### #156 / #159 / #161 — View server copy + `/verify`

- `GET /api/sync/item/<uuid>` returns the caller’s own ciphertext + sync metadata (same fields as pull/refetch). Scoped by `user_id`; other accounts 404. No server decrypt. UI gated on `NotesStore.isUnlocked()`.
- `/verify` is a script-free public marketing page (cookie-free, short CDN cache). Documents ZK checks and client-hash workflow. No admin fields.

### #157 / #158 / #160 — client integrity

- Reproducible `client-manifest.json`, hashed static URLs, SRI on `asset_script` / `asset_stylesheet`. Deploy rebuilds the manifest after wiping `app/static/js` and `css` (`set -euo pipefail`). Optional Sigstore on GitHub Releases; `/verify` copy is honest when unsigned.
- Residual: unhashed `/static/js/…` still served; loaded manifest is not re-hashed at runtime; SW precache still uses some unhashed vendor paths (I-11).

### #152 / #162 — low security relevance

Round 55 keeps vault lock prefs across sign-in (no session/key leak). #162 is marketing copy only (Argon2id, not PBKDF2).

### Unchanged in this window (re-verified)

`app/backup_pcloud.py` password path, `write_pcloud_password()` / `write_pcloud_token()`, `server_ocr_enabled()` defaults, and `_align_session_with_request()` were **not** functionally changed. Google/Dropbox CSP host strings are still unconditional.

---

## New vs carry-over vs fixed (this window)

| ID | Topic | Status on `70097dd` |
|----|-------|---------------------|
| **M-1** | pCloud plaintext passwords under `keys/` | **Carry-over — still open.** Product decision. Not accepted. |
| **M-2** | Server OCR when enabled | **Carry-over — still open.** Product/ops; defaults safe; off in prod. |
| **M-3** | SRP kdf-upgrade without current-password proof | **Closed (#151).** Residual: no `_revoke_other_sessions` (intentional `password_changed_at` freeze). |
| **L-1** | Leftover Argon2 hash after `/api/auth/srp/upgrade` | **Carry-over — still open.** Route still `public_path`; now rejects v1 verifiers. |
| **L-2** | TOTP disable / passkey remove lack step-up | **Carry-over — partially fixed** (other sessions revoked). See also **L-22**. |
| **L-3** | Vault-KDF upgrade unbound | **Carry-over — partially fixed** (client gates; server still trusts POST). |
| **L-4** | WAN without Secure cookies only warns | **Carry-over — accepted warning-only.** Vienna serves HSTS (Cloudflare + app). |
| **L-5** | Account enumeration | **Carry-over — partially fixed**; residual is **L-20**. |
| **L-6** | In-memory auth rate limits | **Carry-over — still open.** Key cap added (#153). Production still `--workers 1`. |
| **L-7** | Broad session cookie domain | **Still closed** (`__Host-session` when Secure). |
| **L-8** | Predictable default IndexNow key | **Carry-over — still open.** |
| **L-9** | CSP residual (`unsafe-inline`, no report-to) | **Carry-over — still open** (see L-19). Turnstile now conditional. |
| **L-12** | systemd as root, no sandbox | **Carry-over — still open.** |
| **L-16** | Boot derived-key in `sessionStorage` | **Carry-over — still open.** Signup auto-unlock reuses the same stash. |
| **L-17** | Session rebound via `X-Device-Id` | **Carry-over — still open.** Unchanged. |
| **L-18** | Dropbox tokens in plaintext `localStorage` | **Closed (#153 M5)** for new connects. Residual: one-shot legacy read + in-memory token after lock. |
| **L-19** | CSP always allowlists Google/Dropbox | **Carry-over — still open.** Unchanged host strings. |
| **L-20** | Fake challenge `srp_kdf_version` | **Original closed (#151).** Residual: real leftover v1 accounts still return `1`. |
| **L-21** | Unpaired Turnstile keys fail open | **New.** Code fix. |
| **L-22** | vault-recovery skips 2FA gate via `public_path` | **New** (inconsistency made material by #151). Code fix. |
| L-10 / L-13–L-15 | Backup mail / OTP / markdown href | **Still closed** (#96). Emphasis-outside-tags + fence/sheet attrs still escaped. |
| L-11 (historical) | Login SRP verifier binding | **Still fixed.** |

---

## #151 verification (requested)

| Claim | Result |
|-------|--------|
| Fresh current-password SRP proof required | **Correct.** Challenge purpose `kdf-upgrade`; consume binds user + stored salt/verifier; missing A/M1 → 400 `missing srp proof`. |
| After TOTP, not before | **Correct.** Route is not `public_path`; `_gate()` 2FA list does not exempt it; client skips when `totp_required`; `totp-page.js` runs after `/api/totp/verify`. |
| Replay / wrong-purpose / already-v2 rejected | **Correct.** Tests cover all three. |
| Fake challenges report v2 | **Correct.** Login and repair-login unknown-email paths. |
| Rate-limited | **Correct.** `srp-kdf-upgrade` bucket. |
| CSRF + session | **Correct.** |
| Does not bump `password_changed_at` | **Correct** (Round 50). |
| Complete vs 10-22 remediation | **Yes** for the stated bug. Optional leftover: `_revoke_other_sessions` after a real upgrade (10-22 suggested it; not required to close M-3). |
| Regressions | **None found.** Password-change two-phase control, repair-login prove-only, and unlock `strict_zk` still hold. |

---

## Fixes verified since the 2026-10-22 review

| Prior ID | Topic | Status on `70097dd` |
|----------|-------|---------------------|
| **M-3** | kdf-upgrade without password proof | **Closed (#151).** |
| **L-20** (original) | Fake challenge always v1 | **Closed (#151).** Residual below. |
| **L-18** | Dropbox tokens in `localStorage` | **Closed (#153)** for new tokens. Residual legacy read. |
| **L-7** | Broad session cookie domain | **Still closed.** |
| **#153 C1** | repair-login rotation | **Closed.** |
| **#153 H1–H3 / M1–M5** | See table above | **Closed** (history purge for H1 still deferred). |

The 10-19 / 10-21 closures still hold (backup-verification `strict=True`, HMAC codes, markdown `href` / fence attrs, leftover-hash password-change clear).

---

## Fixes still holding (re-verified on `70097dd`)

| Prior ID | Topic | Status on `70097dd` |
|----------|-------|---------------------|
| SRP `A ≡ 0 (mod N)` | `app/srp_auth.py` `step2()` 192–193 | **Still fixed.** |
| C-1 / #66 | SRP challenge state server-side | **Still fixed** — cookie holds only a random id; `srp_challenges` table, single-use consume, 300 s TTL, purpose + user + salt/verifier bind. |
| L-11 / #68 | Login SRP consume re-binds current verifier | **Still fixed.** |
| M-3 (10-13) / #68 | TOTP setup overwrite | **Still fixed** — `api_totp_setup()` requires a current code when TOTP is already enabled. |
| M2 required on client | `app/static/js/srp-auth.js` `login()` / kdf-upgrade | **Still in place** — throws when `M2` is missing, then `step3`. |
| Two-phase ZK password change / #63 | `api_account/password/*` 1744–1868 | **Still in place** — rotation token consume-on-commit; v1 verifier rejected; leftover hash cleared. |
| Ephemeral OCR store | `ocr_index.save_file_only()` | **Still in place.** |
| rclone obscure via stdin | `backup_pcloud.write_rclone_config()` | **Still in place.** |
| Upload dirs keyed by `user_id` | `app/uploads.py` | **Still in place.** |
| Auth rate limits | unauthenticated auth endpoints | **Still in place**; WAN tightening; TOTP per-user; register IP 3/h. |
| Host-only session cookies | `HostOnlySessionInterface` `app/app.py` 59–108 | **Still in place.** |

---

## Findings

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext under `keys/` (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **New vs known** | Known (every review since 2026-10-08); **unchanged** in `9c70d94..70097dd`. |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud *account* passwords (not vault passwords). |
| **File refs** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`, 350–362); `write_pcloud_token()` 377–381 (OAuth token JSON, also plaintext); `app/backup_pcloud.py` `write_rclone_config()` (reversibly-obscured `pass=`). |
| **Status** | **Still open — awaiting Dennis’s decision. Not accepted.** The #64 `rclone obscure` stdin fix remains; the OAuth-token path is preferred when present but is still plaintext on disk. |
| **Needs a code fix?** | Yes, once the owner decides (store an OAuth token only, or encrypt the password at rest with the Flask secret / a server key). **Product decision**, then code. No code in this review. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **New vs known** | Known; unchanged architecture. |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, documents are processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and files persist on disk. |
| **File refs** | `app/app.py` `/api/ocr*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_jobs.py`; `app/config.py` `server_ocr_enabled()` 100–102, `ocr_ephemeral()` 95–97, `log_server_ocr_startup_warning()` 108–133. |
| **Status** | **Defaults remain safe** (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warnings in place; ephemeral store still refuses raw bytes. Client OCR is the default path. Off in production per prior owner note. |
| **Needs a code fix?** | No, unless server OCR is turned on. Keep the default off. **Product / ops decision.** |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over, still open)

`/api/auth/srp/upgrade` installs a verifier but does not call `clear_user_legacy_password()`, so `/api/auth/srp/resync` still accepts the plaintext password for those accounts. The password-change commit path still clears it. The upgrade route is still in `public_path` (`auth.py` 580); the handler still requires a session and the leftover hash. **This window:** v1 verifiers are rejected (`app.py` 1424–1425).
**File refs:** `app/app.py` `api_auth_srp_upgrade()` 1406–1431; `app/db.py` `upgrade_user_to_srp()`.

#### L-2 — TOTP disable has no password/SRP step-up for SRP accounts (carry-over, partially fixed)

For `auth_method == "srp"`, `/api/totp/disable` skips the password check and requires only a current TOTP code. Other sessions are revoked. `POST /api/auth/webauthn/remove` is the same family. See **L-22** for the related public recovery path.
**File refs:** `app/app.py` `api_totp_disable()` 2020–2045; `api_webauthn_remove_credential()` 1579–1589.

#### L-3 — Vault-KDF upgrade is unbound (carry-over, partially fixed)

Authenticated `POST /api/account/vault-kdf` still bumps the stored version to 2 without an unlock or SRP step-up. Upgrade-only. Client still persists `notes_vault_kdf_version` only after decrypt proof.
**File refs:** `app/app.py` `api_account_vault_kdf()` 1871–1885.

#### L-4 — WAN exposure without Secure cookies only warns (carry-over; accepted warning-only)

`NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` serves session cookies without the Secure flag and omits app-level HSTS. **Vienna:** live responses include `strict-transport-security: max-age=31536000` (Cloudflare; app also sets `includeSubDomains` when Secure is on). Status noted, not re-opened.
**File refs:** `app/config.py` `log_wan_secure_cookies_startup_warning()` 143–158; `app/auth.py` `security_headers()` 806–807.

#### L-5 — Account enumeration on auth endpoints (carry-over, partially fixed)

Register is generic 400; unknown emails get a fake SRP challenge; WebAuthn uses an empty allow-list; legacy login is generic. Residual: **L-20**. Register success (200 + session) vs generic 400 is still distinguishable by design.
**File refs:** `app/app.py` `api_auth_srp_register()` 1031–1033, `api_auth_srp_challenge()` 1054–1081.

#### L-6 — In-memory, per-process auth rate limits (carry-over, still open; slightly improved)

Limits reset on restart; production gunicorn is `--workers 1`. Cloudflare edge rules cover `/api/auth/*` only (30/min/IP). **This window:** `_hits` evicts when over 20_000 keys (`auth_rate_limit.py` 31–48). Verification / backup-attachment sends still use SQLite.

#### L-8 — Predictable default IndexNow key (carry-over, still open)

Static default (`deeperguard-notes-indexnow-8f3a`) served at a public path.
**File refs:** `app/config.py` `INDEXNOW_KEY` 75.

#### L-9 — CSP residual hardening (carry-over, still open; still widened by L-19)

`style-src 'unsafe-inline'`; no app-level `report-to`/`report-uri`; `script-src` remains nonce-based with `'wasm-unsafe-eval'`. Turnstile is now conditional. Google/Dropbox remain unconditional (**L-19**).
**File refs:** `app/auth.py` `content_security_policy()` 754–792.

#### L-12 — systemd units run gunicorn without a service user or sandboxing (carry-over, still open)

All three units omit `User=`/`Group=` and sandboxing directives. Gunicorn stays on `127.0.0.1:80`.
**File refs:** `deploy/systemd/deeperguard.service`, `deeperguard-tls.service`, `deeperguard-ocr.service`.

#### L-16 — Login/register boot handoff stashes derived vault-key bytes in `sessionStorage` (carry-over, still open)

Unchanged family. #155 reuses the stash for empty-vault signup auto-unlock (still requires SRP unlock proof).
**File refs:** `app/static/js/vault-secrets.js`; `app/static/js/store.js` `adoptDerivedVaultKey()`.

#### L-17 — Session cookie can adopt another live same-user row via `X-Device-Id` (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over.** **Unchanged** on `70097dd`. |
| **Impact (one line)** | An already-authenticated request that names another live device id for the same account rotates that row’s token into this cookie, so the other browser’s cookie stops matching. Same-user only; device ids are high-entropy and are not returned by `GET /api/sessions`. |
| **File refs** | `app/auth.py` `_align_session_with_request()` 176–220, `ensure_device_session()` 223–244. |
| **Remediation outline** | Rebound only when the cookie row’s stored `device_id` is empty or already equals the request’s device id. |
| **Needs a code fix?** | Yes. |

#### L-18 — Dropbox OAuth tokens in plaintext `localStorage` (closed this window; residual)

New tokens are written through `setVaultTokenBridge` into encrypted vault settings (`VAULT_ONLY_PREF_KEYS`); `localStorage` keeps only non-secret connection metadata. `lockVault` zeros pref token fields and strips leftover plaintext keys. **Residual:** `loadCachedDropboxToken()` / `refreshDropboxAccessToken()` still *read* legacy `localStorage` tokens until migration runs; module-scope `dropboxAccessToken` is not zeroed by `NotesStore.lock()` itself (only by `lockVault` pref clear + next load).
**File refs:** `app/static/js/cloud-backup.js` `rememberDropboxTokens()` 558–583, `migratePlaintextDropboxTokens()` 528–556, `loadCachedDropboxToken()` 619–633; `app/static/js/app.js` 257–263, 3376–3382, 19583–19611.
**Needs a code fix?** Optional residual only (stop reading prefs tokens; call `clearDropboxTokensLocal` from `lock()`).

#### L-19 — CSP unconditionally allowlists Google GIS and Dropbox on every response (carry-over)

| | |
|---|---|
| **New vs known** | **Carry-over.** Host strings **unchanged**. Turnstile was added **conditionally** (766–773) — do the same for Google/Dropbox. |
| **Impact (one line)** | Every response, including marketing and login, may load scripts from `https://accounts.google.com` and connect to Google / Dropbox API hosts even when those backups are unused. Live `www.deeperguard.com` CSP matches. |
| **File refs** | `app/auth.py` `content_security_policy()` 759–764, 777, 782, 787. |
| **Remediation outline** | Emit Google / Dropbox CSP tokens only when the corresponding env key is non-empty, and only on `/app`. |
| **Needs a code fix?** | Yes. |

#### L-20 — Fake challenge version (original closed; residual)

Fake challenges now return `"srp_kdf_version": 2`, matching new signups. **Residual:** a real leftover v1 account still returns `1` on `/api/auth/srp/challenge` and repair-login challenge, so remaining v1 rows are distinguishable from unknown / v2. Rate-limited; shrinking population.
**File refs:** `app/app.py` 1061–1080, 1189–1201.
**Needs a code fix?** Optional (omit the field until verify, or stop advertising v1).

#### L-21 — Unpaired Turnstile keys fail open (new)

| | |
|---|---|
| **Severity** | Low (misconfiguration footgun) |
| **New vs known** | **New** (#154). |
| **Impact (one line)** | When the site key is set and the secret is empty, the register page shows a widget but `_verify_turnstile_token` returns `ok` and `turnstile_required()` is false, so register is unprotected. When the secret *is* set, verify is fail-closed (missing token / invalid / Cloudflare down). |
| **File refs** | `app/app.py` `_verify_turnstile_token()` 944–952, `api_auth_srp_register()` 1012–1017; `app/config.py` `turnstile_required()` 188–190; `app/templates/register.html` 65–77 (widget keyed on site key only). `deploy/deeperguard.env.example` does not document the pair. |
| **Status** | Vienna CSP includes Turnstile, so a site key is configured there; this is a pairing / fail-open default, not a confirmed live miss. |
| **Remediation outline** | Treat site-without-secret as invalid config (refuse register or refuse to render the widget). Document both keys in `deeperguard.env.example`. |
| **Needs a code fix?** | Yes (small). Ops should keep the keys paired. |

#### L-22 — vault-recovery can rotate the SRP verifier without `totp_ok` (new)

| | |
|---|---|
| **Severity** | Low |
| **New vs known** | The route was already `public_path` on 9c70d94. **Newly material** because #151 made “no verifier replace before TOTP” an explicit control for kdf-upgrade, and vault-recovery still bypasses that gate. |
| **Impact (one line)** | A password-only session (SRP succeeded, TOTP not yet) plus CSRF can POST `/api/auth/vault-recovery` with a stored-verifier proof and install a new v2 salt/verifier, locking the user out of *new* logins without completing 2FA. Vault ciphertext stays sealed. Password change is *not* `public_path` and therefore *is* 2FA-gated. |
| **File refs** | `app/auth.py` `public_path()` 574–580; `_gate()` 2FA allow-list 610–618 (unlock only); `app/app.py` `api_auth_vault_recovery()` 1344–1382 (session + CSRF + stored-verifier proof, then `update_user_srp_verifier`). |
| **Remediation outline** | Drop vault-recovery (and, if unused pre-login, the challenge) from `public_path`, or require `totp_ok` in the handler the same way kdf-upgrade relies on the gate. Keep the stored-verifier proof. |
| **Needs a code fix?** | Yes. |

### Informational

1. **I-1 (carry-over, improved):** Open registration default (`NOTES_ALLOW_REGISTER=1`, default plan `pro`) without requiring email verification for login. **This window:** Turnstile when secret set, honeypot (`company` / `website`), register IP cap default 3/h (was 5). Verification still gates backups.
2. **I-2 (carry-over):** Legacy `/api/auth/login` retained for Argon2-only accounts; `/api/auth/srp/resync` remains for leftover-hash accounts (see L-1). `NOTES_REPAIR_LOGIN_PASSWORD` defaults to `0`.
3. **I-3 (carry-over):** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency; sync item/page caps mitigate.
4. **I-4 (carry-over, improved):** Vendored JS without an automated CVE gate. jsPDF is now 4.2.1; Pillow 13 / Flask 3.1.3 / Werkzeug 3.1.9; pdf.js 4.10.38 ESM unchanged this window.
5. **I-5 (carry-over):** "Remember on this device" password stash — obfuscation against casual inspection only. Extended by L-16.
6. **I-6 (carry-over):** remote sign-out wipe scoped to `revoke_reason == "user"`; empty-cookie fallback to newest session for `X-Device-Id` is unchanged.
7. **I-7 (carry-over):** Deploy still SSHes as root with `StrictHostKeyChecking=accept-new`. `NOTES_HOST` required; tarball excludes `keys/` and `data/`; gunicorn `127.0.0.1:80`; LAN TLS refused when the CIDR gate is open. Manifest rebuild is fail-closed.
8. **I-8 (carry-over, slightly improved):** service worker still caches session-scoped `/app` HTML. `/sw.js` now `must-revalidate`; `/api/*` is not intercepted; API responses stay `no-store`.
9. **I-9 (carry-over):** Deployment `GOOGLE_OAUTH_CLIENT_ID` / `DROPBOX_APP_KEY` are public identifiers. Expected for public OAuth clients.
10. **I-10 (carry-over):** Dropbox popup forwards `window.location.search` via same-origin `postMessage`, then strips the URL. Origin-checked; short-lived.
11. **I-11 (new):** Client integrity is real hardening (SRI + hashed URLs + deploy wipe + optional Sigstore) but is origin-trust, not a third-party attestation of the running tree. `load_manifest()` trusts `client-manifest.json` without recomputing `manifest_sha256`; unhashed `/static/js/*.js` remains reachable; `sw.js` precache lists some unhashed vendor paths; crypto-worker `importScripts` has no SRI (normal for workers). `/verify` copy is honest about unsigned releases.

Contact-form header injection was re-checked and is **not** an issue: visitor name/subject flow into `EmailMessage` headers (`app/mailer.py` `send_contact_email()`), and the default `email.policy` refuses CR/LF in header values.

Positive in this window (not findings): kdf-upgrade bound to current-password proof + 2FA; fake challenges report v2; repair-login prove-only; Dropbox tokens in the vault; monotonic TOTP; Turnstile fail-closed when the secret is set; `/ca.crt` gated; hashed static + SRI; View server copy is ciphertext-only and owner-scoped; empty-vault signup unlock still requires SRP; host-only cookies and post-login `/api/auth/*` narrowing still hold.

---

## Status of previously known open items (requested checklist)

| Item | Status on `70097dd` |
|------|---------------------|
| SRP `A ≡ 0 (mod N)` bypass | **Still fixed** |
| SRP challenge state server-side (C-1, #66) | **Still fixed** |
| Login SRP verifier binding (L-11, #68) | **Still fixed** |
| TOTP setup overwrite (M-3 of 10-13, #68) | **Still fixed** |
| M2 required on client | **Still in place** |
| Ephemeral OCR store | **Still in place** |
| rclone obscure via stdin | **Still in place** |
| Two-phase ZK password change (#63) | **Still in place** (M-3 bypass **closed**) |
| Upload dirs keyed by `user_id` | **Still in place** |
| Auth rate limits | **Still in place**; register IP 3/h; Turnstile when secret set |
| Signup notify | **Still in place** |
| Unbounded backup-verification mail (M-3 of 10-19) | **Still closed** (#96) |
| Unsalted OTP hashes / backup resend / markdown href (L-13–L-15) | **Still closed** (#96) |
| Manual backup-attachment cap (L-10) | **Still closed** (#96) |
| pCloud plaintext passwords | **Still open** (M-1) — awaiting Dennis; **not** accepted |
| Server OCR when enabled | **Still open** (M-2) — defaults safe; off in prod |
| WAN secure-cookie warning-only | **Still open** (L-4) — accepted; Vienna has HSTS |
| systemd unit hardening (L-12) | **Still open** |
| Session rebound via `X-Device-Id` (L-17) | **Still open** — unchanged |
| Dropbox tokens in `localStorage` (L-18) | **Closed** for new connects (#153); residual legacy read |
| CSP Google/Dropbox allowlist (L-19) | **Still open** — unchanged (Turnstile now gated) |
| kdf-upgrade without password proof (M-3 of 10-22) | **Closed (#151)** |
| Fake challenge reports v1 (L-20) | **Closed (#151)**; residual v1 advertisement |
| Broad session cookie domain (L-7) | **Still closed** |

---

## Areas reviewed without new issues

- **Sync/API authorization (IDOR):** item/blob/reminder/session/OCR-job/upload queries remain scoped by authenticated `user_id`. New `GET /api/sync/item/<uuid>` uses `list_items_by_uuid(uid, …)` — cross-account 404, no server decrypt, not a cross-user existence oracle. `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt but still require a session (unlock still requires SRP/legacy proof) and the same-origin gate for POSTs.
- **CSRF/same-origin:** mutating requests require same-origin (`Sec-Fetch-Site`, Origin/Referer host match; bare `same-site` and `Origin: null` rejected); non-exempt authenticated mutations also require the CSRF token (constant-time compare). Public API POSTs still require same-origin. kdf-upgrade is not CSRF-exempt.
- **Headers (live www):** nonce-based `script-src` (plus Google / Dropbox — L-19 — and Turnstile because a site key is configured), `frame-ancestors 'none'`, `object-src 'none'`, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP `same-origin-allow-popups`, CORP `same-origin`, HSTS present, `/api/*` `no-store`.
- **AI relay:** unchanged — fixed `https://ollama.com` upstream, allowlisted fields/paths, 512 KB body cap, key never logged.
- **Admin API:** `/admin` + `/api/admin/*` gated by `user_is_admin()`; env-listed admins still need a verified email.
- **Vault crypto:** Argon2id v2 params aligned (t=3, m=64 MiB, p=2, 32-byte key; AES-256-GCM, random 12-byte IV). `persistLocal()` still wraps before IndexedDB. Empty-vault unlock still requires SRP (signup auto-unlock included).
- **WebAuthn:** origin still configured (`NOTES_WEBAUTHN_ORIGIN`), not Host-derived. User verification remains `PREFERRED` (deferred from #153). Management routes still require session + CSRF + 2FA.
- **Health:** `/api/health` still returns only `ok` / `service` / `build` for anonymous callers, plus public `client_hash`. Extra fields remain admin-session-only.
- **Deploy defaults:** CIDR gate on by default; `NOTES_SKIP_LOGIN` ignored when the gate is open; `NOTES_STRICT_ZK=1`, `NOTES_REPAIR_LOGIN_PASSWORD=0`, `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`, `NOTES_SERVE_CA_CRT=0`, `NOTES_ENABLE_LAN_TLS=0`. `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`. Gunicorn `127.0.0.1:80`. OAuth env keys default empty. `NOTES_HOST` required.
- **Client cloud backups:** still client-only; tokens never sent to the DeeperGuard server; Dropbox PKCE S256 + state; Google `drive.file`; `postMessage` origin-checked; COOP-safe popups; per-user app IDs in vault settings. L-18 closed for new tokens; L-19 / I-9 / I-10 remain.

---

## High / Medium — code fix vs product decision

| ID | Needs |
|----|--------|
| **M-1** | **Product decision**, then code (OAuth-token only, or encrypt at rest). Not accepted as-is. |
| **M-2** | **Product / ops decision.** Keep `NOTES_SERVER_OCR=0`. No code unless it is turned on. |

No new High or Medium. **M-3 is closed** and does not need further product input.

New Lows that need a code fix (not product decisions): **L-21** (pair Turnstile keys), **L-22** (2FA-gate vault-recovery), plus the unchanged **L-17** / **L-19**.

---

## Recommended next steps (priority)

1. **M-1:** owner decision on pCloud password storage (OAuth-token only, or encrypt at rest). Not accepted as-is.
2. **L-17 (code fix):** rebound the cookie only when the cookie row already names this device (or has no device id yet).
3. **L-19 (code fix):** gate Google/Dropbox CSP hosts on configured keys and `/app` only (mirror Turnstile).
4. **L-22 (code fix):** take vault-recovery off `public_path` or require `totp_ok` before verifier replace.
5. **L-21 (code fix):** refuse register (or hide the widget) unless both Turnstile keys are set; document the pair in `deeperguard.env.example`.
6. **L-1 / L-20 residual:** `clear_user_legacy_password()` on SRP upgrade; drop `/api/auth/srp/upgrade` from `public_path`; stop advertising `srp_kdf_version: 1` on challenge.
7. **L-2 / L-16:** TOTP-disable (and passkey-remove) step-up + rate limit; drop or document the boot derived-key stash.
8. **L-3 / L-12:** bind the vault-KDF bump; systemd `User=` + sandboxing (deploy-only).
9. **L-4 / M-2:** product/ops decisions unchanged (WAN warning-only; keep server OCR off).
10. **Optional:** `_revoke_other_sessions` after a real kdf-upgrade; stop reading legacy Dropbox `localStorage` tokens; recompute `manifest_sha256` at load; 404 unhashed `js/`/`css/` in production.

*End of report.*
