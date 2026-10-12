# DeeperGuard Security Review — 2026-10-12

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `3e64e87` (includes PR #57 SRP degenerate-`A` fix, #59 regression tests, #60 server-OCR startup warning, #61 low-severity bundle, #64 SRP M2 / ephemeral OCR / rclone stdin / SRP-upgrade proof, #63 two-phase ZK password change).
**Reviewer:** Cursor Cloud Agent (grok-4.6, high effort) — static code review plus a local Flask test-client cookie-payload inspection. No production access, no live penetration testing.
**Scope:** Server (`app/`), client (`app/static/js/`), service worker (`app/static/sw.js`), templates, deploy scripts and samples (`deploy/`), tests.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

**Model note:** The routine requested Claude Fable 5; that model was unavailable (usage), so this run used grok-4.6 high effort.

Prior dated reviews (`docs/SECURITY-REVIEW-2026-10-02.md` through `2026-10-09.md`) exist only on unmerged draft-PR branches and are **not on `main`**. The most recent of those is [draft PR #62](https://github.com/deeperguard/Deeperguard/pull/62) / `origin/cursor/security-review-2026-10-09-83ce`, which reviewed `main` at `f3de3d2` (after #61, before #63/#64). This document verifies every finding from that report against current `main` and records what is **new** or **still open**.

---

## Executive summary

PRs #63 and #64 landed as described and close the 2026-10-09 **M-1** password-change gap plus four lows: SRP login now requires server `M2`; ephemeral `/api/ocr/store` no longer writes raw bytes; `rclone obscure` takes the password on stdin; `/api/auth/srp/upgrade` requires the current legacy password. The two-phase password-change design (prove → `rotation_token` → commit) is sound **if** the SRP challenge secret stays on the server.

The most significant **new** finding is **C-1**: Flask’s default signed session cookie is **not encrypted**, and SRP challenge state — including the server ephemeral private `b` and the stored verifier `v` — is written into that cookie (`store_srp_state` / `store_srp_credential_challenge`). After `/api/auth/srp/challenge` (and the repair-login / vault-recovery / password-change challenge routes), a caller who can read their own `Set-Cookie` can see those fields without the Flask signing key. Stored-verifier proofs (`step2`) are only binding while `b` remains a server secret; putting it in a client-readable cookie undermines SRP login, repair-login, strict vault-recovery, and the #63 password-change step-up. Encrypted note plaintext stays protected (client-side KDF). Accounts with TOTP still need a second factor after a forged login.

This is the same *class* of issue as the October 8 degenerate-`A` bypass (session without the password, vault still encrypted), on the primary unauthenticated login path.

| Severity | Count |
|----------|------:|
| Critical | 1 |
| High | 0 |
| Medium | 2 |
| Low | 10 |
| Informational | 7 |

### Top findings (current)

1. **C-1 (Critical, new):** SRP server ephemeral `b` (and verifier `v`) travel in Flask’s signed-but-unencrypted session cookie, so stored-verifier proofs are not actually server-secret. (`app/srp_auth.py` `to_private_state()`, `app/auth.py` `store_srp_state` / `store_srp_credential_challenge`, `app/app.py` `DynamicDomainSessionInterface` → `SecureCookieSessionInterface`)
2. **M-1 (Medium, carry-over; was M-2 on 2026-10-09):** pCloud WebDAV passwords still stored in plaintext under `keys/`. The #64 rclone argv leak is **fixed**.
3. **M-2 (Medium misconfiguration, carry-over; was M-3):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe; startup warning and ephemeral-store fix are in place.

---

## Resolved since the 2026-10-09 review (`f3de3d2` → `3e64e87`)

| Prior ID | Topic | Status on `3e64e87` |
|----------|-------|---------------------|
| **M-1** | Password change sent plaintext current/new passwords and stored `hash_password(new)` for SRP accounts | **Fixed** (#63) — `/api/account/password/challenge` + `/prove` + `/password`. SRP prove rejects `current_password`/`account_password`; commit rejects plaintext and accepts only `rotation_token` + new `srp_salt`/`srp_verifier`; `db.clear_user_legacy_password()` runs on SRP commit. Residual leftover hashes from *pre-#63* changes: see **L-1**. |
| **L-1** | Client skipped SRP `M2` when the server omitted it | **Fixed** (#64) — `NotesSrpAuth.login()` throws if `result.M2` is missing, then `step3`. |
| **L-2** | `/api/auth/srp/upgrade` installed a verifier without proving the current password | **Fixed** (#64) — requires `current_password` matching the leftover Argon2 hash; rate-limited (`srp-upgrade`). |
| **L-3** | `/api/ocr/store` wrote raw bytes in ephemeral mode | **Fixed** (#64) — `save_file_only()` returns `{stored: false}` when `ocr_ephemeral()`. |
| **L-4** | No rate limit on authenticated `/api/account/password` | **Fixed** (#63) — challenge/prove/commit share `_auth_rate_limited("account-password", email)`. |
| rclone argv | `rclone obscure` received the password on argv | **Fixed** (#64) — `write_rclone_config()` uses `rclone obscure -` with stdin. |

**Still warning-only (accepted / product):** WAN without Secure cookies (**L-4** below); pCloud plaintext passwords (**M-1**); server OCR when the flag is on (**M-2**).

---

## Findings

### Critical

#### C-1 — SRP challenge private state (`b`, `v`) is stored in Flask’s signed, unencrypted session cookie (new)

| | |
|---|---|
| **Severity** | Critical |
| **Impact (one line)** | A caller who can read the session cookie issued after an SRP challenge learns the server ephemeral private `b` and the stored verifier `v`, so they can satisfy `step2` without the password. That yields a logged-in session (and, on repair-login / password-change, the ability to rotate the stored verifier). Vault ciphertext stays client-side encrypted. |
| **Affected area** | `app/srp_auth.py` `SrpServerSession.to_private_state()` (fields `I`, `v`, `s`, `b`); `app/auth.py` `store_srp_state()`, `store_srp_credential_challenge()`; `app/app.py` `DynamicDomainSessionInterface(SecureCookieSessionInterface)` — Flask 3 signed cookie, not encrypted. Reached by `/api/auth/srp/challenge`, `/api/auth/repair-login/challenge`, `/api/auth/vault-recovery/challenge`, `/api/account/password/challenge`. |
| **Root cause** | RFC 5054 / SRP-6a proofs are binding only while the server ephemeral secret stays on the server. The app correctly binds challenges to the *stored* verifier (#52) and rejects degenerate `A` (#57), but then serializes `{I,v,s,b}` into the client cookie. `itsdangerous` / Flask `SecureCookieSessionInterface` HMAC-signs the payload; the JSON (zlib+base64) is readable without `NOTES_FLASK_SECRET`. |
| **Confirmation (no proof constructed)** | Local Flask test client: after `POST /api/auth/srp/challenge` the `session` cookie payload decoded (no signing key) to `session_keys = ['srp_email', 'srp_state']` and `srp_state` keys `I`, `b`, `s`, `v` (`b` and `v` present, 512 hex chars each). |
| **Why #52 / #57 / #63 are not sufficient** | Those fixes assume `step2` is the only party that knows `b`. A readable cookie gives `b` to the same party that receives `B` and `srp_salt`. The stored-verifier binding and the rotation-token step-up therefore do not hold against a caller who can read their own `Set-Cookie`. TOTP, when enabled, still gates the post-login session (`totp_ok=not totp_required`). |
| **Remediation outline** | Keep SRP private state **server-side only** (e.g. a short-lived row keyed by a random id; cookie holds only the id). Alternatively encrypt the Flask session cookie (custom `SessionInterface`). Do not put `b` or `v` in a client-readable cookie. Add a regression that asserts challenge cookies do not contain `srp_state.b` / `srp_state.v` in decodeable form. **Code fix — clear-cut.** |

---

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext on disk (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Server filesystem compromise exposes users’ pCloud *account* passwords (not vault passwords). |
| **Affected area** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`); `app/backup_pcloud.py` `write_rclone_config()` still writes rclone’s reversibly-obscured `pass=` into `keys/pcloud-rclone-{user_id}.conf`. |
| **Changed since 2026-10-09?** | **Partial:** #64 stopped passing the password on `rclone obscure` argv (stdin). Storage is unchanged. OAuth-token path (`pcloud_token`) still exists and is preferred when present. |
| **Remediation outline** | Drive Settings UX toward rclone OAuth token-only storage; if a WebDAV password must be kept, encrypt it with a server master key. **Product + code.** Owner decision previously recorded as accepted-for-now. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, uploaded documents are decrypted client-side and processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and indexes persist on disk. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_service.py`. |
| **Changed since 2026-10-09?** | Startup warning still in place (#60). Ephemeral `/api/ocr/store` no longer writes raw files (#64). Defaults remain safe (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); `purge_legacy_plaintext_indexes()` still cleans residue. |
| **Remediation outline** | Keep defaults; treat the flag as a documented break-glass. **Mostly product/ops.** |

---

### Low

#### L-1 — Pre-#63 leftover Argon2 hashes on SRP accounts are not migrated (new residual of prior M-1)

- **Impact:** Accounts that changed password through the old `/api/account/password` path still have `password_hash` on file. That re-enables `/api/auth/srp/resync` (plaintext password + leftover hash). A later #63 password change clears the hash; there is no boot-time sweep.
- **Area:** `app/db.py` `user_has_legacy_password()`, `clear_user_legacy_password()` (called only from `api_account_password` SRP commit / strict-ZK legacy upgrade); `app/app.py` `api_auth_srp_resync()`.
- **Remediation:** One-shot migration: `UPDATE users SET password_hash = '' WHERE auth_method = 'srp'`. **Code fix — clear-cut.**

#### L-2 — TOTP disable has no SRP step-up and no dedicated rate limit (new / expanded)

- **Impact:** For SRP accounts, `/api/totp/disable` skips the password check. If TOTP is already on, a valid TOTP code is still required. If TOTP is off, the handler is a no-op aside from clearing secrets. A hijacked session that *also* has a current TOTP code can turn 2FA off without an SRP proof. No `_auth_rate_limited()` on setup/enable/disable.
- **Area:** `app/app.py` `api_totp_disable()`, `api_totp_setup()`, `api_totp_enable()`.
- **Remediation:** Require an SRP proof or rotation token (same pattern as #63) before disable; rate-limit the three TOTP routes. **Code fix.**

#### L-3 — `/api/account/vault-kdf` bumps KDF version with session + CSRF only (new)

- **Impact:** A hijacked session can set `vault_kdf_version` to 2 without proving the vault password. Clients then prefer Argon2id on unlock. Notes remain decryptable if the client still has the password (it will probe), but a forced bump can add unlock friction or confuse mixed-version devices. Not a ciphertext oracle.
- **Area:** `app/app.py` `api_account_vault_kdf()`.
- **Remediation:** Bind the upgrade to an unlock or SRP step-up. **Code fix.**

#### L-4 — WAN exposure without Secure cookies only warns (carry-over, accepted warning-only)

- **Impact:** `NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` still serves session cookies without the Secure flag and omits HSTS. #61 logs a one-time startup warning; `deploy/deeperguard.env.example` documents the pairing. Production tunnel scripts set both flags.
- **Area:** `app/config.py` `log_wan_secure_cookies_startup_warning()`; `app/app.py` `SESSION_COOKIE_SECURE`; `app/auth.py` `security_headers()`.
- **Remediation:** Refuse to start (or require an explicit override env) when the gate is open and Secure cookies are off. **Code fix — clear-cut**; owner previously accepted warning-only.

#### L-5 — Account enumeration on auth endpoints (carry-over)

- **Impact:** `/api/auth/srp/register` returns `409` for existing emails; `/api/auth/srp/challenge` and WebAuthn login options return distinguishable responses (`401 invalid credentials` vs `404 no passkeys registered`).
- **Area:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.
- **Remediation:** Uniform responses/timing or an email-verification signup flow. **Product decision.**

#### L-6 — In-memory, per-process auth rate limits (carry-over)

- **Impact:** Limits reset on restart, are not shared across Gunicorn workers, and are keyed per `ip:endpoint:email`. Cloudflare edge rules (`deploy/setup-cloudflare-rate-limits.sh`) cover `/api/auth/*` only (30/min/IP) — not `/api/account/password/*`.
- **Area:** `app/auth_rate_limit.py`; `deploy/setup-cloudflare-rate-limits.sh`.
- **Remediation:** Document the Cloudflare dependency; add an edge rule for `/api/account/password/*`; optional shared limiter.

#### L-7 — Broad session cookie domain (carry-over)

- **Impact:** Default registrable-domain cookie scope (`.deeperguard.com`) shares sessions with sibling subdomains. HttpOnly still blocks JS reads; the cookie remains domain-scoped (relevant to **C-1** if a sibling can observe `Set-Cookie` / Cookie headers).
- **Area:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py`.
- **Remediation:** Host-only cookies unless subdomain sharing is required.

#### L-8 — Predictable default IndexNow key (carry-over)

- **Impact:** Static default key in `app/config.py` (`deeperguard-notes-indexnow-8f3a`) served at a public path; low risk (search-engine URL ownership claims).
- **Remediation:** Require env override in production.

#### L-9 — CSP residual hardening (carry-over)

- **Impact:** `style-src 'unsafe-inline'`; no `report-to`/`report-uri`; a handful of inline event-handler attributes remain in templates (blocked by the nonce-based `script-src`, but they block tightening `script-src-attr`).
- **Area:** `app/auth.py` `content_security_policy()`; `app/templates/*.html`.
- **Remediation:** Migrate inline handlers, stage with `NOTES_CSP_REPORT_ONLY=1`, tighten `style-src` where feasible.

#### L-10 — Authenticated `/api/backup/email` has no per-endpoint rate limit (carry-over)

- **Impact:** A hijacked session can send the (encrypted) backup attachment to any address via the configured SMTP relay. Outbound-mail abuse, not a vault leak.
- **Area:** `app/app.py` `api_backup_email()`; `app/backup_mail.py`.
- **Remediation:** Per-user/IP rate limit; optionally pin recipient to the account backup email.

---

### Informational

1. **Open registration default** (`NOTES_ALLOW_REGISTER=1`, `NOTES_DEFAULT_PLAN=pro`) without email verification — abuse/spam surface; signup-notify emails are awareness only. (Carry-over.)
2. **Legacy `/api/auth/login`** retained for Argon2-only accounts; rate-limited and refuses SRP accounts. `/api/auth/srp/resync` remains for leftover-hash SRP accounts (see **L-1**). (Carry-over.)
3. **Request body cap** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency. (Carry-over.)
4. **Vendored JS** under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) — no automated CVE gate observed in CI. (Carry-over.)
5. **"Remember on device" / boot-password stashes** (`app/static/js/vault-secrets.js`): the AES-GCM key is stored in the same `localStorage`/`sessionStorage` as the ciphertext, so the scheme is obfuscation against casual inspection, not protection against an attacker who can read client storage. `app.js` `persistDevicePassword()` still has a plaintext `localStorage` fallback if `NotesVaultSecrets` is missing (production always loads the module). Inherent to the opt-in feature.
6. **Deploy pipeline** (`deploy/deploy-deeperguard.sh`): pushes code as `root` over SSH with `StrictHostKeyChecking=accept-new` (trust-on-first-use) to a production IP pinned in the repo. Acceptable for a single-operator setup; pin the host key to remove the TOFU window. Gunicorn remains `127.0.0.1:80`; LAN TLS is refused when the CIDR gate is open.
7. **`crypto-worker.js` `fromB64`** writes `charCodeAt(0)` into every index, so worker-side decrypt is broken and the app falls back to main-thread decrypt. Correctness/perf, not a vault bypass. Not introduced by #63/#64.

---

## Status of previously known open items (requested checklist)

| Item | Status on `3e64e87` |
|------|---------------------|
| SRP step2 `A ≡ 0 (mod N)` bypass (#57) | **Still fixed** (`app/srp_auth.py` `step2()` rejects `A % N == 0`, malformed hex, `u == 0`; `hmac.compare_digest` on M1). |
| OCR startup warning (#60) | **Still in place.** |
| #61 bundle | **Still in place** (upload dirs by `user_id`, minimal public `/api/health`, signup-notify env, rate limits on verify/resync/WebAuthn, fatal M2 on present-but-wrong M2, WAN warning). |
| #64 (M2 required, ephemeral OCR store, rclone stdin, SRP upgrade current password) | **Verified present.** |
| #63 (two-phase ZK password change) | **Verified present** (rotation token hashed + session-bound + 10 min TTL + consume-on-success + constant-time compare; SRP commit clears leftover hash). **Undermined by C-1** until challenge `b` is kept server-side. |
| pCloud plaintext passwords | **Still open** (M-1); argv leak **fixed**. |
| WAN secure-cookie warning-only | **Still open** (L-4); accepted. |
| Server OCR plaintext | **Still a misconfiguration risk** (M-2); defaults safe; ephemeral store gap **fixed**. |

---

## Areas reviewed without material new issues

- **Sync / IDOR:** item, blob, reminder, session, OCR-job, and upload queries in `app/db.py` / `app/ocr_jobs.py` are scoped by authenticated `user_id`; device session tokens are stored hashed.
- **WebAuthn:** challenges session-bound and single-use; registration/authentication verify RP ID and origin; credential ownership checked before verification; login endpoints rate-limited. Residual: login options still enumerate “no passkeys” (**L-5**).
- **CSRF / same-origin:** mutating requests require same-origin (`Sec-Fetch-Site` with Origin/Referer fallback; `same-site` alone rejected). Non-exempt authenticated mutations also require the CSRF token. `/api/auth/*` is public-path (no CSRF) by design; same-origin still applies to POST. `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt and still require a session + same-origin.
- **CSP / headers:** enforced nonce-based CSP, `frame-ancestors 'none'`, nosniff, HSTS when Secure cookies are on; service worker never intercepts `/api/*`.
- **AI relay / pCloud SSRF:** fixed upstream hosts, allowlisted fields/paths; rclone invoked with argument lists, no shell.
- **Vault crypto:** Argon2id v2 aligned between `app/vault_crypto.py` and `app/static/js/crypto.js`; `notes_kdf_cache` still stores only salt/version/encoding (no raw key, no `fp`).
- **Deploy defaults:** Gunicorn on `127.0.0.1:80`; `NOTES_SKIP_LOGIN` ignored when the CIDR gate is disabled; LAN TLS off by default and refused when the CIDR gate is open; deploy tarball excludes `keys/` and `data/`; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`.

---

## Misconfiguration risks (dangerous flags)

| Flag | Default | Risk if changed |
|------|---------|-----------------|
| `NOTES_REPAIR_LOGIN_PASSWORD` | `0` | `1` re-enables server-side plaintext password on repair-login. |
| `NOTES_STRICT_ZK` | `1` | `0` re-enables server vault verification — vault passwords processed on server. |
| `NOTES_SERVER_OCR` | `0` | `1` — see M-2 (startup warning logged). |
| `NOTES_OCR_EPHEMERAL` | `1` | `0` persists OCR plaintext on disk (warning logged when server OCR is on). |
| `NOTES_SKIP_LOGIN` | `0` | `1` auto-login first user; ignored when CIDR gate disabled. |
| `NOTES_DISABLE_CIDR_GATE` | `0` | `1` WAN exposure — pair with `NOTES_SECURE_COOKIES=1` (L-4; warning logged). |
| `NOTES_SECURE_COOKIES` | `0` | Must be `1` for WAN/HTTPS production (enables HSTS). |
| `NOTES_ENABLE_LAN_TLS` | `0` | `1` exposes Gunicorn on `0.0.0.0:443` — intended for LAN only; installer refuses it when the CIDR gate is open. |
| `NOTES_GEOIP` | `0` | `1` sends client IPs to a third-party geolocation API over HTTPS. |

---

## Recommended next steps (priority)

1. **C-1:** Move SRP private state (`b`, `v`) out of the Flask cookie — server-side challenge store or encrypted session cookie. This is the only Critical item and it also restores the intended strength of #52 / #63.
2. **L-1:** Clear leftover `password_hash` rows on existing SRP accounts.
3. **L-2 / L-3 / L-10:** TOTP disable step-up + rate limits; bind vault-KDF upgrade; rate-limit backup email (and consider a Cloudflare rule for `/api/account/password/*`).
4. **M-1:** Product decision on pCloud WebDAV passwords vs OAuth-token-only.
5. **L-4:** Product decision on hard-fail vs warning when WAN is open without Secure cookies (currently accepted as warning-only).

---

*End of report.*
