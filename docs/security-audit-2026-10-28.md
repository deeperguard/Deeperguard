# DeeperGuard security audit (internal code review)

**Date:** 2026-10-28  
**Scope:** `main` branch — Flask API, sync/auth/admin paths, Secure Send, backups, client crypto (`app/static/js/crypto.js`, `store.js`, service worker), CSP/session headers  
**Method:** Static review of source and existing security regression tests (`tests/test_round49_security.py`, `test_round56_security.py`, `test_round63_security.py`, sync/Secure Send tests). No live penetration test of production credentials, Cloudflare rules, or Vienna host configuration.  
**Verdict (Crucial):** at review time (2026-10-28) **Crucial issues remained** — one **High** user-credential exposure (pCloud WebDAV password at rest on server). **Status 2026-11-20:** that High is resolved (see *Status update* below); the residual is listed there. Public `/security` marketing page was **not** added in this PR (policy: only when no Critical/High remain).

> **This is an internal code review. No independent security audit has been carried out.** See [security/AUDIT_SCOPE.md](security/AUDIT_SCOPE.md).

---

## Executive summary

DeeperGuard’s core vault model matches the product claims: note bodies are AES-GCM encrypted in the browser before sync; the server stores ciphertext and sync logs record counts/metadata only, not note content. Auth for the notes API uses server-side sessions with CSRF on mutating routes, SRP for zero-knowledge login, optional WebAuthn/TOTP, and rate limits on sensitive flows including Secure Send.

**Crucial (Critical or High still open):** at review time **yes** — optional Pro **pCloud backup** stored the user’s WebDAV password in plaintext under `keys/pcloud-password-*` on the server so scheduled rclone sync could run. As of 2026-11-20 no Critical or High item in this review is open (H-PCLOUD is resolved, see below).

This PR adds an internal audit record, fixes **M-7** (offline shell Cache Storage could retain decrypted note titles/bodies in cloned DOM while `#app` was only hidden), and removes a weak **`Math.random` AES-GCM IV fallback** in `crypto.js`.

---

## Status update (2026-11-20): H-PCLOUD resolved

**Resolved:** the server no longer accepts, stores or logs a pCloud account password. Checked against the code on this branch and the tests listed below; the tests were run on 2026-11-20 and passed.

