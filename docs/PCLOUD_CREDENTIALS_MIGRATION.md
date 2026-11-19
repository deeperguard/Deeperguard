# pCloud backup credentials (2026-10-30)

Deeperguard no longer stores pCloud **account passwords** on the server. Scheduled backups use an **rclone OAuth token** only. Tokens are **encrypted at rest** on disk; the encryption key is in `config/deeperguard.env`, not under `keys/`.

## Vienna operator steps (one-time)

1. **Generate an encryption key** (keep it only in `deeperguard.env`, never in git):

   ```bash
   openssl rand -hex 32
   ```

2. **Add to** `/opt/deeperguard/config/deeperguard.env`:

   ```bash
   NOTES_PCLOUD_CREDENTIALS_KEY=<64-char-hex-from-step-1>
   ```

3. **Deploy** the release that includes this change (do not `git pull` on Vienna; use `deploy/deploy-deeperguard.sh` from your workstation).

4. **Restart** gunicorn (deploy script does this) so cron and the app see the new env var.

5. **Remove legacy password files** (if any remain after deploy — the app deletes them on settings save and at startup when the key is set):

   ```bash
   rm -f /opt/deeperguard/keys/pcloud-password-*
   rm -f /opt/deeperguard/keys/pcloud-rclone-*.conf
   ```

6. **Tell affected Pro users** (anyone who used WebDAV email/password in Settings):

   - Open Settings → **pCloud backup**.
   - Run `rclone authorize pcloud` on their computer (EU accounts: `--pcloud-hostname eapi.pcloud.com`).
   - Paste the JSON token and save.
   - Re-enable daily sync if needed.

7. **Rotate on pCloud** (recommended): because old WebDAV passwords were stored in plaintext on disk, users should **change their pCloud account password** in pCloud’s security settings and revoke unknown app sessions. Vault note encryption is unchanged; this is only the optional backup integration.

## Key rotation

If `NOTES_PCLOUD_CREDENTIALS_KEY` is compromised:

1. Set a new key in `deeperguard.env`.
2. Restart the app.
3. Each user must **re-paste** their rclone OAuth token in Settings (old ciphertext cannot be decrypted with the new key).

## What is stored where

| Item | Location |
|------|----------|
| Encryption key | `config/deeperguard.env` (`NOTES_PCLOUD_CREDENTIALS_KEY`) |
| OAuth token (encrypted) | `keys/pcloud-token-<user_id>` |
| pCloud username, path, region | SQLite `users` table (not secret) |
| rclone config during sync | Ephemeral file under `keys/`, deleted after each sync |

## OAuth connect (server endpoints)

The server has a "connect pCloud" flow next to the pasted rclone token. The scheduled backup job and
the Settings screen do not use it yet; they still work with the rclone token above.

Operator setup: register an OAuth app at pCloud with redirect URI
`<NOTES_PUBLIC_URL>/api/backup/pcloud/oauth/callback`. pCloud's authorize URL has no scope parameter,
so whether a token is limited to the app folder depends on the "Folder access" setting chosen for
that pCloud app; choose the app-folder option there. (This is from pCloud's documentation as we know
it; it has not been checked against a live pCloud app.) Then add to `config/deeperguard.env`:

```
NOTES_PCLOUD_OAUTH_CLIENT_ID=<client id of the pCloud app>
NOTES_PCLOUD_OAUTH_CLIENT_SECRET=<client secret of the pCloud app>
NOTES_PCLOUD_CREDENTIALS_KEY=<64-char hex, see step 1>
```

Without all three, the start endpoint answers 503.

| Endpoint | What it does |
|----------|--------------|
| `POST /api/backup/pcloud/oauth/start` | Signed-in Pro user, CSRF token required. Puts a random `state` (valid 10 minutes) in the session and returns pCloud's authorize URL. |
| `GET /api/backup/pcloud/oauth/callback` | Rejects a missing, wrong, expired or reused `state` and any API host other than `api.pcloud.com` / `eapi.pcloud.com`. When the user refused access at pCloud (`error` parameter) it redirects to the app with `?pcloud=denied` and stores nothing. Otherwise it exchanges the code for a token, stores it and redirects with `?pcloud=connected`. |
| `POST /api/backup/pcloud/oauth/disconnect` | CSRF token required. Asks pCloud to invalidate the token (`logout`), then deletes the stored token. The answer has `revoked: false` when pCloud did not confirm; the user can then remove the app in their pCloud account settings. |

The token is stored in SQLite table `pcloud_oauth_tokens` only as AES-256-GCM ciphertext
(`dg-pcloud-v1:` envelope) under `NOTES_PCLOUD_CREDENTIALS_KEY`. After a key rotation these tokens
can no longer be decrypted and users must connect again. Token, authorization code and client secret
are not written to the app log. The authorization code is part of the callback URL, so a reverse
proxy or access log that records query strings will record it; a code can be exchanged only once.
