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