- **Not accepted:** `/api/backup/pcloud/settings` answers 400 with `PASSWORD_REJECTED_DETAIL` when a `password` is sent (`app/app.py:3436-3437`, `app/backup_pcloud.py:37-38`).
- **Not stored:** the `pcloud_password` column is wiped and dropped at startup (`app/db.py:187-199`). Legacy `keys/pcloud-password-*` and `keys/pcloud-rclone-*.conf` files are deleted on save, at startup and at each run (`app/pcloud_credentials.py:92-104`, `:131-147`).
- **Not logged:** no log call in `app/backup_pcloud.py`, `app/pcloud_oauth.py` or `app/backup_cron.py` writes a password; the logging guard `tests/test_no_readable_backup_secret.py::test_no_secret_in_log_lines` checks this.
- **Proving tests:** `tests/test_app.py::test_pcloud_settings_password_rejected_and_not_stored` (password rejected, not echoed, no `pcloud-password-*` file); `tests/test_pcloud_password_migration.py` (column dropped, old password bytes absent from the DB file and WAL, connections flagged `reconnect_needed`, a second start changes nothing); `tests/test_pcloud_credentials.py` (legacy files removed, token encrypted on disk, rclone gets its token from the environment and no token file is written); `tests/test_no_readable_backup_secret.py` (no literal secret in app code or example env, no plaintext rclone config).
- **Commits:** `33ee676` (#1005, migration and reconnect flag); `5fbcedb` (#988, scheduled job on OAuth token); `f76820d` (#908, OAuth connect with encrypted token); `869d079` (#905, design note).

**Residual risk (not closed by this fix):**

- The server keeps an rclone OAuth token for scheduled pCloud backups. It is AES-256-GCM encrypted (`dg-pcloud-v1:` envelope, `app/pcloud_credentials.py:55-77`) under `NOTES_PCLOUD_CREDENTIALS_KEY`, which sits in `config/deeperguard.env` on the same host. Whoever controls the server can decrypt the token.
- How far the token reaches is not verified against live pCloud. A pasted `rclone authorize pcloud` token may cover the whole pCloud account; an OAuth token from *Connect pCloud* is only app-folder scoped if the pCloud app is set to app-folder access. Users who have not reconnected still run on the pasted token.
- Not yet checked live: whether rclone's error output (stored in `users.pcloud_last_sync_detail`, `app/backup_pcloud.py:245-261`) can contain the token, and whether the token is readable in the rclone process environment. The check is the open task in [design/pcloud-credentials.md](design/pcloud-credentials.md) §1.

---

## Findings

| ID | Severity | Title | Impact on user data | Evidence | Recommendation |
|----|----------|-------|---------------------|----------|----------------|
| **H-PCLOUD** | **High → Resolved 2026-11-20** | Plaintext pCloud WebDAV passwords on server disk | Server (and anyone with filesystem access) could read users’ pCloud credentials; not vault keys, but full cloud backup account access | At review time: `app/config.py` (`write_pcloud_password`, `pcloud_password`); `app/backup_pcloud.py` (`write_rclone_config`). Current evidence and residual risk: see *Status update* above | **Done:** passwords are rejected, dropped and never logged; the server keeps an encrypted OAuth token (residual, see above) |
| **M-7** | Medium | Offline shell cache could embed decrypted note DOM | Shared-device or forensic access to Cache Storage (`deeperguard-shell`) could read note titles/bodies left in hidden cloned HTML | `app/static/js/app.js` — `persistAppShell()` → `writeShellCache(lockedShellHtml())`; prior behavior cloned live DOM without clearing editor/list | **Fixed in this PR:** `scrubShellDomForCache()` clears editor, list, Secure Send fields before cache write |
| **M-SYSTEMD** | Medium | Shipped systemd unit runs as root by default | Host compromise exposes all app data/process | `deploy/systemd/deeperguard.service` (no `User=`); [SECURITY.md](../SECURITY.md) | Operator decision: dedicated user, cap permissions |
| **M-TOTP-OFF** | Medium | Disable account 2FA without SRP password re-proof | Session + TOTP code can turn off 2FA for SRP accounts | `app/app.py` `api_totp_disable`; [SECURITY.md](../SECURITY.md) | Require SRP proof or passkey before disable |
| **M-LEGACY-HASH** | Medium | Legacy `password_hash` may remain on SRP accounts | Server-side hash weakens ZK story if leaked | `app/db.py` `user_has_legacy_password`; repair-login paths in `app/app.py` | Planned purge after migration |
| **M-SERVER-OCR** | Medium | Legacy server-side OCR processes document plaintext | If `NOTES_SERVER_OCR=1`, uploads are OCR’d on server | `app/app.py` `/api/ocr`; `app/config.py` `log_server_ocr_startup_warning` | Keep disabled on production (default `0`); client OCR only |
| **M-ASK-AI** | Medium | Ask AI / Ollama relay sends user-selected plaintext off-device | User-chosen note text decrypted client-side and sent to provider | `app/ai_relay.py`; [docs/PRIVACY.md](PRIVACY.md) | User consent + docs (already disclosed) |
| **L-IV-RNG** | Low | Weak IV if `crypto.getRandomValues` missing | Theoretical GCM weakness on broken environments | `app/static/js/crypto.js` `randomIv()` | **Fixed in this PR:** fail closed with error |
| **L-DEVICE-REMEMBER** | Low | “Remember password on device” stores vault password locally | Physical access to device + browser profile can unlock vault | `app/static/js/vault-secrets.js` (`notes_device_password_enc`); opt-in pref | Keep off by default messaging; user tradeoff |
| **L-WAN-COOKIES** | Low | WAN without `NOTES_SECURE_COOKIES=1` lacks `__Host-` session + HSTS | Session hijack on insecure networks | `app/config.py` `log_wan_secure_cookies_startup_warning`; `app/app.py` `HostOnlySessionInterface` | Production: `NOTES_SECURE_COOKIES=1` per [deploy/PRODUCTION.md](../deploy/PRODUCTION.md) |
| **I-SYNC-LOG** | Info | Sync log is metadata-only | No vault plaintext in logs | `app/app.py` `_sync_log_line`; `app/sync_log.py` | Continue avoiding ciphertext in log lines |
| **I-SECURE-SEND** | Info | Secure Send design reviewed | Ciphertext-only blob; key in URL fragment; rate limits + open verifier | `app/secure_send.py`; `app/app.py` `/api/secure-send*`; `app/static/js/secure-send.js` | Monitor lockout thresholds |

Severity ranks reflect **user-data / account impact** for this product, not CVSS.

---

## Areas reviewed with no issue found (this pass)

- **Sync IDOR:** Item pull/push/refetch scoped by session `uid` (`db.list_items_by_uuid`, `db.upsert_items_batch`); tests cover cross-user wipe and admin boundaries.
- **Secure Send enumeration:** Inactive links return generic stopped copy; IDs are `secrets.token_urlsafe(32)` (`app/secure_send.py`).
- **Session fixation / cookie scope:** New session token on login; `__Host-session` when secure cookies enabled (`app/app.py` `HostOnlySessionInterface`).
- **CSRF / origin:** Mutating API routes require CSRF + same-origin checks (`app/auth.py` `csrf_ok`, `request_is_same_origin`).
- **CSP / XSS baseline:** Nonce-based script CSP on app shell; API responses `Cache-Control: no-store`; marketing paths strip session cookies for cacheability (`app/auth.py` `content_security_policy`, `app/app.py` `_headers`).
- **AI Ollama relay SSRF:** Fixed upstream host `https://ollama.com` only (`app/ai_relay.py` `UPSTREAM`).
- **Email backup payload:** Client-built encrypted `.dgbackup` / server stores gzip ciphertext (`app/backup_mail.py` streaming export).
- **Upload path traversal:** Per-user directories keyed by numeric `user_id` (`app/uploads.py`).
- **TOTP secrets in API:** `/api/account` does not expose `totp_secret`; setup returns ephemeral secret only to authenticated user (`app/app.py` `api_totp_setup`).
- **Admin API:** JSON routes require admin session (`app/admin_api.py` `admin_required_json`); patch/delete require CSRF in tests.
- **Repository secrets:** No committed production env; `.gitkeep` placeholders only under `config/`, `keys/`, `data/`.

---

## Limits of this review

- No dynamic testing against https://www.deeperguard.com or the Vienna VPS.
- Cloudflare WAF/rate limits, tunnel ACLs, and operator secrets were not validated.
- Third-party libraries (Tesseract, pdf.js, etc.) were not fully audited; supply-chain relies on pinned assets and [client integrity /verify](https://www.deeperguard.com/verify).
- Cryptographic proof of SRP/WebAuthn implementations assumes correctness of `@noble` / server `srp_auth` port; reviewed for obvious misuse (verifier binding, kdf-upgrade proofs) via existing tests.

---

## Related documents

- [SECURITY.md](../SECURITY.md) — disclosure contact and known open items  
- [docs/PRIVACY.md](PRIVACY.md) — data handling and Ask AI exception  
- [deploy/PRODUCTION.md](../deploy/PRODUCTION.md) — production hardening checklist  

This document is an **internal static review**, not a paid external penetration test or certification.
