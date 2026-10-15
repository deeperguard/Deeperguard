# DeeperGuard Security Review — 2026-10-08

**Repository:** [deeperguard/Deeperguard](https://github.com/deeperguard/Deeperguard)
**Branch / commit reviewed:** `main` at `149aace` (tip after PR #52, #53, #54, #55).
**Reviewer:** Cursor Cloud Agent — static code review, no production access, no live testing.
**Scope:** Server (`app/`), client (`app/static/js/`), service worker, templates, deploy samples (`deploy/`), tests.
**Nature:** **Report-only.** No application behavior, configuration, secrets, or deployment was changed. This PR adds this document only. No exploit proof-of-concept, payload, or step-by-step attack procedure is included; findings cite file/function evidence, impact, and remediation only.

This review follows the prior reviews shipped on unmerged branches
(`SECURITY-REVIEW-2026-10-02.md`, `SECURITY-REVIEW-2026-10-07.md` — neither is present on `main`). It verifies which earlier findings are now closed on `main` and reports what is **new** or **still open**.

---

## Executive summary

DeeperGuard remains a well-built zero-knowledge notes PWA: SRP-6a login, strict-ZK defaults, per-user SQLite isolation scoped by `user_id`, CSRF + same-origin enforcement, HttpOnly session cookies, Argon2id KDF, an enforced Content-Security-Policy with per-request nonces, and no derived vault-key bytes in `sessionStorage`.

The previously reported credential-recovery weaknesses (Oct 7 **H-1** / **M-1**) are **fixed** on `main`: PR #52 re-anchors the `repair-login` and strict-ZK `vault-recovery` SRP proofs to the account's **stored** salt/verifier (`_stored_srp_challenge` / `_verify_stored_srp_proof` in `app/app.py`). The Oct-7 KDF-cache, CSP, and legacy-login rate-limit fixes (PR #50) are present and verified.

However, this review found **one new Critical issue in the SRP implementation itself** that undercuts those fixes: `SrpServerSession.step2` (`app/srp_auth.py`) never rejects a client public value `A` that is congruent to zero modulo the group prime `N`. Such a value forces the shared secret to a constant the caller can predict without knowing the password, so the server completes the SRP exchange and treats the caller as authenticated. Because every SRP endpoint — normal login (`/api/auth/srp/verify`), `repair-login`, and strict-ZK `vault-recovery` — funnels through this one `step2`, the stored-verifier binding added in PR #52 is necessary but **not sufficient**: the proof can be satisfied regardless of the stored verifier. Encrypted note plaintext stays protected (it still requires the client-side vault password / KDF), but an unauthenticated caller who knows a registered email can obtain a logged-in session and rotate login credentials.

| Severity | Count |
|----------|------:|
| Critical | 1 |
| High | 0 |
| Medium | 3 |
| Low | 11 |
| Informational | 6 |

### Status of the specific earlier open items called out for this review

- **Raw unlock key in the tab store — FIXED.** `notes_kdf_cache` now stores only non-secret hints (salt, KDF version, encoding, and a password fingerprint); the derived key bytes live only in the in-memory `lastDerivedKdf` and are cleared on lock/logout (`app/static/js/store.js` `rememberDerivedKdf`, `reuseDerivedKdf`, lock path ~L692–697). See **L-2** for a residual weakness in the fingerprint/boot-key artifacts.
- **CSP compatible with notes + PDF preview — PRESENT.** Enforced CSP with per-request nonce, `wasm-unsafe-eval`, `worker-src 'self' blob:`, `img/media … blob:` (`app/auth.py` `content_security_policy`). Residual hardening in **L-9**.
- **Rate-limiting the old password login — FIXED.** `/api/auth/login` is keyed `legacy-login` through the same limiter as SRP/TOTP (`app/app.py` `api_login`). Limiter scope caveat in **L-3**.

---

## New finding

### Critical

#### C-1 — SRP server accepts a zero/`N`-multiple client public value, bypassing password proof on all SRP endpoints

| | |
|---|---|
| **Severity** | Critical |
| **Impact (one line)** | An unauthenticated caller who knows a registered email can complete the SRP exchange without knowing the password, obtaining a logged-in session and the ability to rotate the account's SRP verifier. Encrypted note plaintext stays protected (client-side KDF). |
| **Affected area** | `app/srp_auth.py` — `SrpServerSession.step2()` (the `a_val = _from_hex(a_hex)` → `self.S = pow((pow(v, u, N) * a_val) % N, self.b, N)` path has no `A mod N == 0` guard). Reached by `app/app.py` `api_auth_srp_verify()` (`/api/auth/srp/verify`, public/unauthenticated), `_verify_stored_srp_proof()` used by `api_auth_repair_login()` and `api_auth_vault_recovery()`. |
| **Root cause** | RFC 5054 / SRP-6a requires the server to abort if the client public value is congruent to zero modulo `N`. `step1` / `from_private_state` correctly reject a zero **server** value (`if self.B % N == 0: raise`), but `step2` never validates the **client** value `A`. When `A ≡ 0 (mod N)`, the premaster secret `S` collapses to a value independent of the stored verifier `v`, so the client proof `M1 = H(A | B | S)` can be produced from public data alone, and the server-side `m1_expected` matches. The exchange therefore succeeds without knowledge of the password behind the stored verifier. |
| **Why it matters despite PR #52** | PR #52 correctly bound the challenge to the stored salt/verifier so a self-made verifier can no longer stand in. But the degenerate-`A` path makes `v` irrelevant inside `step2`, so the stored-verifier binding is bypassed. All three SRP entry points are affected, including the primary unauthenticated login endpoint. |
| **Impact detail** | Yields an authenticated session as the victim: read/sync of encrypted item ciphertext and metadata (reminder note IDs, timestamps, device/session info), account-settings changes, pointing email/pCloud backups at an attacker-chosen destination (backups are ciphertext), and rotating the SRP verifier via the recovery paths (persistence + victim lockout). It does **not** by itself reveal note plaintext, which still requires the original vault password and KDF salt. (Rated Critical rather than following the Oct-7 "High" precedent because this is a textbook, trivially-reachable complete bypass on the *primary* unauthenticated login path, not only a recovery path, and it nullifies a just-shipped hardening fix.) |
| **Remediation (clear-cut code fix)** | In `SrpServerSession.step2`, before computing `S`, reject the exchange when `a_val % N == 0` (equivalently `A % N == 0`), raising the same `ValueError("bad client credentials")` used for a bad proof. As defense in depth, also reject a zero scrambling parameter `u == 0` (`u = H(A | B)`). No product decision required; add a regression test asserting that `A = 0` and `A = N` are rejected across `/api/auth/srp/verify`, `repair-login`, and `vault-recovery`. |

---

## Still-open findings carried from the Oct 7 review

### Medium

#### M-1 — pCloud WebDAV passwords stored in plaintext on disk (unchanged)

| | |
|---|---|
| **Severity** | Medium |
| **Impact** | Server filesystem compromise exposes users' pCloud *account* passwords (not vault passwords). |
| **Affected area** | `app/config.py` `write_pcloud_password()` / `pcloud_password_path()` (`keys/pcloud-password-{user_id}`, mode `0600`, no app-level encryption); consumed by `app/backup_pcloud.py` `write_rclone_config()`. |
| **Fix type** | **Needs a product decision.** Prefer the already-supported rclone OAuth token flow (`pcloud_token`) and steer the Settings UI to token-only; if a WebDAV password must be retained, encrypt it at rest with a server master key. Trade-off between UX (WebDAV password simplicity) and at-rest exposure. |

#### M-2 — WAN exposure toggle does not require Secure cookies / HSTS (unchanged)

| | |
|---|---|
| **Severity** | Medium |
| **Impact** | Opening the service to the WAN (`NOTES_DISABLE_CIDR_GATE=1`) without also setting `NOTES_SECURE_COOKIES=1` can send session cookies over plaintext HTTP and omit HSTS. |
| **Affected area** | `app/config.py` (`cidr_gate_enabled`, `NOTES_SECURE_COOKIES` default `0`), `app/app.py` (`SESSION_COOKIE_SECURE` from that env), `app/auth.py` `security_headers` (HSTS only when `NOTES_SECURE_COOKIES=1`); `deploy/deeperguard.env.example` documents WAN exposure but ships `NOTES_SECURE_COOKIES=0`. |
| **Fix type** | **Mostly clear-cut.** Fail-closed at startup (or log a loud warning) when `NOTES_DISABLE_CIDR_GATE=1` and `NOTES_SECURE_COOKIES!=1`, and set `Secure` + HSTS automatically for non-loopback HTTPS hosts. Minor product input on whether to hard-fail vs. warn. |

#### M-3 — Server-side OCR exposes document plaintext when enabled (unchanged; default-safe)

| | |
|---|---|
| **Severity** | Medium (misconfiguration) |
| **Impact** | With `NOTES_SERVER_OCR=1`, uploaded documents are processed server-side and extracted text can be returned and (if `NOTES_OCR_EPHEMERAL=0`) persisted, breaking the zero-knowledge story. |
| **Affected area** | `app/app.py` `/api/ocr*`, `/api/media/*`; `app/ocr.py`; `app/ocr_index.py` (`save_document`, `list_index`). |
| **Status** | Defaults remain safe: `NOTES_SERVER_OCR=0`, `NOTES_OCR_EPHEMERAL=1`, and legacy plaintext indexes are purged on boot when ephemeral (`purge_legacy_plaintext_indexes`). |
| **Fix type** | **Needs a product decision** (feature is a deliberate opt-in). Keep both defaults; add a startup warning when server OCR is enabled on a WAN-exposed host (admin dashboard already surfaces `ocr_mode`). |

### Low

- **L-1 — Public `/api/health` information disclosure (unchanged).** Unauthenticated callers learn DB byte size, disk free/total, build id, OCR queue depth, and whether registration is open. `app/app.py` `health()`. Fix: minimal public probe; ops detail behind admin.
- **L-2 — Client-side password artifacts recoverable from `sessionStorage` (new/expanded).** Two artifacts help a local/XSS attacker who can read `sessionStorage`: (a) `notes_kdf_cache.fp` is a 64-bit truncated single SHA-256 of `password‖salt` (`app/static/js/store.js` `passwordFingerprint`), a fast offline-guessing oracle far cheaper than the Argon2 KDF; (b) the "remember on this device" boot password is AES-GCM ciphertext but its key (`notes_boot_key`) is stored next to the ciphertext (`notes_boot_password_enc`) in the same `sessionStorage` (`app/static/js/vault-secrets.js`), so it is obfuscation, not confidentiality, against a store reader. Impact is bounded to local/XSS access (CSP mitigates XSS). Fix: drop the stored fingerprint or make it a slow/keyed value; avoid persisting any password-derived material, or accept and document the local-access threat model.
- **L-3 — In-memory, per-process auth rate limits (unchanged).** `app/auth_rate_limit.py` resets on restart and is not shared across gunicorn workers. The edge WAF (`deploy/setup-cloudflare-rate-limits.sh`) must be operated separately for WAN. Fix: document the dependency; optional shared-store limiter.
- **L-4 — Session IP geolocation to a third party over plaintext HTTP (unchanged).** When Cloudflare geo headers are absent and `NOTES_GEOIP=1` (default), the client IP is sent to `http://ip-api.com` over unencrypted HTTP (`app/auth.py` `_lookup_ip_location`). Fix: default off, use HTTPS, or rely only on `CF-*` headers.
- **L-5 — Broad session cookie domain (unchanged).** `.deeperguard.com` scope means a compromised sibling subdomain shares the cookie jar (`app/config.py` `session_cookie_domain`). Fix: host-only cookie unless subdomain sharing is required.
- **L-6 — Client swallows SRP mutual-auth (M2) failure (unchanged).** The client logs a warning and keeps the session even when the server M2 proof fails (`app/static/js/srp-auth.js` `login()`), weakening detection of a rogue/MITM server. Fix: treat M2 failure as a hard error (abort + clear state).
- **L-7 — Hardcoded default signup-notify recipient (unchanged).** When `NOTES_SIGNUP_NOTIFY_EMAILS` is unset, every new signup emails a personal address baked into source (`app/admin_notify.py` `DEFAULT_SIGNUP_NOTIFY_RECIPIENTS = ("dennisschutten@protonmail.com",)`), a metadata leak. Fix: default to empty; require explicit env configuration.
- **L-8 — Predictable default IndexNow key (unchanged).** A static default key (`deeperguard-notes-indexnow-8f3a`) is served at a public path (`app/config.py` `INDEXNOW_KEY`). Low risk (search-engine URL ownership). Fix: require an env override in production.
- **L-9 — CSP hygiene (unchanged).** `style-src 'unsafe-inline'`, no `report-to`/`report-uri`, and inline event-handler attributes in templates not covered by the `script-src` nonce (`app/auth.py` `content_security_policy`; `app/templates/*`). Fix: add reporting, migrate inline handlers to nonce'd/delegated listeners, tighten `style-src`.
- **L-10 — Account enumeration on registration (unchanged).** `/api/auth/srp/register` returns `409 "account already exists"` (`app/app.py` `api_auth_srp_register`), revealing which emails have accounts. Fix: uniform response/timing or email-verification flow.
- **L-11 — Per-user upload directory collision via email sanitization (new).** `uploads.email_fs_name()` maps distinct email addresses to the same on-disk directory name (`@` → `_at_`, all other non-`[a-z0-9._-]` characters → `_`, then truncation to 180 chars). Two different accounts whose emails sanitize to the same name share the per-user `uploads/<name>/` tree (`device-reports/`, `ocr/`), since those paths are keyed by email rather than `user_id`. An attacker can deliberately register an address that collides with a chosen victim's. Encrypted notes/sync/sessions are unaffected (DB rows are scoped by `user_id`). Impact today is limited to device-report diagnostics (and, only if `NOTES_SERVER_OCR=1`, stored OCR files), so Low; it rises to Medium if server OCR is enabled. Fix: key per-user directories by `user_id` (or include the id in the directory name) and/or reject colliding registrations.

### Informational (unchanged from Oct 7)

1. Open registration default on (`NOTES_ALLOW_REGISTER=1`) with `NOTES_DEFAULT_PLAN=pro`; no email verification.
2. Legacy `/api/auth/login` still present for Argon2 accounts (now rate-limited); consider deprecating once all accounts are SRP.
3. `MAX_CONTENT_LENGTH = 80 MB` with base64-in-JSON items: large uploads buffered in memory; DoS/memory consideration under concurrency.
4. `/api/device-report` stores plaintext diagnostics under the per-user upload dir (bounded, rotated; see also L-11).
5. Vendored JS (pdf.js, tesseract, noble-*, jsPDF, heic2any) under `app/static/js/vendor/`; no automated CVE gate observed in CI.
6. CSRF-exempt paths (`/api/sync/pull`, `/api/account/unlock`) still require same-origin on mutating requests; acceptable with `SameSite=Lax`.

---

## Confirmed solid on `main`

- **SRP credential-recovery binding (PR #52).** `repair-login` and strict-ZK `vault-recovery` challenges are seeded from the account's stored salt/verifier (`_stored_srp_challenge`), and the proof is validated against the verifier on file (`_verify_stored_srp_proof`) before any rotation or session. The Oct-7 self-referential-proof H-1/M-1 are closed — subject to C-1, which bypasses the proof at the `step2` layer.
- **KDF session cache (PR #50).** No raw derived-key bytes in `sessionStorage`; in-memory only, cleared on lock/logout.
- **Enforced CSP with nonces (PR #50)**, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- **Per-user data isolation** — every item/session/reminder/credential/blob query in `app/db.py` is scoped `WHERE user_id = ?`; refetch/blobs/versions/trash all filter by `user_id`. No server-side note "share"/collaboration endpoint exists (sharing is client/OS-level), so there is no share IDOR surface.
- **CSRF + same-origin** enforcement on mutating requests (`app/auth.py` `csrf_ok`, `request_is_same_origin`; `app/app.py` `_gate`).
- **AI relay** (`app/ai_relay.py`): fixed upstream host (`https://ollama.com`), field allowlist, body/size caps, no storage/logging of key/prompt/answer — SSRF-safe by construction.
- **Subprocess use** (`app/ocr.py`, `app/backup_pcloud.py`): list-argument `subprocess.run` with timeouts, no `shell=True`.
- **Gunicorn bind** for the app is `127.0.0.1:80` (`deploy/systemd/deeperguard.service`), matching the Cloudflare-tunnel-only production posture; the OCR worker binds loopback `127.0.0.1:8081`.
- **Admin API** (`app/admin_api.py`) gates every route through `admin_required_json()` / `user_is_admin`.

---

## Prioritized recommendations

1. **C-1** — Add the missing `A mod N == 0` (and `u == 0`) guard to `SrpServerSession.step2`; add regression tests across all three SRP endpoints. Clear-cut.
2. **M-2** — Couple WAN exposure with Secure cookies + HSTS (fail-closed when `NOTES_DISABLE_CIDR_GATE=1` without `NOTES_SECURE_COOKIES=1`).
3. **M-1** — Move pCloud backups to token-only and/or encrypt stored passwords at rest.
4. **L-11 / L-2** — Key per-user upload directories by `user_id`; drop or strengthen the `sessionStorage` password fingerprint and boot-key handling.
5. **L-1 / L-7 / L-10 / L-9** — Reduce reconnaissance surface and finish CSP hardening.

## Out of scope (per request)

- No production/deploy changes, no dependency CVE database audit, no live penetration testing.
- No exploit proof-of-concept, attack procedure, or payload is included; findings cite file/function evidence and root cause only.
