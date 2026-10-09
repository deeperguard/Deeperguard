# DeeperGuard Security Review — 2026-10-09

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `f3de3d2` (includes PR #57 SRP degenerate-`A` fix, PR #59 regression tests, PR #60 server-OCR startup warning, PR #61 low-severity bundle).
**Reviewer:** Cursor Cloud Agent — static code review, no production access, no live penetration testing.
**Scope:** Server (`app/`), client (`app/static/js/`), service worker (`app/static/sw.js`), templates, deploy scripts and samples (`deploy/`), tests.
**Nature:** **Report-only.** This PR adds this document only; no application behavior, configuration, secrets, or deployment was changed. No exploit proofs-of-concept or attack procedures are included.

This review follows the 2026-10-08 report (`docs/SECURITY-REVIEW-2026-10-08.md` on the branch of [draft PR #56](https://github.com/deeperguard/Deeperguard/pull/56), reviewing `main` at `149aace`; that document is not yet merged to `main`). It verifies the status of every finding from that report against the current code and records what is **new** or **still open**.

---

## Executive summary

The fixes merged since the last review landed as described: SRP `step2()` now rejects degenerate client public values and compares proofs in constant time (#57, with endpoint regression tests in #59); per-user upload directories are keyed by stable `user_id` with an idempotent migration (#61); the public `/api/health` payload is minimal; the hardcoded signup-notify recipient is gone; IP geolocation is opt-in over HTTPS; SRP verify/resync and WebAuthn login are rate-limited; and startup warnings now fire for server-side OCR (#60) and for WAN exposure without Secure cookies (#61). The security-relevant test suites (`tests/test_srp_auth.py`, auth/session/upload tests in `tests/test_app.py`) pass on this commit.

Note on the 2026-10-08 report: its **L-10** (`step2()` accepting `A ≡ 0 (mod N)`) was in fact an **authentication-bypass class issue**, not a marginal hardening gap — a degenerate client public value forces a predictable shared secret. It was fixed by PR #57 before any known exploitation; it is recorded here as resolved, with severity corrected retroactively.

The most significant **new** finding is **M-1**: the vault password-change flow sends the current **and** new password in plaintext (inside TLS) to `/api/account/password`, and for SRP (strict-ZK) accounts the server then **stores an Argon2 hash of the new vault password**, re-creating a server-side password credential for accounts whose vault secrecy is supposed to be client-only.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 10 |
| Informational | 7 |

### Top findings (current)

1. **M-1 (Medium, new):** password change breaks strict zero-knowledge — plaintext current/new password sent to the server and a crackable hash of the new vault password stored for SRP accounts. (`app/static/js/store.js`, `app/app.py`)
2. **M-2 (Medium, carry-over):** pCloud WebDAV passwords stored in plaintext under `keys/`; password also passed as a process argument to `rclone obscure`. (`app/config.py`, `app/backup_pcloud.py`)
3. **M-3 (Medium misconfiguration, carry-over):** server-side OCR (`NOTES_SERVER_OCR=1`) processes document plaintext on the server; startup warning now in place (#60), defaults remain safe.

---

## Resolved since the 2026-10-08 review

| Prior ID | Topic | Status on `f3de3d2` |
|----------|-------|---------------------|
| **M-1** | Distinct emails could share one upload directory | **Fixed** (#61) — `app/uploads.py` keys directories by `user_id`; `migrate_email_named_upload_dirs()` moves legacy email-named folders and refuses ambiguous (multi-match) migrations; `purge_user_data()` removes only the `user_id` tree. |
| **L-1** | Public `/api/health` information disclosure | **Fixed** (#61) — public payload is `ok`/`service`/`build` only; DB size, disk, OCR queue, and registration flag require an admin session. |
| **L-4** | Session IP geolocation via third-party plain HTTP | **Fixed** (#61) — Cloudflare `CF-IPCity`/`CF-IPCountry` preferred; fallback lookup is HTTPS and off by default (`NOTES_GEOIP=0`). |
| **L-6** | Client ignored SRP mutual-auth (M2) failure | **Mostly fixed** (#61) — `step3(M2)` failure now throws and aborts login. Residual: the check runs only when the server returns `M2` (see **L-1** below). |
| **L-7** | Hardcoded default signup-notify recipient | **Fixed** (#61) — `admin_notification_recipients()` defaults to empty; startup log when unset. |
| **L-10** | `step2()` accepted `A ≡ 0 (mod N)` | **Fixed** (#57) — rejects `A % N == 0`, malformed hex, and `u == 0`; severity retroactively raised to authentication-bypass class (see executive summary). Regression tests in `tests/test_srp_auth.py` and endpoint tests in #59. |
| **L-11** | Non-constant-time `M1` comparison | **Fixed** (#57) — `hmac.compare_digest` on normalized digests; session state no longer mutated before proof validation. |
| **L-12** | No rate limits on SRP verify/resync and WebAuthn login | **Fixed** (#61) — `_auth_rate_limited()` wraps `/api/auth/srp/verify`, `/api/auth/srp/resync`, `/api/auth/webauthn/login/options`, `/api/auth/webauthn/login/verify`. |

**Partially addressed:** prior **M-3** (WAN exposure without Secure cookies) now logs a one-time startup warning (#61) but does not change behavior; carried below as **L-5** with a recommendation to hard-fail. Prior **M-4** (server-side OCR) gained a startup warning (#60); carried below as **M-3** because the misconfiguration impact is unchanged when the flag is enabled.

---

## Findings

### Medium

#### M-1 — Password change sends plaintext passwords to the server and re-creates a server-side hash for strict-ZK accounts (new)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | On every vault password change, the current and new vault passwords transit the server in request plaintext (inside TLS), and for SRP accounts the server stores an Argon2 hash of the **new vault password** — so a server/DB compromise yields an offline-crackable credential for the vault password of any account that ever changed its password, undermining the strict-ZK guarantee that vault passwords never reach the server. |
| **Affected area** | Client: `app/static/js/store.js` `changePassword()` (sends `current_password`, `new_password`, optionally `account_password`). Server: `app/app.py` `api_account_password()` — `_account_login_password_ok()` computes the SRP verifier from the submitted plaintext, and `if len(new) >= 8: db.update_user_password(uid, hash_password(new))` persists a legacy hash even for `auth_method == "srp"` accounts. |
| **Root cause** | The password-change flow predates the strict-ZK login path and still uses password-equivalence checks server-side instead of an SRP step-up proof. Storing `hash_password(new)` also flips `user_has_legacy_password()` to true, which re-enables the plaintext-password `/api/auth/srp/resync` path for the account. |
| **Remediation outline** | For SRP accounts: verify the current password with the existing stored-verifier SRP step-up (`_stored_srp_challenge()` / `_verify_stored_srp_proof()`, already used by repair-login and vault-recovery), accept only the new `srp_salt`/`srp_verifier` (never `new_password`), and stop writing `hash_password(new)`. Optionally add a migration that clears leftover legacy hashes from SRP accounts that acquired one via this flow. **Code fix — clear-cut** (client + server; the server-side SRP step-up building blocks already exist). |

#### M-2 — pCloud passwords stored in plaintext on disk (carry-over)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud account passwords (not vault passwords). |
| **Affected area** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`); `app/backup_pcloud.py` `write_rclone_config()` additionally passes the password as a command-line argument to `rclone obscure` (briefly visible in the process table) and writes the reversibly-obscured value into `keys/pcloud-rclone-{user_id}.conf`. |
| **Changed since 2026-10-08?** | No. The OAuth-token path (`pcloud_token`) exists and is preferred when present. |
| **Remediation outline** | Drive the UX toward rclone OAuth token-only storage; if WebDAV passwords must be kept, encrypt them with a server master key and feed `rclone obscure` via stdin instead of argv. **Product + code.** |

#### M-3 — Server-side OCR exposes document plaintext when enabled (carry-over, misconfiguration)

| | |
|---|---|
| **Severity** | Medium (misconfiguration; default off) |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, uploaded documents are decrypted client-side and processed as plaintext on the server; with `NOTES_OCR_EPHEMERAL=0`, extracted text and indexes persist on disk. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`; `app/ocr_service.py`. |
| **Changed since 2026-10-08?** | Improved awareness: `log_server_ocr_startup_warning()` (#60) logs at startup, with stronger text when WAN-exposed and a separate note when plaintext is persisted. Defaults remain safe (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); `purge_legacy_plaintext_indexes()` cleans legacy residue. See **L-3** for an ephemeral-mode gap inside this feature. |
| **Remediation outline** | Keep defaults; treat the flag as a documented break-glass. **Mostly product/ops** — warning now implemented. |

---

### Low

#### L-1 — Client skips SRP mutual authentication when the server omits `M2` (new; residual of prior L-6)

- **Impact:** `login()` in `app/static/js/srp-auth.js` runs `client.step3(result.M2)` only inside `if (result.M2)`. A rogue or impersonating server that simply omits the `M2` field completes login without ever proving knowledge of the verifier, which is exactly the scenario mutual auth exists to detect. (A wrong `M2` now correctly aborts.)
- **Area:** `app/static/js/srp-auth.js` `login()`.
- **Remediation:** Treat a missing `M2` the same as a failed `step3()` — abort and clear session state. **Code fix — clear-cut.**

#### L-2 — `/api/auth/srp/upgrade` sets SRP credentials with a session only (new)

- **Impact:** For legacy accounts that have not yet upgraded to SRP (`user_has_srp()` false), a hijacked authenticated session can install an attacker-chosen `srp_salt`/`srp_verifier` without proving knowledge of the current password, gaining a durable login credential. Vault contents remain protected by client-side encryption. Scope shrinks as legacy accounts disappear.
- **Area:** `app/app.py` `api_auth_srp_upgrade()`.
- **Remediation:** Require proof of the current password (legacy hash check, which these accounts have by definition) before accepting the new verifier. **Code fix — clear-cut.**

#### L-3 — `/api/ocr/store` writes raw document bytes to disk even in ephemeral mode (new; only with server OCR enabled)

- **Impact:** When `NOTES_SERVER_OCR=1` and `NOTES_OCR_EPHEMERAL=1`, `save_file_only()` still writes the uploaded plaintext document to `uploads/<user_id>/ocr/<att_id>/file` for the offline OCR queue. The file is deleted after a subsequent OCR job processes that `att_id`, but if no job follows, the plaintext remains on disk indefinitely despite the "ephemeral" setting.
- **Area:** `app/ocr_index.py` `save_file_only()`; caller `app/app.py` `api_ocr_store()`.
- **Remediation:** In ephemeral mode, keep queued bytes in memory (the job queue already holds them) or add a TTL sweep that removes orphaned `file` entries. **Code fix.**

#### L-4 — No rate limit on authenticated password verification in `/api/account/password` (new)

- **Impact:** A hijacked session can submit unlimited `current_password` guesses to `api_account_password()`; each guess is verified server-side (verifier computation / Argon2 verify). Unauthenticated auth endpoints are rate-limited; this authenticated step-up endpoint is not.
- **Area:** `app/app.py` `api_account_password()` (also `api_totp_disable()` password path).
- **Remediation:** Apply `_auth_rate_limited()` keyed by user id. **Code fix — clear-cut.** (Fully superseded for SRP accounts if M-1 moves to an SRP step-up proof, which inherits the existing challenge rate limits.)

#### L-5 — WAN exposure without Secure cookies only warns (carry-over, was M-3; downgraded)

- **Impact:** `NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1` still serves session cookies without the Secure flag and omits HSTS; since #61 a one-time startup warning is logged and `deploy/deeperguard.env.example` documents the pairing, but nothing enforces it.
- **Area:** `app/config.py` `log_wan_secure_cookies_startup_warning()`; `app/app.py` `SESSION_COOKIE_SECURE`; `app/auth.py` `security_headers()`.
- **Remediation:** Refuse to start (or require an explicit override env) when the gate is open and Secure cookies are off. **Code fix — clear-cut.**

#### L-6 — Account enumeration on auth endpoints (carry-over)

- **Impact:** `/api/auth/srp/register` returns `409` for existing emails; `/api/auth/srp/challenge` and the WebAuthn login options endpoint return distinguishable responses for existing vs. unknown accounts (`401 invalid credentials` vs. `404 no passkeys registered`).
- **Area:** `app/app.py` `api_auth_srp_register()`, `api_auth_srp_challenge()`, `api_webauthn_login_options()`.
- **Remediation:** Uniform responses/timing or an email-verification signup flow. **Product decision.**

#### L-7 — In-memory, per-process auth rate limits (carry-over)

- **Impact:** Limits reset on restart, are not shared across Gunicorn workers, and are keyed per `ip:endpoint:email`, so rotating emails or IPs dilutes them; the Cloudflare edge rules (`deploy/setup-cloudflare-rate-limits.sh`) are the effective WAN backstop.
- **Area:** `app/auth_rate_limit.py`.
- **Remediation:** Document the Cloudflare dependency for WAN deployments; optional shared (e.g. SQLite/Redis) limiter.

#### L-8 — Broad session cookie domain (carry-over)

- **Impact:** Default registrable-domain cookie scope (`.deeperguard.com`) shares sessions with sibling subdomains.
- **Area:** `app/config.py` `session_cookie_domain()`; `DynamicDomainSessionInterface` in `app/app.py` limits emission to matching hosts but the cookie remains domain-scoped.
- **Remediation:** Host-only cookies unless subdomain sharing is required.

#### L-9 — Predictable default IndexNow key (carry-over)

- **Impact:** Static default key in `app/config.py` served at a public path; low risk (search-engine URL ownership claims).
- **Remediation:** Require env override in production.

#### L-10 — CSP residual hardening (carry-over)

- **Impact:** `style-src 'unsafe-inline'`; no `report-to`/`report-uri`; a handful of inline event-handler attributes remain in templates (blocked by the nonce-based `script-src`, but they block tightening `script-src-attr` and are dead weight).
- **Area:** `app/auth.py` `content_security_policy()`; `app/templates/*.html`.
- **Remediation:** Migrate inline handlers, stage with `NOTES_CSP_REPORT_ONLY=1`, tighten `style-src` where feasible.

---

### Informational

1. **Open registration default** (`NOTES_ALLOW_REGISTER=1`, `NOTES_DEFAULT_PLAN=pro`) without email verification — abuse/spam surface; signup-notify emails are awareness only. (Carry-over.)
2. **Legacy `/api/auth/login`** retained for Argon2-only accounts; rate-limited and refuses SRP accounts. (Carry-over.)
3. **Request body cap** `MAX_CONTENT_LENGTH` = 80 MB with base64-in-JSON — memory pressure under concurrency. (Carry-over.)
4. **Vendored JS** under `app/static/js/vendor/` (tesseract, pdfjs, jspdf, noble, jsQR, heic2any) — no automated CVE gate observed in CI. (Carry-over.)
5. **"Remember on device" / boot-password stashes** (`app/static/js/vault-secrets.js`): the AES-GCM key is stored in the same `localStorage`/`sessionStorage` as the ciphertext, so the scheme is obfuscation against casual inspection, not protection against an attacker who can read client storage. Inherent to the opt-in feature; worth stating in docs.
6. **Deploy pipeline** (`deploy/deploy-deeperguard.sh`): pushes code as `root` over SSH with `StrictHostKeyChecking=accept-new` (trust-on-first-use) to a production IP pinned in the repo. Acceptable for a single-operator setup; pin the host key to remove the TOFU window.
7. **`/api/backup/email`** lets an authenticated user send the (encrypted) backup attachment to any address with no per-endpoint rate limit — minor outbound-mail abuse surface via the configured SMTP relay.

---

## Status of previously known open items (requested checklist)

| Item | Status on `f3de3d2` |
|------|---------------------|
| SRP step2 `A ≡ 0 (mod N)` bypass (#57) | **Fixed and regression-tested** (`app/srp_auth.py`, `tests/test_srp_auth.py`, endpoint tests from #59). |
| OCR startup warning (#60) | **In place** (`app/config.py` `log_server_ocr_startup_warning()`, called at import in `app/app.py`; tests cover WAN and persist variants). |
| #61 bundle (upload dirs by `user_id`, minimal `/api/health`, signup-notify env, rate limits on verify/resync/WebAuthn, fatal SRP M2 check, WAN secure-cookie warning) | **All landed as described**; residuals recorded as L-1 (M2 omission) and L-5 (warning-only WAN guard). |
| pCloud plaintext passwords | **Still open** (M-2). |
| Server OCR plaintext | **Still open as misconfiguration risk** (M-3), defaults safe, warning added; new ephemeral-mode gap recorded as L-3. |

## Areas reviewed without material new issues

- **Sync / IDOR:** all item, blob, reminder, session, OCR-job, and upload queries in `app/db.py` / `app/ocr_jobs.py` are scoped by authenticated `user_id`; session tokens are stored hashed.
- **WebAuthn:** challenges are session-bound and single-use; registration and authentication verify RP ID and origin; credential ownership is checked before verification; login endpoints are rate-limited.
- **CSRF / same-origin:** all mutating requests require same-origin (Sec-Fetch-Site with Origin/Referer fallback, `same-site` alone rejected); non-exempt authenticated mutations also require the CSRF token.
- **CSP / headers:** enforced nonce-based CSP, `frame-ancestors 'none'`, nosniff, HSTS when Secure cookies are on; service worker never intercepts `/api/*`.
- **AI relay / pCloud SSRF:** fixed upstream hosts, allowlisted fields/paths; rclone invoked with argument lists, no shell.
- **Deploy defaults:** Gunicorn on `127.0.0.1:80`; LAN TLS off by default and refused when the CIDR gate is open; deploy tarball excludes `keys/` and `data/`; `.gitignore` covers `config/deeperguard.env`, `keys/`, `data/`.

---

## Misconfiguration risks (dangerous flags)

| Flag | Default | Risk if changed |
|------|---------|-----------------|
| `NOTES_REPAIR_LOGIN_PASSWORD` | `0` | `1` re-enables server-side plaintext password on repair-login. |
| `NOTES_STRICT_ZK` | `1` | `0` re-enables server vault verification — vault passwords processed on server. |
| `NOTES_SERVER_OCR` | `0` | `1` — see M-3 (startup warning now logged). |
| `NOTES_OCR_EPHEMERAL` | `1` | `0` persists OCR plaintext on disk (warning logged when server OCR is on). |
| `NOTES_SKIP_LOGIN` | `0` | `1` auto-login first user; ignored when CIDR gate disabled. |
| `NOTES_DISABLE_CIDR_GATE` | `0` | `1` WAN exposure — pair with `NOTES_SECURE_COOKIES=1` (L-5; warning logged). |
| `NOTES_SECURE_COOKIES` | `0` | Must be `1` for WAN/HTTPS production (enables HSTS). |
| `NOTES_ENABLE_LAN_TLS` | `0` | `1` exposes Gunicorn on `0.0.0.0:443` — intended for LAN only; installer refuses it when the CIDR gate is open. |
| `NOTES_GEOIP` | `0` | `1` sends client IPs to a third-party geolocation API over HTTPS. |

---

## Recommended next steps (priority)

1. **M-1:** Move password change to an SRP step-up proof; stop sending `new_password` and stop storing `hash_password(new)` for SRP accounts; clear leftover legacy hashes.
2. **L-1:** Make a missing `M2` fatal in the SRP client.
3. **L-5:** Hard-fail startup when the CIDR gate is open without Secure cookies.
4. **M-2:** Drive pCloud settings toward OAuth token-only storage; feed `rclone obscure` via stdin.
5. **L-2, L-3, L-4:** SRP-upgrade password proof; ephemeral OCR queue without disk writes; rate-limit authenticated password verification.

---

*End of report.*
