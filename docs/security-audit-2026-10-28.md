# DeeperGuard security audit (internal code review)

**Date:** 2026-10-28  
**Scope:** `main` branch — Flask API, sync/auth/admin paths, Secure Send, backups, client crypto (`app/static/js/crypto.js`, `store.js`, service worker), CSP/session headers  
**Method:** Static review of source and existing security regression tests (`tests/test_round49_security.py`, `test_round56_security.py`, `test_round63_security.py`, sync/Secure Send tests). No live penetration test of production credentials, Cloudflare rules, or Vienna host configuration.  
**Verdict (Crucial):** **Crucial issues remain** — one **High** user-credential exposure (pCloud WebDAV password at rest on server) is still open after this PR. Public `/security` marketing page was **not** added (policy: only when no Critical/High remain).

---

## Executive summary

DeeperGuard’s core vault model matches the product claims: note bodies are AES-GCM encrypted in the browser before sync; the server stores ciphertext and sync logs record counts/metadata only, not note content. Auth for the notes API uses server-side sessions with CSRF on mutating routes, SRP for zero-knowledge login, optional WebAuthn/TOTP, and rate limits on sensitive flows including Secure Send.

**Crucial (Critical or High still open):** **Yes** — optional Pro **pCloud backup** still stores the user’s WebDAV password in plaintext under `keys/pcloud-password-*` on the server so scheduled rclone sync can run. OAuth token auth avoids this; the issue is documented in [SECURITY.md](../SECURITY.md) and unchanged in scope here.

This PR adds an internal audit record, fixes **M-7** (offline shell Cache Storage could retain decrypted note titles/bodies in cloned DOM while `#app` was only hidden), and removes a weak **`Math.random` AES-GCM IV fallback** in `crypto.js`.

---

## Findings

| ID | Severity | Title | Impact on user data | Evidence | Recommendation |
|----|----------|-------|---------------------|----------|----------------|
| **H-PCLOUD** | **High** | Plaintext pCloud WebDAV passwords on server disk | Server (and anyone with filesystem access) can read users’ pCloud credentials; not vault keys, but full cloud backup account access | `app/config.py` (`write_pcloud_password`, `pcloud_password`); `app/backup_pcloud.py` (`write_rclone_config`); [SECURITY.md](../SECURITY.md) known-open table | Prefer rclone OAuth token only; encrypt at rest or use a secret manager; document migration off password auth |
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
