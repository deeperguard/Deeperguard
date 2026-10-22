# DeeperGuard Security Review — 2026-10-07

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `eda9f75` (tip after PR #50; includes PR #49 and PR #50).
**Reviewer:** Cursor Cloud Agent — static code review, no production access, no live testing.
**Scope:** Server (`app/`), client (`app/static/js/`), service worker (`app/static/sw.js`), templates, deploy samples (`deploy/`), and existing tests.
**Nature:** **Report-only.** No application behavior, configuration, secrets, or deployment was changed. This PR adds this document only.

This review follows up [docs/SECURITY-REVIEW-2026-10-02.md](SECURITY-REVIEW-2026-10-02.md) (reviewed `main` at `1440b5a`, shipped as the still-open PR #48). It verifies which Oct 2 findings were closed by PR #49 (vault-recovery / repair-login) and PR #50 (KDF session cache, CSP, legacy-login rate limit), and reports new findings.

---

## Executive summary

DeeperGuard remains a **well-built zero-knowledge notes PWA**: SRP-6a login, strict-ZK defaults, per-user SQLite isolation, CSRF + same-origin enforcement, HttpOnly session cookies, Argon2id KDF, and (as of PR #50) an enforced Content-Security-Policy with per-request nonces and no derived key bytes in `sessionStorage`. Most of the Oct 2 remediations landed as described.

The one material regression is in the **credential-recovery design shipped in PR #49**. The SRP "proof" added to `repair-login` and strict-ZK `vault-recovery` is validated against the **client-supplied** verifier rather than the account's **stored** verifier or the vault, so the proof is *self-referential* and demonstrates nothing about the caller's current credentials. On the default (password-disabled) `repair-login` path this is reachable **without a session**, which allows rotating an account's login verifier and obtaining a session for that account. The encrypted note **plaintext stays protected** (it still requires the original vault password / KDF), which is why this is rated High rather than Critical — but it is an authentication-bypass for the login/session layer and was not present (in this form) in the Oct 2 review.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 9 |
| Informational | 6 |

### Top findings

1. **H-1 (High, new):** `repair-login` default path accepts a self-referential SRP proof with **no session**, letting an unauthenticated caller overwrite any account's SRP verifier and receive a logged-in session. Note plaintext remains protected. (`app/app.py` repair-login + challenge)
2. **M-1 (Medium, carry-over of Oct 2 H-1):** strict-ZK `vault-recovery` uses the same self-referential proof; a caller holding a session can rotate the SRP verifier. PR #49 only partially mitigated the original H-1.
3. **M-2 (Medium):** pCloud WebDAV passwords are stored in plaintext on disk under `keys/` (unchanged since Oct 2).
4. **M-3 (Medium):** WAN exposure toggle (`NOTES_DISABLE_CIDR_GATE=1`) does not require `NOTES_SECURE_COOKIES=1`; a misconfigured public deployment can serve session cookies without the Secure flag and without HSTS.

---

## What is already solid

- **SRP-6a login** (`app/srp_auth.py`, `/api/auth/srp/*`): password never transmitted on the normal login path; server stores a verifier only; RFC 5054 2048-bit group.
- **Strict zero-knowledge default** (`NOTES_STRICT_ZK=1`): `/api/auth/verify-vault` returns `410` in strict mode (`app/app.py` `api_auth_verify_vault`), so vault passwords are not sent to the server on the supported path.
- **PR #50 fixes verified present:**
  - No raw KDF bytes in `sessionStorage`: `notes_kdf_cache` now stores only non-secret hints (salt, version, encoding, fingerprint); derived key stays in memory and is cleared on lock (`app/static/js/store.js` `rememberDerivedKdf` / `cachedDerivedKdf` / lock path; comment at `store.js:396`).
  - Enforced CSP with per-request nonce for inline boot scripts (`app/auth.py` `content_security_policy` / `csp_nonce`; `app/templates/app.html`, `partials/auth-head.html`).
  - Legacy `/api/auth/login` rate-limited with the same keying as SRP (`app/app.py` `api_login` → `_auth_rate_limited("legacy-login", …)`).
- **Per-user data isolation** (`app/db.py`): every item/session/reminder/credential query is scoped `WHERE user_id = ?`; no cross-tenant read path observed.
- **CSRF + same-origin** (`app/auth.py` `csrf_ok`, `request_is_same_origin`; `app/app.py` `_gate`): mutating authenticated requests require a CSRF token and same-origin; mutating public auth routes require same-origin.
- **Session model**: HttpOnly cookies, `SameSite=Lax`, optional Secure, server-side session rows, remote revoke, and “wipe local vault” on user sign-out (`app/auth.py`, `session_requires_wipe`).
- **Password & vault crypto**: Argon2id for login hashes (`app/passwords.py`) and vault KDF v2 (`app/vault_crypto.py`), AES-GCM note encryption aligned with `static/js/crypto.js`.
- **Boot password handling** (`app/static/js/vault-secrets.js`): the entered password is stored only as AES-GCM ciphertext under an ephemeral per-session boot key, never as plaintext in `sessionStorage`.
- **AI relay** (`app/ai_relay.py`): fixed upstream host (`https://ollama.com`), field allowlist, size caps, no storage/logging of key/prompt/answer — SSRF-safe by construction.
- **Subprocess use** (`app/ocr.py`, `app/backup_pcloud.py`): list-argument `subprocess.run` with timeouts, no `shell=True`.
- **Service worker** (`app/static/sw.js`): precaches shell/static only; does not intercept `/api/*` or auth pages.
- **TOTP** (`app/totp.py`): enforced in `before_request` until `/api/totp/verify`; per-user rate limited.
- **Secrets hygiene** (`.gitignore`, `app/config.py`): `keys/`, `data/`, and `config/deeperguard.env` are git-ignored; Flask secret and SMTP password read from `keys/` or env.

---

## Findings

### High

#### H-1 — `repair-login` accepts a self-referential SRP proof with no session (login-credential takeover)

| | |
|---|---|
| **Severity** | High |
| **Impact (one line)** | An unauthenticated caller can overwrite any known account's SRP login verifier and obtain a logged-in session for that account; encrypted note plaintext stays protected. |
| **Affected area** | `app/app.py` — `api_auth_repair_login()` (~L829–879) and `api_auth_repair_login_challenge()` (~L808–826); helpers `_srp_credential_challenge()` / `_verify_srp_credential_proof()` (~L130–147). Reachable because `/api/auth/*` is a public path (`app/auth.py` `public_path`). |
| **Fixed since Oct 2?** | No — introduced by the PR #49 rework. The Oct 2 review flagged repair-login for *plaintext exposure* (H-2); PR #49 removed the default plaintext path but the replacement proof does not authenticate the caller. |
| **Root cause** | The SRP challenge is built from the **client-supplied** `srp_salt`/`srp_verifier` (`_srp_credential_challenge` passes the request values into `SrpServerSession.step1`), and `_verify_srp_credential_proof` verifies the client's `A`/`M1` against that same client-supplied verifier. The proof therefore only shows the caller knows a password matching a verifier the caller itself provided; it is never compared to the account's stored verifier, legacy hash, or vault sample notes. On success, `_realign_login_credentials` overwrites the stored verifier and `auth.login_user` issues a session. The default config (`NOTES_REPAIR_LOGIN_PASSWORD=0`) makes this proof-only path the active one. |
| **Confirmation** | The project's own test `tests/test_app.py::test_repair_login_accepts_client_verifier_for_srp_only_drift` creates an account whose stored verifier is derived from one password, then (with the session cleared) submits a salt/verifier/proof derived from a *different* password and asserts the stored verifier is replaced and login succeeds. |
| **Impact detail** | Yields an authenticated session as the victim: read/sync of encrypted item ciphertext and metadata (reminder note IDs, timestamps, device/session info), account-settings changes, and the ability to point email/pCloud backups at an attacker-controlled destination (backups are encrypted, so this is ciphertext exfiltration). It also locks the legitimate user out of SRP login until they recover. It does **not** by itself reveal note plaintext, which still requires the original vault password and KDF salt. |
| **Remediation outline** | Make the recovery proof meaningful: build the SRP challenge from the account's **stored** verifier so the caller must prove knowledge of the current password before any rotation, and/or require that the supplied password decrypts the server-held recovery sample notes (as the non-strict path already does via `_vault_password_matches`). For genuine forgotten-password cases, require a real second factor (TOTP/WebAuthn) or an email-verified reset rather than an unauthenticated verifier swap. Keep the rotation and the session issuance behind that check. |

---

### Medium

#### M-1 — Strict-ZK `vault-recovery` rotates SRP credentials behind the same self-referential proof (carry-over of Oct 2 H-1)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | A caller holding a valid session can rotate the account's SRP login verifier to a value it controls (login persistence + victim lockout); vault plaintext stays protected. |
| **Affected area** | `app/app.py` — `api_auth_vault_recovery()` strict branch (~L972–994) and `api_auth_vault_recovery_challenge()` (~L934–959). |
| **Fixed since Oct 2?** | Partially. PR #49 replaced "session + CSRF only" with "session + CSRF + SRP step-2 proof"; however the proof is validated against the client-supplied verifier (same root cause as H-1), so it does not prove knowledge of the current password or the vault. |
| **Why lower than H-1** | The strict `vault-recovery` branch requires an authenticated session (`auth.current_user_id()`) and CSRF; the marginal gain for an attacker who already holds a session is persistence beyond cookie revocation and locking out the victim, not new data access. |
| **Remediation outline** | Same as H-1: anchor the challenge to the stored verifier or require vault-sample decryption / step-up auth before rotating. |

#### M-2 — pCloud passwords stored in plaintext on disk

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Server filesystem compromise exposes users' pCloud account passwords (not vault passwords). |
| **Affected area** | `app/config.py` — `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`, no app-level encryption). |
| **Fixed since Oct 2?** | No (unchanged). |
| **Remediation outline** | Prefer the rclone OAuth token flow (already supported via `pcloud_token`) and encourage token-only in the UI; encrypt any stored WebDAV password at rest with a server master key. |

#### M-3 — WAN exposure toggle does not require Secure cookies / HSTS

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Opening the service to the WAN without also enabling Secure cookies can send session cookies over plaintext HTTP and omit HSTS. |
| **Affected area** | `app/config.py` (`cidr_gate_enabled`, `NOTES_SECURE_COOKIES` default `0`), `app/app.py` (`SESSION_COOKIE_SECURE` from the same env), `app/auth.py` `security_headers` (HSTS only when `NOTES_SECURE_COOKIES=1`); `deploy/deeperguard.env.example` documents `NOTES_DISABLE_CIDR_GATE=1` for WAN but ships `NOTES_SECURE_COOKIES=0`. |
| **Fixed since Oct 2?** | Not previously reported; related to L-5. |
| **Remediation outline** | When `NOTES_DISABLE_CIDR_GATE=1`, fail startup (or log a loud warning) unless `NOTES_SECURE_COOKIES=1`; set `Secure` and HSTS automatically for non-loopback HTTPS hosts. |

#### M-4 — Server-side OCR exposes document plaintext when enabled

| | |
|---|---|
| **Severity** | Medium (misconfiguration) |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, uploaded documents are processed server-side and extracted text can be returned and (if `NOTES_OCR_EPHEMERAL=0`) persisted, breaking the zero-knowledge story. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`. |
| **Fixed since Oct 2?** | No change; defaults remain safe (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`), and legacy plaintext indexes are purged on boot when ephemeral. |
| **Remediation outline** | Keep both defaults; add a startup warning when server OCR is enabled on a WAN-exposed host; the admin dashboard already surfaces `ocr_mode`. |

---

### Low

#### L-1 — Public `/api/health` information disclosure
- **Impact:** Unauthenticated callers learn DB byte size, disk free/total, build id, OCR queue depth, and whether registration is open. Reconnaissance aid, not direct data exposure.
- **Area:** `app/app.py` `health()`; `/api/health` is in `public_path`.
- **Fixed since Oct 2?** No.
- **Remediation:** Return a minimal public probe; move ops detail behind admin auth or restrict by network.

#### L-2 — Account enumeration on registration
- **Impact:** `/api/auth/srp/register` returns `409 "account already exists"`, revealing which emails have accounts.
- **Area:** `app/app.py` `api_auth_srp_register()`.
- **Fixed since Oct 2?** No.
- **Remediation:** Generic response with uniform timing, or email-verification flow.

#### L-3 — In-memory, per-process auth rate limits
- **Impact:** Limits reset on restart and are not shared across gunicorn workers, weakening online-guessing protection without the edge WAF.
- **Area:** `app/auth_rate_limit.py`.
- **Fixed since Oct 2?** No. The Cloudflare WAF script (`deploy/setup-cloudflare-rate-limits.sh`) must be operated separately.
- **Remediation:** Document the Cloudflare dependency for WAN; optional shared-store limiter for multi-worker.

#### L-4 — Session IP geolocation to a third party over plaintext HTTP
- **Impact:** When Cloudflare geo headers are absent and `NOTES_GEOIP=1` (default), the client IP is sent to `http://ip-api.com` over unencrypted HTTP.
- **Area:** `app/auth.py` `_lookup_ip_location()`.
- **Fixed since Oct 2?** No.
- **Remediation:** Default off, or rely only on `CF-IPCity` / `CF-IPCountry`; if kept, use HTTPS.

#### L-5 — Broad session cookie domain
- **Impact:** `.deeperguard.com` cookie scope means any compromised sibling subdomain shares the session cookie jar.
- **Area:** `app/config.py` `session_cookie_domain()` (defaults to `.` + registrable domain).
- **Fixed since Oct 2?** No.
- **Remediation:** Host-only cookie unless subdomain sharing is required; keep untrusted siblings off the registrable domain.

#### L-6 — Client swallows SRP mutual-auth (M2) failure
- **Impact:** During SRP login the client logs a warning and keeps the session even when the server's M2 proof fails ("login session was accepted"), weakening detection of a rogue/MITM server on the normal login path.
- **Area:** `app/static/js/srp-auth.js` `login()` → `client.step3(result.M2)` catch.
- **Fixed since Oct 2?** New observation.
- **Remediation:** Treat M2 verification failure as a hard error (abort and clear session state) rather than a warning.

#### L-7 — Hardcoded default signup-notify recipient
- **Impact:** When `NOTES_SIGNUP_NOTIFY_EMAILS` is unset, every new signup emails a personal address baked into source (`dennisschutten@protonmail.com`), a metadata leak.
- **Area:** `app/admin_notify.py` `DEFAULT_SIGNUP_NOTIFY_RECIPIENTS`.
- **Fixed since Oct 2?** No (still present; feature added in PR #47).
- **Remediation:** Default to empty; require explicit env configuration.

#### L-8 — Predictable default IndexNow key
- **Impact:** A static default key string (`deeperguard-notes-indexnow-8f3a`) is served at a public path; low risk (search-engine URL ownership only).
- **Area:** `app/config.py` `INDEXNOW_KEY` default.
- **Fixed since Oct 2?** No.
- **Remediation:** Require an env override in production.

#### L-9 — CSP hygiene: `style-src 'unsafe-inline'`, no reporting, inline event-handler attributes
- **Impact:** The enforced CSP is a strong improvement, but `style-src 'unsafe-inline'` permits inline styles, there is no `report-uri`/`report-to` for violation visibility, and templates still use inline event-handler attributes (`onsubmit`, `onclick` in `app.html`, `login.html`, `register.html`, `totp.html`) which the `script-src` nonce policy does not cover with `script-src-attr`. These attributes are treated as inline and are blocked/ignored under the current policy, so forms rely on separately-attached listeners.
- **Area:** `app/auth.py` `content_security_policy()`; `app/templates/*`.
- **Fixed since Oct 2?** CSP itself added by PR #50; these are residual hardening items.
- **Remediation:** Add a `report-to`/`report-uri` (start report-only via `NOTES_CSP_REPORT_ONLY=1` on staging), migrate inline handlers to nonce'd scripts or delegated listeners, and tighten `style-src` where feasible.

---

### Informational

1. **Open registration default on** (`NOTES_ALLOW_REGISTER=1`) with `NOTES_DEFAULT_PLAN=pro`: no email verification; abuse/spam signups possible. PR #47 admin-notify helps awareness only.
2. **Legacy `/api/auth/login` still present** for Argon2 accounts; now rate-limited (PR #50). Consider deprecating once all accounts are SRP.
3. **Request body cap** `MAX_CONTENT_LENGTH = 80 MB` with base64-in-JSON items: large uploads are buffered in memory; a DoS/memory consideration under concurrency.
4. **Device reports** (`/api/device-report`) are stored as plaintext diagnostics under the per-user upload dir; user-submitted content, bounded and rotated.
5. **Vendored JS** (pdf.js, tesseract, noble-*, jsPDF, heic2any) under `app/static/js/vendor/` with pinned SW precache; no automated CVE gate observed in CI.
6. **CSRF-exempt paths** (`/api/sync/pull`, `/api/account/unlock`) still require same-origin on mutating requests; acceptable with `SameSite=Lax`.

---

## Misconfiguration risks (flags that are dangerous if turned on)

| Flag | Default | Risk if changed |
|------|---------|-----------------|
| `NOTES_REPAIR_LOGIN_PASSWORD` | `0` | `1` re-enables server-side plaintext password handling on repair-login (original Oct 2 H-2). |
| `NOTES_STRICT_ZK` | `1` | `0` re-enables server-side vault verification — vault passwords are sent to and processed by the server. |
| `NOTES_SERVER_OCR` | `0` | `1` processes document plaintext server-side (see M-4). |
| `NOTES_OCR_EPHEMERAL` | `1` | `0` persists OCR plaintext to disk. |
| `NOTES_SKIP_LOGIN` | `0` | `1` auto-logs-in the first user. Guarded to work only when the CIDR gate is enabled (ignored on WAN) — keep that guard. |
| `NOTES_DISABLE_CIDR_GATE` | `0` | `1` exposes the app to the WAN; pair with `NOTES_SECURE_COOKIES=1` + HTTPS/tunnel (see M-3). |
| `NOTES_SECURE_COOKIES` | `0` | Must be `1` for any WAN/HTTPS deployment; otherwise cookies lack `Secure` and HSTS is not sent. |
| `NOTES_GEOIP` | `1` | Leaks client IP to a third-party service over HTTP (see L-4). |
| `NOTES_ALLOW_REGISTER` | `1` | Leave `1` only during open beta; close after launch to limit abuse. |

---

## Prioritized recommendations

1. **H-1 / M-1** — Rebuild the recovery proof so it authenticates the caller: anchor the SRP challenge to the account's **stored** verifier, and/or require vault-sample decryption or a real second factor before rotating credentials or issuing a session.
2. **M-3** — Couple WAN exposure with Secure cookies + HSTS (fail-closed when `NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1`).
3. **M-2** — Move pCloud backups to token-only auth and/or encrypt stored passwords at rest.
4. **L-9** — Add CSP reporting, migrate inline handlers, and tighten `style-src`.
5. **L-1 / L-2 / L-7** — Reduce reconnaissance surface: minimal `/api/health`, uniform registration response, empty default notify recipient.

---

## Out of scope (per request)

- No production/deploy changes, no dependency CVE database audit, no live penetration testing.
- No exploit proof-of-concept, attack procedure, or payload is included; findings cite file/line evidence and root cause only.

## Suggested verification for follow-up PRs

- Add a test asserting that `repair-login` and strict `vault-recovery` **reject** a self-made salt/verifier/proof that does not correspond to the account's current credentials (i.e., invert the current `test_repair_login_accepts_client_verifier_for_srp_only_drift` expectation once the proof is anchored).
- Add a startup assertion/test for `NOTES_DISABLE_CIDR_GATE=1 ⇒ NOTES_SECURE_COOKIES=1`.
- CSP report-only soak on staging to confirm inline boot scripts and the PDF/OCR workers load under the nonce policy.
