# DeeperGuard Security Review — 2026-10-08

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)  
**Branch / commit reviewed:** `main` at `149aace` (includes PR #52 stored-verifier SRP proofs; PR #50 KDF cache / CSP / legacy-login rate limit; PR #49 strict-ZK recovery hardening).  
**Reviewer:** Cursor Cloud Agent — static code review, no production access, no live penetration testing.  
**Scope:** Server (`app/`), client (`app/static/js/`), service worker (`app/static/sw.js`), templates, deploy samples (`deploy/`), and existing tests.  
**Nature:** **Report-only.** No application behavior, configuration, secrets, or deployment was changed. This PR adds this document only.

This review follows [docs/SECURITY-REVIEW-2026-10-02.md](SECURITY-REVIEW-2026-10-02.md) (draft PR #48, `main` at `1440b5a`) and the unpublished follow-up on branch `cursor/security-review-2026-10-07-3b76` (`eda9f75`, before PR #52). It records **status changes** after PR #52 and **new** findings not covered in those documents.

---

## Executive summary

DeeperGuard remains a **well-designed zero-knowledge notes PWA**: SRP-6a login, strict-ZK defaults, per-user SQLite isolation for sync data, CSRF + same-origin enforcement, HttpOnly session cookies, Argon2id KDF, enforced CSP with per-request nonces, and repair-login / strict-ZK vault-recovery that now bind SRP step-2 to the **stored** verifier (PR #52).

The **critical regression** identified on 2026-10-07 (unauthenticated `repair-login` via self-referential SRP proof) is **remediated** on current `main`. The highest remaining issues are **operational** (pCloud password storage, WAN without Secure cookies) and one **new medium** issue: **colliding filesystem names** for per-user upload directories, which can mix device diagnostics and OCR files across distinct accounts.

| Severity | Count |
|----------|------:|
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 11 |
| Informational | 6 |

### Top findings (current)

1. **M-1 (Medium, new):** `email_fs_name()` maps distinct email addresses to the same upload directory; device reports and OCR-on-disk can be shared or overwritten across accounts; admin account purge can remove another account’s upload tree. (`app/uploads.py`)
2. **M-2 (Medium, carry-over):** pCloud WebDAV passwords stored in plaintext under `keys/`. (`app/config.py`)
3. **M-3 (Medium, carry-over):** WAN exposure (`NOTES_DISABLE_CIDR_GATE=1`) does not require `NOTES_SECURE_COOKIES=1`. (`app/config.py`, `app/auth.py`)
4. **M-4 (Medium, carry-over):** Server-side OCR breaks zero-knowledge when enabled (`NOTES_SERVER_OCR=1`). (`app/ocr.py`, `/api/ocr*`)

---

## Resolved since prior reviews

| Prior ID | Topic | Status on `149aace` |
|----------|--------|---------------------|
| 2026-10-07 **H-1** | Self-referential SRP proof on unauthenticated `repair-login` | **Fixed** — `_stored_srp_challenge()` / `_verify_stored_srp_proof()` bind to stored salt/verifier (PR #52); tests reject self-made verifiers (`test_repair_login_rejects_self_made_verifier`). |
| 2026-10-07 **M-1** | Strict-ZK `vault-recovery` same flaw | **Fixed** — same stored-verifier binding before `db.update_user_srp_verifier()`. |
| 2026-10-02 **H-1** | Session-only vault-recovery credential rotation | **Fixed** — step-up SRP proof against stored verifier. |
| 2026-10-02 **H-2** | Plaintext password on default `repair-login` | **Fixed** — default `NOTES_REPAIR_LOGIN_PASSWORD=0`; proof-only path. |
| 2026-10-02 **M-1** | Raw KDF bytes in `sessionStorage` | **Fixed** — hints only (`app/static/js/store.js` `rememberDerivedKdf`). |
| 2026-10-02 **M-3** | No CSP | **Fixed** — enforced CSP + nonce (PR #50). |
| 2026-10-02 **M-5** | Legacy login without rate limit | **Fixed** — `_auth_rate_limited("legacy-login", …)` on `/api/auth/login`. |

---

## What is already solid

- **SRP-6a login** (`app/srp_auth.py`, `/api/auth/srp/*`): password not sent on the normal path; server stores verifier only; RFC 5054 2048-bit group; server rejects `B ≡ 0 (mod N)` in `step1()`.
- **Credential recovery proofs** (`app/app.py`): repair-login and strict-ZK vault-recovery require SRP step-2 against credentials on file; session-stored challenge state is keyed by email + stored salt + verifier (`app/auth.py` `store_srp_credential_challenge` / `pop_srp_credential_challenge`).
- **Strict zero-knowledge default** (`NOTES_STRICT_ZK=1`): `/api/auth/verify-vault` returns `410` when strict (`api_auth_verify_vault`).
- **Per-user sync isolation** (`app/db.py`): items, reminders, sessions, and credentials scoped by `user_id`; OCR job lookup checks `user_id` (`app/ocr_jobs.py` `get_job`).
- **CSRF + same-origin** (`app/auth.py`): mutating authenticated requests require CSRF; public auth routes require same-origin.
- **Session model**: HttpOnly cookies, `SameSite=Lax`, optional Secure, server-side session rows, remote revoke, wipe-local-vault on user sign-out.
- **Client vault handling** (`app/static/js/vault-secrets.js`, `store.js`): boot password as AES-GCM under ephemeral key; derived KDF key kept in memory for the tab session.
- **AI relay** (`app/ai_relay.py`): fixed upstream host, allowlisted fields — no SSRF surface.
- **pCloud sync** (`app/backup_pcloud.py`): region allowlist for WebDAV/API hosts; rclone invoked with argument lists, no shell.
- **Deploy defaults** (`deploy/systemd/deeperguard.service`): Gunicorn on `127.0.0.1:80`; TLS service optional (`deeperguard-tls.service` binds `0.0.0.0:443` only when LAN TLS enabled); deploy tarball excludes `keys/` and `data/`.
- **Service worker** (`app/static/sw.js`): does not cache or intercept `/api/*`.

---

## Findings

### Medium

#### M-1 — Distinct emails can share the same upload directory (cross-account file collision)

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Two different registered accounts can read/overwrite each other’s device diagnostics and on-disk OCR artifacts; deleting one account can remove the shared upload tree for the other. Encrypted note ciphertext in SQLite remains per `user_id`. |
| **Affected area** | `app/uploads.py` — `email_fs_name()`, `user_upload_dir()`, `ensure_user_upload_dir()`, `remove_user_upload_dir()`; callers `app/app.py` `_device_reports_dir()` / `api_device_report()`; `app/ocr_index.py` `ocr_root()`; `app/db.py` `purge_user_data()`. |
| **Root cause** | `email_fs_name()` lowercases the address, replaces `@` with `_at_`, then maps any character outside `[a-z0-9._-]` to `_`. Distinct locals that differ only by characters normalized to `_` collide (e.g. `user+tag@example.com` and `user_tag@example.com` both become `user_tag_at_example.com`). SQLite enforces unique emails, but filesystem paths are not injective. |
| **Remediation outline** | Key upload paths by stable `user_id` (preferred) or by a collision-resistant hash of the normalized email (e.g. SHA-256 hex). Migrate existing directories on upgrade; avoid `remove_user_upload_dir()` until collision-safe. Add a unit test that asserts distinct valid emails never share a path. **Code fix — clear-cut.** |

#### M-2 — pCloud passwords stored in plaintext on disk

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Server filesystem compromise exposes users’ pCloud account passwords (not vault passwords). |
| **Affected area** | `app/config.py` — `write_pcloud_password()`, `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`). |
| **Fixed since Oct 2?** | No (unchanged). |
| **Remediation outline** | Prefer rclone OAuth token flow (`pcloud_token`); encrypt any stored WebDAV password with a server master key. **Product + code** (token-only UX vs. encryption). |

#### M-3 — WAN exposure toggle does not require Secure cookies / HSTS

| | |
|---|---|
| **Severity** | Medium |
| **Impact (one line)** | Opening the service to the WAN without `NOTES_SECURE_COOKIES=1` allows session cookies without the Secure flag and omits HSTS on misconfigured deployments. |
| **Affected area** | `app/config.py`, `app/app.py` (`SESSION_COOKIE_SECURE`), `app/auth.py` `security_headers()`; `deploy/deeperguard.env.example`. |
| **Remediation outline** | Fail startup or emit a hard error when `NOTES_DISABLE_CIDR_GATE=1` and Secure cookies are off; document pairing with Cloudflare tunnel HTTPS. **Code fix — clear-cut** (guardrail); operator process for production. |

#### M-4 — Server-side OCR exposes document plaintext when enabled

| | |
|---|---|
| **Severity** | Medium (misconfiguration) |
| **Impact (one line)** | With `NOTES_SERVER_OCR=1`, uploaded documents are processed server-side; extracted text may be returned and persisted if `NOTES_OCR_EPHEMERAL=0`. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py`. |
| **Remediation outline** | Keep defaults (`NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`); startup warning on WAN when server OCR is on. **Mostly product/ops**; optional code warning. |

---

### Low

#### L-1 — Public `/api/health` information disclosure

- **Impact:** Unauthenticated callers learn DB size, disk free/total, build id, OCR queue depth, registration flag.
- **Area:** `app/app.py` `health()`; path is public via `auth.public_path`.
- **Remediation:** Minimal public probe; detail behind admin auth or network restriction.

#### L-2 — Account enumeration on SRP registration

- **Impact:** `/api/auth/srp/register` returns `409` for existing emails.
- **Area:** `app/app.py` `api_auth_srp_register()`.
- **Remediation:** Generic response and uniform timing, or email verification flow. **Product decision.**

#### L-3 — In-memory, per-process auth rate limits

- **Impact:** Limits reset on restart and are not shared across Gunicorn workers.
- **Area:** `app/auth_rate_limit.py`; edge limits in `deploy/setup-cloudflare-rate-limits.sh`.
- **Remediation:** Document Cloudflare dependency for WAN; optional Redis-backed limiter.

#### L-4 — Session IP geolocation via third-party HTTP

- **Impact:** When Cloudflare geo headers are absent and `NOTES_GEOIP=1` (default), client IP is sent to `http://ip-api.com` in cleartext.
- **Area:** `app/auth.py` `_lookup_ip_location()`.
- **Remediation:** Default off or HTTPS-only provider; prefer `CF-IPCity` / `CF-IPCountry`.

#### L-5 — Broad session cookie domain

- **Impact:** Default registrable-domain cookie scope (`.deeperguard.com`) shares sessions across sibling subdomains.
- **Area:** `app/config.py` `session_cookie_domain()`.
- **Remediation:** Host-only cookies unless subdomain sharing is required.

#### L-6 — Client ignores SRP mutual-auth (M2) failure

- **Impact:** After `/api/auth/srp/verify`, failed `step3(M2)` is logged as a warning but login continues, weakening detection of a rogue server on the login path.
- **Area:** `app/static/js/srp-auth.js` `login()`.
- **Remediation:** Treat M2 failure as fatal; clear session state. **Code fix — clear-cut.**

#### L-7 — Hardcoded default signup-notify recipient

- **Impact:** When `NOTES_SIGNUP_NOTIFY_EMAILS` is unset, new signups email a personal address in source (`app/admin_notify.py` `DEFAULT_SIGNUP_NOTIFY_RECIPIENTS`).
- **Remediation:** Default to empty list; require explicit env on production. **Code fix — clear-cut.**

#### L-8 — Predictable default IndexNow key

- **Impact:** Static default key in `app/config.py` served at a public path; low risk (search-engine URL ownership).
- **Remediation:** Require env override in production.

#### L-9 — CSP residual hardening

- **Impact:** `style-src 'unsafe-inline'`; no `report-to` / `report-uri`; inline event-handler attributes in templates are incompatible with strict `script-src-attr` if tightened later.
- **Area:** `app/auth.py` `content_security_policy()`; `app/templates/*`.
- **Remediation:** Report-only staging via `NOTES_CSP_REPORT_ONLY=1`; migrate inline handlers; tighten `style-src` where feasible.

#### L-10 — SRP server `step2()` does not reject `A ≡ 0 (mod N)`

- **Impact:** Deviates from RFC 5054; marginal protocol hardening gap for all endpoints using `SrpServerSession.step2()` (login, repair-login, vault-recovery).
- **Area:** `app/srp_auth.py` `step2()` (contrast `step1()` which rejects `B ≡ 0`).
- **Remediation:** Reject when `_from_hex(a_hex) % N == 0` before computing `S`. Client already generates non-zero `A` (`srp-auth.js` `randomNonZeroModN`). **Code fix — clear-cut.**

#### L-11 — SRP `M1` compared with non-constant-time equality

- **Impact:** Theoretical timing side channel on proof verification (`m1_client != m1_expected` in `step2()`).
- **Area:** `app/srp_auth.py` `step2()`.
- **Remediation:** Compare stripped hex digests with `hmac.compare_digest`. **Code fix — clear-cut.**

#### L-12 — Some auth endpoints lack explicit rate limits

- **Impact:** `/api/auth/srp/verify`, `/api/auth/srp/resync`, and WebAuthn login routes are not wrapped in `_auth_rate_limited()` (challenge/register/repair/vault-recovery/legacy login are). Resync accepts a plaintext password for legacy migration accounts.
- **Area:** `app/app.py` `api_auth_srp_verify()`, `api_auth_srp_resync()`, WebAuthn handlers ~L1189+.
- **Remediation:** Apply the same limiter to verify/resync/WebAuthn; deprecate resync when legacy accounts are gone. **Code fix — clear-cut.**

---

### Informational

1. **Open registration default** (`NOTES_ALLOW_REGISTER=1`, `NOTES_DEFAULT_PLAN=pro`) without email verification — abuse/spam signups; admin notify is awareness only.
2. **Legacy `/api/auth/login`** still present for Argon2 accounts; now rate-limited.
3. **Request body cap** `MAX_CONTENT_LENGTH` (~80 MB) with base64-in-JSON — memory pressure under concurrency.
4. **Device reports** are user-submitted plaintext diagnostics, bounded and rotated under the upload dir (see M-1 for path collision).
5. **Vendored JS** under `app/static/js/vendor/` — no automated CVE gate observed in CI.
6. **CSRF-exempt** `/api/sync/pull` and `/api/account/unlock` still require same-origin on mutating requests.

---

## Misconfiguration risks (dangerous flags)

| Flag | Default | Risk if changed |
|------|---------|-----------------|
| `NOTES_REPAIR_LOGIN_PASSWORD` | `0` | `1` re-enables server-side plaintext password on repair-login. |
| `NOTES_STRICT_ZK` | `1` | `0` re-enables server vault verification — vault passwords processed on server. |
| `NOTES_SERVER_OCR` | `0` | `1` — see M-4. |
| `NOTES_OCR_EPHEMERAL` | `1` | `0` persists OCR plaintext on disk. |
| `NOTES_SKIP_LOGIN` | `0` | `1` auto-login first user; ignored when CIDR gate disabled. |
| `NOTES_DISABLE_CIDR_GATE` | `0` | `1` WAN exposure — pair with `NOTES_SECURE_COOKIES=1` (M-3). |
| `NOTES_SECURE_COOKIES` | `0` | Must be `1` for WAN/HTTPS production. |
| `NOTES_ENABLE_LAN_TLS` | `0` | `1` exposes Gunicorn on `0.0.0.0:443` on the host — intended for LAN only. |

---

## Areas reviewed without material new issues

- **Sync / IDOR:** Push/pull and item APIs scope by authenticated `user_id`; reminder and session deletion tests cover cross-user boundaries.
- **Shares / trash / versions:** Implemented as encrypted items in the user’s vault; server stores ciphertext blobs only — no separate share ACL bypass observed.
- **Attachments:** Ciphertext in SQLite `blob_ciphertext`; media preview routes gated on auth and plan.
- **Vault crypto:** Argon2id v2 aligned between `app/vault_crypto.py` and `app/static/js/crypto.js`; recovery samples used only on non-strict paths or client-side strict recovery flow.
- **OCR / pCloud SSRF:** No user-controlled upstream URLs in OCR or pCloud modules beyond fixed provider endpoints.

---

## Recommended next steps (priority)

1. **M-1:** Move upload/OCR-on-disk paths to `user_id` (or hashed email) and add collision tests.
2. **M-3:** Startup guard when WAN gate is disabled without Secure cookies.
3. **L-6, L-10, L-11:** SRP client/server hardening (M2 failure, `A` validation, constant-time `M1`).
4. **M-2:** Drive pCloud settings toward OAuth token-only storage.
5. **L-12:** Rate-limit `srp/verify`, `srp/resync`, and WebAuthn login.

---

*End of report.*
