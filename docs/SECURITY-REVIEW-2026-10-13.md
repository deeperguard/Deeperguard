# DeeperGuard Security Review — 2026-10-13

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `f345793` (includes PR #57 SRP degenerate-`A` fix, #59 regression tests, #60 server-OCR startup warning, #61 low-severity bundle, #64 SRP M2 / ephemeral OCR / rclone stdin / SRP-upgrade proof, #63 two-phase ZK password change, **#66 server-side SRP challenge store**).
**Reviewer:** Cursor Cloud Agent — static code review plus local Flask test-client checks (cookie payload after challenge; TOTP setup overwrite; leftover Argon2 hash after SRP upgrade). No production access, no live penetration testing.
**Scope:** Server (`app/`), client (`app/static/js/`), service worker (`app/static/sw.js`), templates, deploy scripts and samples (`deploy/`), tests.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept, payloads, or attack procedures are included.

Prior dated reviews exist only on unmerged draft-PR branches and are **not on `main`**. The most recent is [draft PR #65](https://github.com/deeperguard/Deeperguard/pull/65) / `docs/SECURITY-REVIEW-2026-10-12.md`, which reviewed `main` at `3e64e87` (after #63/#64, before #66). This document verifies every finding from that report against current `main`, verifies that **#66 closes C-1 soundly**, and records what is **new** or **still open**.

---

## Executive summary

PR #66 landed as described and **closes the 2026-10-12 Critical (C-1)**. SRP private state (`b`, `v`, salt, identity) now lives in SQLite table `srp_challenges`. The Flask session cookie holds only a random `secrets.token_urlsafe(32)` id (`srp_login_challenge_id` or `srp_cred_challenge_id`). Local test-client inspection after `POST /api/auth/srp/challenge` shows session keys `srp_login_challenge_id` / `uid` / `sid` / flags — **no** `srp_state`, and no nested `b`/`v`. Regression tests in `tests/test_srp_server_challenge.py` pass (cookie payload, reuse, expiry, cross-purpose, cross-account, legacy ignore, shared-DB reconnect). The #63 password-change step-up and the #52 stored-verifier binding now hold against a caller who can read their own `Set-Cookie`.

No new Critical or High issues were found. Carry-over Medium items (pCloud plaintext WebDAV passwords; server OCR when enabled) are unchanged. One **new Medium** that earlier reviews did not record: `/api/totp/setup` overwrites an already-enabled TOTP secret and sets `totp_enabled=0` without a current-code or password check, so a post-2FA stolen session can drop or replace 2FA.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 11 |
| Informational | 7 |

### Top findings (current)

1. **M-1 (Medium, carry-over):** pCloud WebDAV passwords still stored in plaintext under `keys/`. The #64 rclone argv leak remains **fixed**.
2. **M-2 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext; defaults remain safe.
3. **M-3 (Medium, new / previously unreviewed):** `/api/totp/setup` disables and rotates an already-enabled TOTP secret without a current-code or password step-up.

---

## #66 verification (C-1 close)

The 2026-10-12 C-1 was: Flask’s signed session cookie is not encrypted, and `SrpServerSession.to_private_state()` (`I`, `v`, `s`, `b`) was written into that cookie, so a caller who could read `Set-Cookie` after `/api/auth/srp/challenge` (or the repair-login / vault-recovery / password-change challenge routes) learned the server ephemeral private `b` and the stored verifier `v`.

### What #66 changed

| Piece | Current behavior |
|-------|------------------|
| Store | `auth.store_srp_state()` / `store_srp_credential_challenge()` call `db.create_srp_challenge()` and put only the id in the session (`SESSION_SRP_LOGIN_CHALLENGE` / `SESSION_SRP_CRED_CHALLENGE`). |
| Id | `secrets.token_urlsafe(32)` (256-bit). |
| Table | `srp_challenges` (`id`, `purpose`, `user_id`, `email`, `state_json`, `srp_salt`, `srp_verifier`, `created_at`, `expires_at`), created in `init_schema()`. |
| TTL | 300 seconds (`SRP_CHALLENGE_TTL_SECONDS`); `prune_srp_challenges()` on each create. |
| Consume | `consume_srp_challenge()` `DELETE … RETURNING` (single use on every attempt, success or failure). Then checks purpose, `user_id`, email, and (for credential challenges) current salt/verifier. |
| Purposes | `login`, `repair-login`, `vault-recovery`, `password-change` — must match on consume. |
| Legacy | If `srp_state` / `srp_cred_state` appear in the session they are cleared and ignored; client must request a fresh challenge. |
| SQLite | WAL + `PRAGMA foreign_keys=ON`; workers share the file (reconnect test covers a new connection seeing the row). |

`to_private_state()` still serializes `b`/`v`, but that dict now goes only into `state_json` on the server. The Flask cookie is still signed-not-encrypted; it no longer carries those fields.

### Why the design is sound

- Completing `step2` still requires the password (or an equivalent proof). Reading `Set-Cookie` after a challenge yields only an opaque id, which is useless without `b`.
- Cross-purpose reuse fails: a repair-login challenge id cannot satisfy `/api/auth/srp/verify` (`purpose=login`).
- Cross-account reuse fails: consume binds `user_id` + email.
- Credential challenges (repair-login, vault-recovery, password-change) also bind the **current** stored salt/verifier, so a rotated verifier invalidates an outstanding cred challenge.
- `login_user()` still `session.clear()`s, so a successful login drops the challenge id from the cookie.
- `#52` / `#57` / `#63` assumptions (`b` is a server secret; stored-verifier proofs are binding) now hold.

### Residuals of #66 (not a reopen of C-1)

- **Login path does not re-bind current stored `v`** (see **L-11**). A login challenge issued just before a password change can still complete against the *old* verifier until TTL (5 minutes). Credential-challenge paths *do* re-bind.
- Purpose / email / user_id are checked **after** the row is deleted. A mismatched consume burns the challenge. That is the intended single-use behavior.
- In-flight `state_json` (including `b`) is plaintext in SQLite for up to 5 minutes. That is expected server-side state; `v` is already in `users`. Encrypted note backups (`user-{id}-*.enc.json.gz`) do not include this table.
- There is no per-user cap on outstanding challenge rows. Creation is rate-limited (`srp-challenge` / `repair-login` / `account-password` / `vault-recovery`). Rows expire in 5 minutes.

**Verdict:** C-1 is **fixed**. The #66 design matches the remediation outlined on 2026-10-12. No Critical or High defect was found in the new store.

---

## Resolved since the 2026-10-12 review (`3e64e87` → `f345793`)

| Prior ID | Topic | Status on `f345793` |
|----------|-------|---------------------|
| **C-1** | SRP `b` / `v` in signed, unencrypted session cookie | **Fixed** (#66) — server-side `srp_challenges` table; cookie holds only a random id. Local cookie/session inspection and `tests/test_srp_server_challenge.py` confirm no private SRP fields in the cookie. |
| **M-1** (10-12) | pCloud plaintext WebDAV passwords | **Still open** (this review **M-1**). |
| **M-2** (10-12) | Server OCR when enabled | **Still open** (this review **M-2**). |

PRs #57 / #59 / #60 / #61 / #63 / #64 remain in place (see checklist below). The only application commit since the last review is #66.

---

## Findings

### Critical

None.

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext on disk (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Server filesystem compromise exposes users’ pCloud *account* passwords (not vault passwords). |
| **Affected area** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`); `app/backup_pcloud.py` `write_rclone_config()` still writes rclone’s reversibly-obscured `pass=` into `keys/pcloud-rclone-{user_id}.conf`. |
| **Changed since 2026-10-12?** | **No.** #64 stdin fix for `rclone obscure` is still present (`rclone obscure -`). OAuth-token path (`pcloud_token`) still exists and is preferred when present. |
| **Remediation outline** | Drive Settings UX toward rclone OAuth token-only storage; if a WebDAV password must be kept, encrypt it with a server master key. **Product + code.** Owner decision previously recorded as accepted-for-now. |

#### M-2 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, uploaded documents are decrypted client-side and processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and indexes persist on disk. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_service.py`. |
| **Changed since 2026-10-12?** | **No.** Startup warning still in place (#60). Ephemeral `/api/ocr/store` still returns `{stored: false}` and does not write raw bytes (`ocr_index.save_file_only()`). Defaults remain safe (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); `purge_legacy_plaintext_indexes()` still runs when ephemeral is on. Job lookup is scoped by `user_id` (`ocr_jobs.get_job()`). |
| **Remediation outline** | Keep the default off. If server OCR must exist, treat it as a non-ZK feature in product copy and refuse `NOTES_OCR_EPHEMERAL=0` on WAN. **Product + already-warned default.** |

#### M-3 — `/api/totp/setup` disables and rotates an already-enabled TOTP secret (new / previously unreviewed)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | A caller with a post-2FA session can call setup again: the server writes a **new** secret with `totp_enabled=0`, so 2FA is off and the caller now holds the replacement secret. |
| **Affected area** | `app/app.py` `api_totp_setup()` (always `totp_mod.new_secret()` + `db.update_user_totp(..., enabled=False)`); `app/db.py` `update_user_totp()`. `_gate` allows `/api/totp/setup` only when `totp_ok` is already true if 2FA is on — so this is persistence after session theft, not a login bypass. |
| **Confirmation (no proof constructed)** | Local Flask test client: after enable, `totp_enabled` was true; a second `POST /api/totp/setup` returned 200, `totp_enabled` became false, and `totp_secret` equaled the new secret from the response (different from the first). |
| **Relation to prior L-2** | Prior L-2 is `/api/totp/disable`, which still requires a current TOTP code. Setup is worse: no current code and no password. Distinct finding. |
| **Remediation outline** | Reject setup when `totp_enabled` is already true (user must disable first). Optionally require a current TOTP code or SRP step-up before issuing a new secret. **Code fix — clear-cut.** |

### Low

#### L-1 — Leftover Argon2 hashes on some SRP accounts (carry-over)

- **Impact:** `/api/auth/srp/upgrade` installs a verifier but does **not** call `clear_user_legacy_password()`, so the leftover hash remains and `/api/auth/srp/resync` still accepts the plaintext password. Pre-#63 password changes that stored `hash_password(new)` are also uncleared unless the user has since completed the #63 commit path. New SRP registrations start with `password_hash=''`. `deploy/set-account-password.py` **writes a new leftover hash** after updating the SRP verifier (operator tool, not an API).
- **Area:** `app/db.py` `upgrade_user_to_srp()`; `app/app.py` `api_auth_srp_upgrade()`; `deploy/set-account-password.py`.
- **Remediation:** Clear leftover hashes after a successful upgrade (or a one-shot migration); stop the admin helper from re-adding a hash on SRP accounts. **Code fix.**

#### L-2 — TOTP disable has no password step-up for SRP accounts and no rate limit (carry-over)

- **Impact:** For `auth_method == srp`, `/api/totp/disable` skips the password check and only requires a TOTP code (when enabled). No per-endpoint rate limit. A stolen post-2FA session plus one intercepted code can turn 2FA off. Weaker than **M-3** (setup needs no code).
- **Area:** `app/app.py` `api_totp_disable()`.
- **Remediation:** Require an SRP proof (or current TOTP + rate limit) before disable. **Code fix.**

#### L-3 — Vault-KDF upgrade is unbound (carry-over)

- **Impact:** Authenticated `POST /api/account/vault-kdf` with `vault_kdf_version=2` bumps the stored version without an unlock or SRP step-up. Other devices that have not re-derived v2 will fail to unlock until they upgrade. Not a ciphertext oracle.
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

- **Impact:** Limits reset on restart and are keyed per `ip:endpoint:email`. Production gunicorn is `--workers 1 --threads 4`, so workers do not split the limiter today; a restart still clears buckets. Cloudflare edge rules (`deploy/setup-cloudflare-rate-limits.sh`) cover `/api/auth/*` only (30/min/IP) — not `/api/account/password/*` or `/api/totp/*`.
- **Area:** `app/auth_rate_limit.py`; `deploy/setup-cloudflare-rate-limits.sh`.
- **Remediation:** Document the Cloudflare dependency; add an edge rule for `/api/account/password/*` and `/api/totp/*`; optional shared limiter.

#### L-7 — Broad session cookie domain (carry-over)

- **Impact:** Default registrable-domain cookie scope (`.deeperguard.com`) shares sessions with sibling subdomains. HttpOnly still blocks JS reads. After #66 this no longer leaks SRP `b`/`v` to a sibling that can observe `Set-Cookie`.
- **Area:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py`.
- **Remediation:** Host-only cookies unless subdomain sharing is required.

#### L-8 — Predictable default IndexNow key (carry-over)

- **Impact:** Static default key in `app/config.py` (`deeperguard-notes-indexnow-8f3a`) served at a public path; low risk (search-engine URL ownership claims).
- **Remediation:** Require env override in production.

#### L-9 — CSP residual hardening (carry-over)

- **Impact:** `style-src 'unsafe-inline'`; no `report-to`/`report-uri`; at least one inline `onclick` remains in `app/templates/app.html` (blocked by the nonce-based `script-src`, but it blocks tightening `script-src-attr`).
- **Area:** `app/auth.py` `content_security_policy()`; `app/templates/app.html`.
- **Remediation:** Migrate inline handlers, stage with `NOTES_CSP_REPORT_ONLY=1`, tighten `style-src` where feasible.

#### L-10 — Authenticated `/api/backup/email` has no per-endpoint rate limit (carry-over)

- **Impact:** A hijacked session can send the (encrypted) backup attachment to any address via the configured SMTP relay. Outbound-mail abuse, not a vault leak.
- **Area:** `app/app.py` `api_backup_email()`; `app/backup_mail.py`.
- **Remediation:** Per-user/IP rate limit; optionally pin recipient to the account backup email.

#### L-11 — Login SRP consume does not re-bind the current stored verifier (new residual of #66)

- **Impact:** `pop_srp_state()` / login `consume_srp_challenge()` check purpose + email + `user_id` only. `state_json` keeps the verifier from challenge time. After a password change, an already-issued login challenge can still complete against the **old** verifier until the 5-minute TTL. Repair-login / vault-recovery / password-change consumes *do* pass current salt/verifier and fail after rotation.
- **Area:** `app/auth.py` `pop_srp_state()`; `app/app.py` `api_auth_srp_verify()`; `app/db.py` `consume_srp_challenge()`.
- **Remediation:** Pass current `srp_salt` / `srp_verifier` into login consume (same as credential challenges), or delete outstanding `purpose=login` rows when the verifier is rotated. **Code fix.**

---

### Informational

1. **Open registration default** (`NOTES_ALLOW_REGISTER=1`, `NOTES_DEFAULT_PLAN=pro`) without email verification — abuse/spam surface; signup-notify emails are awareness only. (Carry-over.)
2. **Legacy `/api/auth/login`** retained for Argon2-only accounts; rate-limited and refuses SRP accounts. `/api/auth/srp/resync` remains for leftover-hash SRP accounts (see **L-1**). (Carry-over.)
3. **Request body cap** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency. (Carry-over.)
4. **Vendored JS** under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) — no automated CVE gate observed in CI. (Carry-over.)
5. **"Remember on device" / boot-password stashes** (`app/static/js/vault-secrets.js`): the AES-GCM key is stored in the same `localStorage`/`sessionStorage` as the ciphertext, so the scheme is obfuscation against casual inspection, not protection against an attacker who can read client storage. `app.js` `persistDevicePassword()` still has a plaintext `localStorage` fallback if `NotesVaultSecrets` is missing (production always loads the module). Inherent to the opt-in feature.
6. **Deploy pipeline** (`deploy/deploy-deeperguard.sh`): pushes code as `root` over SSH with `StrictHostKeyChecking=accept-new` (trust-on-first-use) to a production IP pinned in the repo. Acceptable for a single-operator setup; pin the host key to remove the TOFU window. Gunicorn remains `127.0.0.1:80`; LAN TLS is refused when the CIDR gate is open.
7. **`crypto-worker.js` `fromB64`** writes `charCodeAt(0)` into every index, so worker-side decrypt is broken and the app falls back to main-thread decrypt. Correctness/perf, not a vault bypass. Not introduced by #66.

---

## Status of previously known open items (requested checklist)

| Item | Status on `f345793` |
|------|---------------------|
| SRP step2 `A ≡ 0 (mod N)` bypass (#57) | **Still fixed** (`app/srp_auth.py` `step2()` rejects `A % N == 0`, malformed hex, `u == 0`; `hmac.compare_digest` on M1). Tests in `tests/test_srp_auth.py` pass. |
| OCR startup warning (#60) | **Still in place.** |
| #61 bundle | **Still in place** (upload dirs by `user_id`, minimal public `/api/health`, signup-notify env, rate limits on verify/resync/WebAuthn, fatal M2 on present-but-wrong M2, WAN warning). |
| #64 (M2 required, ephemeral OCR store, rclone stdin, SRP upgrade current password) | **Verified present.** Client `NotesSrpAuth.login()` still throws if `result.M2` is missing. |
| #63 (two-phase ZK password change) | **Verified present** (rotation token hashed + session-bound + 10 min TTL + consume-on-success + constant-time compare; SRP commit clears leftover hash). **No longer undermined by C-1.** |
| #66 (SRP challenge state server-side) | **Verified sound** — see “#66 verification” above. |
| pCloud plaintext passwords | **Still open** (M-1); argv leak **fixed**. |
| WAN secure-cookie warning-only | **Still open** (L-4); accepted. |
| Server OCR plaintext | **Still a misconfiguration risk** (M-2); defaults safe; ephemeral store gap **fixed**. |

---

## Areas reviewed without material new issues

- **Sync / IDOR:** item, blob, reminder, session, OCR-job, and upload queries in `app/db.py` / `app/ocr_jobs.py` are scoped by authenticated `user_id`; device session tokens are stored hashed; upload dirs are keyed by `user_id`.
- **WebAuthn:** challenges session-bound and single-use; registration/authentication verify RP ID and origin; credential ownership checked before verification; login endpoints rate-limited. Residual: login options still enumerate “no passkeys” (**L-5**); remove/register have no extra step-up (same class as prior TOTP L-2, not newly worse than setup **M-3**).
- **CSRF / same-origin:** mutating requests require same-origin (`Sec-Fetch-Site` with Origin/Referer fallback; `same-site` alone rejected). Non-exempt authenticated mutations also require the CSRF token. `/api/auth/*` is public-path (no CSRF) by design; same-origin still applies to POST. `/api/sync/pull` and `/api/account/unlock` remain CSRF-exempt and still require a session + same-origin.
- **CSP / headers:** enforced nonce-based CSP, `frame-ancestors 'none'`, nosniff, HSTS when Secure cookies are on; service worker never intercepts `/api/*` (`isApi()`).
- **AI relay / pCloud SSRF:** fixed upstream hosts, allowlisted fields/paths; rclone invoked with argument lists, no shell; `rclone obscure` still uses stdin.
- **Vault crypto:** Argon2id v2 aligned between `app/vault_crypto.py` and `app/static/js/crypto.js`; `notes_kdf_cache` still stores only salt/version/encoding (no raw key, no `fp`).
- **Sessions after #66:** remaining cookie keys are `uid` / `authed` / `exp` / `totp_ok` / `csrf` / `sid` / optional `pw_rotation` (SHA-256 of the rotation token, not the password) / WebAuthn ceremony nonces / challenge ids. No TOTP secrets, vault keys, verifiers, or SRP `b`/`v` in the cookie.
- **Deploy defaults:** Gunicorn on `127.0.0.1:80`; `NOTES_SKIP_LOGIN` ignored when the CIDR gate is disabled; LAN TLS off by default and refused when the CIDR gate is open; deploy tarball excludes `keys/` and `data/`; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`.
- **Admin API:** `/api/admin/*` and `/admin` gated by `user_is_admin()`; cannot remove own admin or delete own account; env-locked admins cannot be demoted in the UI. Overview exposes account metadata, not vault plaintext.
- **Public `/api/health`:** still minimal (`ok` / `service` / `build`); extra disk/DB/OCR fields only for an authenticated admin.

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

1. **M-3:** Reject `/api/totp/setup` when TOTP is already enabled; require disable (with step-up) first.
2. **L-1 / L-2 / L-3 / L-10 / L-11:** Clear leftover hashes; TOTP disable step-up + rate limits; bind vault-KDF upgrade; rate-limit backup email; re-bind login consume to the current stored verifier.
3. **M-1:** Product decision on pCloud WebDAV passwords vs OAuth-token-only.
4. **L-4:** Product decision on hard-fail vs warning when WAN is open without Secure cookies (currently accepted as warning-only).

---

*End of report.*
