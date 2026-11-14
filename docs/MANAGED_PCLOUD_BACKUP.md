# Managed pCloud backup — design note (idea #97)

Status: **binding design** for the follow-up tasks (b)–(g). Code is not changed by
this note. Where a follow-up task needs to deviate, update this note first.

Goal: a Pro user switches on one toggle, "Automatic backup to pCloud". The backup
goes to the Deeperguard service's own pCloud account, into a directory that belongs
to that user only. The user enters no pCloud credential. After every run the user
gets a plain e-mail.

Build on the existing code. There is no second backup system.

## 0. What happens today (verified in the code, 2026-11-14)

All of this stays and is reused.

**Per-user token model** (`app/backup_pcloud.py`, `app/pcloud_credentials.py`,
`app/config.py`)

- The user pastes an rclone OAuth token (JSON from `rclone authorize pcloud`) plus a
  pCloud username, a remote folder and a region in Settings
  (`POST /api/backup/pcloud/settings`, `app/app.py:2877`, plan-gated with
  `_plan_block(user, "pcloud_backup")` when enabling).
- `save_pcloud_settings` validates the token (`normalize_pcloud_token`: JSON with
  `access_token`), encrypts it at rest (`config.write_pcloud_token` →
  `pcloud_credentials.encrypt_at_rest`, key `NOTES_PCLOUD_CREDENTIALS_KEY` from
  `deeperguard.env`) and writes `keys/pcloud-token-<user_id>` with mode 0600. The
  per-user columns are `pcloud_enabled`, `pcloud_username`, `pcloud_remote_path`
  (default `Deeperguard/backups`), `pcloud_region`, `pcloud_last_sync_at`,
  `pcloud_last_sync_status`, `pcloud_last_sync_detail` (`app/db.py:155-170`).
- `rclone_remote_env` builds an rclone remote **in memory** through
  `RCLONE_CONFIG_DEEPERGUARD_*` environment variables and runs rclone with
  `--config /dev/null`. No config file is written.
- Passwords are no longer accepted (`docs/PCLOUD_CREDENTIALS_MIGRATION.md`);
  legacy password/config files are removed at startup
  (`pcloud_credentials.migrate_all_pcloud_secrets`, `app/app.py:4175`).

**Run** (`app/backup_cron.py`, `deploy/cron/deeperguard-backup`: daily 03:00, root)

- `run_backups` takes `maintenance_lock(blocking=False)`; if held, it skips the run.
- It first calls `run_pcloud_backups()` (pCloud before e-mail, to avoid OOM), then
  sends e-mail backups for `users_with_backup_enabled()` (only to verified
  recipients, `email_verify.recipient_verified`).
- `run_pcloud_backups` loops over `db.users_with_pcloud_enabled()`
  (`pcloud_enabled = 1 AND pcloud_username != ''`). Missing token → status `error`,
  `log_backup`, failure mail, continue. Otherwise `sync_user_backup`; any exception
  is caught per user, logged, mailed, and the loop continues. So one user's failure
  does not stop the others (requirement 8 already holds for the token model).
- `sync_user_backup`: `ensure_local_full_backup(user_id, max_age=7200)` reuses a
  local full archive younger than 2 h or streams a new one
  (`backup_mail.write_local_full_backup_streaming` →
  `data/backups/user-<user_id>-<UTC stamp>-full.enc.json.gz`; local retention
  `NOTES_BACKUP_LOCAL_KEEP`, default 14). It uploads that one file with
  `rclone copy <file> deeperguard:<remote_path> --transfers 1 --timeout 45m`
  (never `sync`), then `rclone delete … --include user-<id>-*.enc.json.gz
  --min-age <PCLOUD_RETENTION_DAYS>d` (default 7 d, `NOTES_PCLOUD_RETENTION_DAYS`).
  A prune error is only a warning. Status goes to `users.pcloud_last_sync_*` and a
  row to the backup log (`db.log_backup`).
- All rclone calls use `subprocess.run` with an argument list, no shell, and a
  timeout (`NOTES_PCLOUD_RCLONE_TIMEOUT`, default 7200 s; prune ≤ 1800 s).

**Failure mail**: `notify_pcloud_backup_failure` sends via
`mailer.send_plain_email` to `backup_email or email`. There is **no success mail**
and **no verified-address check** on this path (the e-mail backup path does have
one). The body tells the user to paste a new token, and includes `Detail:` with up to
500 characters of raw rclone stderr (`_format_rclone_error`) — acceptable when the
remote is the user's own account, **not acceptable** for a shared account (see §4).

**Plans**: `plans.py` feature `pcloud_backup` is Pro only
(`app/plans.py:119`). It is not changed. `tests/test_round82_free_tier.py:48` asserts
free has no `pcloud_backup`.

**Tests**: `tests/test_backup.py` covers: pCloud runs before e-mail; pCloud kept when
e-mail raises; upload uses `copy`, never `sync`; one `delete` with `--min-age 7d`;
failure mail on error and on missing token; token JSON validation; in-memory remote
env.

**Not present today**: no restore through the app (the user restores from the file
with the client), no cleanup of the remote when a user switches off or deletes the
account (`db.purge_user_data` removes only local data), no success mail, no
managed/service remote, no per-user opaque id.

**Observed facts that shape this design**

1. The backup file is gzip JSON with `format`, **`user_email`**, `kdf_salt`,
   `exported_at`, `item_count` and the items (`write_local_full_backup_streaming`).
   The e-mail address and salt are therefore **readable in plain text** by anyone
   who can read the file. Items are ciphertext. With the user's own pCloud that was
   acceptable; on a shared account it defeats the opaque directory name (§2).
2. The file name is `user-<sequential id>-…`; `--include user-<id>-*` is the
   retention filter.
3. `pcloud_remote_path` is user-supplied and only `strip("/")`-ed
   (`normalize_remote_path`); `..` is not rejected. Harmless for the user's own
   account, fatal on a shared one. The managed path must not use it.

## 1. Service remote and settings

Settings (env, `deeperguard.env`; documented in `deploy/deeperguard.env.example` and
`docs/SELF_HOST.md` by task (g)):

| Setting | Meaning | Default |
|---|---|---|
| `NOTES_PCLOUD_SERVICE_REMOTE` | Name of an rclone remote the operator configured on the server | empty → feature unavailable |
| `NOTES_PCLOUD_SERVICE_ROOT` | Base folder in that remote | `Deeperguard/users` |
| `NOTES_PCLOUD_SERVICE_RCLONE_CONFIG` | Optional path to an rclone config file | empty → rclone's default |

Rules:

- The remote name must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` (no `:`, `/`, `.`,
  spaces, leading `-`). A name that does not match is treated as "not set" and
  logged once with the setting name only.
- `NOTES_PCLOUD_SERVICE_ROOT` is normalised once at start: split on `/`, every
  segment must match `^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$`, no `.`/`..` segment, no
  empty segment, ≤ 4 segments. Invalid → fall back to feature unavailable (not to
  the default; a typo must not silently write elsewhere).
- `NOTES_PCLOUD_SERVICE_RCLONE_CONFIG`, when set, must be an absolute path to an
  existing regular file; it is passed as `--config <path>`. Otherwise rclone's own
  default config is used (the managed path does **not** pass `--config /dev/null`,
  unlike the legacy path).
- **The app only knows the remote name.** It never reads, parses, copies, logs or
  returns the rclone config or its token. No Settings field, API response, log line,
  backup, e-mail or error message contains the remote name, root, config path or any
  rclone output (see §4, "secret leakage"). The client only receives
  `{available: bool, reason_code}`.
- **rclone call convention** (one module-level helper, the only place that builds
  managed rclone commands): `subprocess.run([rclone_bin(), "--config", <path>]?,
  <verb>, "<remote>:<path>", …)` — a list, `shell=False` always, `check=False`,
  `capture_output=True`, `timeout=` always set (health check 60 s; upload as today;
  prune ≤ 1800 s), and `stdin=subprocess.DEVNULL`. The remote is only ever written
  as `f"{remote}:{path}"` where `remote` passed the regex and `path` came from the
  path builder (§2). Existing flags are kept (`--transfers 1`, `--timeout`,
  `--multi-thread-streams 0`, retries).
- **Health check** (cheap, never lists users): `rclone lsf <remote>:<root>/__healthcheck
  --max-depth 1 --files-only`, with a 60 s timeout. A missing `__healthcheck` folder
  is not an error: on first success the app runs `rclone mkdir
  <remote>:<root>/__healthcheck`; thereafter `lsf` of an empty directory returns 0.
  It runs **at start-up** and **before each run** (in `run_pcloud_backups`, once per
  run, not per user). Result is cached in memory for the status API
  (`available`, `checked_at`, coarse `reason_code` ∈ `not_configured`,
  `bad_setting`, `rclone_missing`, `unreachable`, `auth`). Failure → the toggle is
  shown as unavailable with a plain explanation, managed runs are skipped, **legacy
  token users are unaffected**, nothing else breaks. A failed health check before a
  run counts as a failed run for every managed user: one failure mail each (subject
  to preference, §6) saying the service is temporarily unavailable.
- `__healthcheck` is reserved and can never equal a user id (ids are 32 hex chars,
  §2).
- The app **never performs or automates the rclone authorization** (no
  `rclone config`, no `rclone authorize`, no token refresh trigger, no browser
  flow). rclone itself refreshes the OAuth token inside the operator's config file;
  that is the only write to it and it is rclone's.

## 2. One directory per user

- Column `users.pcloud_dir_id TEXT NOT NULL DEFAULT ''`. Generated **once**, when the
  user first switches managed backup on, with `secrets.token_hex(16)` (128 bit, 32
  lowercase hex characters). Never derived from e-mail, username, user id, time or
  any other user data; never reused; stored in the DB; UNIQUE index where non-empty.
- Validated with `^[0-9a-f]{32}$` on every read (a wrong value is a hard error for
  that user, not a fallback). Generation is `UPDATE … SET pcloud_dir_id = ? WHERE id =
  ? AND pcloud_dir_id = ''` inside a transaction, so two requests cannot create two
  ids. The id is kept when the user switches off and on again, unless the remote
  directory was deleted for cause (§7): in that case it is **rotated** so a stale
  copy is not re-used.
- **One function builds the path**: `managed_remote_dir(user_row) -> str` returning
  `f"{root}/{pcloud_dir_id}"`. It takes **no** string from request input: its only
  inputs are the DB row (its `pcloud_dir_id` is re-validated by the regex) and the
  start-up-validated root. Upload, list, restore, prune and delete all call it;
  nothing else concatenates a remote path. A test greps the module for other uses of
  the remote name.
- Remote file names are generated server-side: `backup-<UTC stamp>.enc.json.gz`
  (`^backup-\d{8}-\d{6}\.enc\.json\.gz$`), uploaded with `rclone copyto <local>
  <remote>:<dir>/<name>`. The sequential user id and local path do not appear on
  pCloud. Retention filters on `--include "backup-*.enc.json.gz"` **inside the user's
  directory**, so it can never match another directory. Restore takes a name that is
  matched against the regex **and** against the server's own listing of that
  directory; the client never sends a path (it may send an index or a listed
  name).
- Isolation is enforced by code, not cryptography (see §4). Tests (task b) must
  cover: two users get different ids; ids match the regex and have ≥ 128 bits;
  `managed_remote_dir` ignores any injected `pcloud_remote_path`; a corrupted
  `pcloud_dir_id` such as `../x`, `a/b`, `..`, `%2e%2e`, `x\\y`, an empty string, an
  upper-case or 31/33-char id raises and runs **no** rclone command; a restore name
  with `../`, absolute paths, `:`, backslash, NUL or a name not in the user's own
  listing is rejected; the rclone argument lists for user A never contain B's id;
  prune for A never uses a pattern or path outside A's directory.

## 3. Content

Only what the server already stores and already puts in its local full backup
archive: the encrypted vault items as produced by `db.iter_backup_items`, which is
**ciphertext**. The backup never contains plaintext, the vault password, derived
keys, recovery keys, session data or anything that lets the server or pCloud read
notes.

Explicitly **not** in the backup: note plaintext, the vault password or master key,
the KDF-derived key, recovery key material, TOTP secrets, passkeys/WebAuthn
credentials, session tokens, password hashes, e-mail or SMTP settings, pCloud
credentials/tokens (legacy or service), the rclone config, other users' data,
server logs, the SQLite file itself, deleted items' ciphertext (tombstones are
emitted by `iter_backup_items` rules; see `docs/DELETE_SPEC.md`), and Secure Send
links.

**What pCloud and the operator can see.** Not content, but:

- the number of backups, the exact upload time (stamp in the file name and pCloud's
  own timestamps), the file size (grows with vault size and attachments), the
  directory id and that it is one user's;
- pCloud sees the traffic from the server's IP, and its own account logs;
- the operator additionally knows the mapping `pcloud_dir_id` → user (it is in the DB)
  and the sync log;
- **today's archive also contains `user_email` and `kdf_salt` in clear.** For the
  managed target the design requires that task (c) either omits `user_email` from
  the uploaded archive (and the restore path takes the e-mail from the logged-in
  account) or states in the UI that the address is readable in the file. The default
  decision is **omit** unless a check shows restore needs it. `kdf_salt` is not secret
  but is account-specific; it is needed for restore and stays, and is disclosed.
- the item count is inside the file (`item_count`) and visible to anyone who can
  read the file. The UI text must say: "pCloud and we can see how many backups you
  have, when they were made, how big they are and roughly how many items they hold.
  We cannot read what is in them."

## 4. Threat model

Honest summary first: **isolation between users rests on code** (one path builder,
validated random ids, server-side-only names, tests) **and not on cryptography.**
All users' files live in one pCloud account with one OAuth token. Anyone holding
that token, or the server process, can read and delete every user's ciphertext
files. What protects the *content* is the client-side encryption that already exists
(files are ciphertext); what protects *availability and metadata* between users is
code. A code bug or a leaked service token therefore exposes all users' encrypted
files and the metadata above at once. Users who need isolation by cryptography and
by account keep the own-token option (§8) or the e-mail backup.

| # | Threat | Impact | Measure |
|---|---|---|---|
| T1 | Shared service account leaks (rclone config stolen, pCloud account phished, insider) | Attacker gets **all users' ciphertext files** and metadata (§3), can delete or tamper with them. **No plaintext**, since keys are never on the server or in the backup. Offline brute force of weak vault passwords against `kdf_salt` becomes possible for the attacker. | Config readable only by root (0600, outside git and `keys/` backups); token never touched or logged by the app; pCloud 2FA on the service account and a dedicated e-mail address; the service account holds nothing but backups; operator can revoke the token and rotate (then users' old backups are lost with the account, so keep the local archives: `NOTES_BACKUP_LOCAL_KEEP`); item ciphertext remains the only protection of content, which is why vault-password strength is stressed in the UI; incident note: a leak requires disclosure under the privacy policy. Residual risk accepted and disclosed. |
| T2 | Path error: wrong directory, `..`, absolute path, remote-spec injection (`other:path`) | Write/list/delete in the wrong place, including the whole root | Single `managed_remote_dir`; no user input accepted; ids validated `^[0-9a-f]{32}$`; remote name regex; root validated at start; remote written only as `remote:path` built from validated parts; rclone verbs limited to `lsf`, `mkdir`, `copyto`, `copy` (restore to a temp local dir), `delete`, `purge` (§7, on `remote:root/<id>` only, after re-validation and refusing an empty id); never `sync`, never a command on the root itself; list/purge refuses any path that is not exactly `root/<32 hex>`; traversal tests (§2). |
| T3 | Cross-contamination between users (one user's file in another's folder; restore of another's file; retention deleting others' files) | Disclosure of another user's ciphertext/metadata; data loss | Same builder for every operation; file names server-generated; restore only from the server's listing of the caller's own directory; retention `--include` evaluated inside one user's directory; per-user try/except in the run so a failure in one never touches another; no global `rclone delete`/`sync` on the root; unique index on `pcloud_dir_id`; the local archive path is chosen by the server from the user id, not by input. Restored data is still only ciphertext and is decrypted client-side with that user's key; another user's file would not decrypt anyway, but that is not the control. |
| T4 | Secrets leak through logs, errors, mail, UI | Remote name, root, config path, token or other users' ids exposed | rclone stderr/stdout is **never** stored, mailed or returned for the managed path; mapped to a fixed set of reason codes (`service_unavailable`, `service_auth`, `quota`, `timeout`, `upload_failed`, `unknown`) with fixed user-facing texts; logs contain the reason code, user id and exception class, not rclone output, remote name or paths; no `--verbose`/`-vv` flags and no `--dump`; the `Detail:` of the legacy mail is not reused; no stack traces in mail; `pcloud_last_sync_detail` stores the reason code only; backups, API responses and HTML never contain the setting values; the client gets only `available`/`reason_code`. Tests assert that sentinel strings placed in the remote name/root/config path and in a fake rclone stderr never appear in logs, DB status, mail body or API JSON. |
| T5 | Quota and cost: one user, or all users together, fill the service account or bill the operator | Failed backups for everyone, unexpected pCloud cost | Pro plan gate (existing `pcloud_backup`) so only paying users; existing retention (7 days) per user directory, applied after each upload; local full archive is built from the same data as today, so the size is the same as the e-mail/legacy path; a per-user cap on archive size (setting `NOTES_PCLOUD_SERVICE_MAX_BYTES`, default to be fixed in task c, proposed 2 GiB) — over cap fails with reason `too_large` and mail, nothing is uploaded; a global guard: if the health check reports quota/`over quota`, managed uploads pause with reason `quota` and the **operator** is mailed once per run to the existing ops address; one upload per user per run (`--transfers 1`), no manual "sync now" more than once per N minutes (existing `api_backup_pcloud_sync` plan gate kept); the operator monitors pCloud usage; there is no per-user quota inside pCloud, which is disclosed here as a limit. |
| T6 | Mail abuse (using the failure/success mail to spam a third party, mail bombing, leaking others' info) | Reputation damage, harassment | Mail goes only to the user's own verified address (`email_verify.recipient_verified(user, recipient)`; unverified → no mail, log `skipped`, status shows "no verified address"); recipient is never taken from request input in this path; exactly one mail per user per run (`mail_sent_for_run` guard); fixed templates, no user-controlled text, no paths, no rclone output, no other users' data; mail failures are caught and logged and never stop the run; the existing SMTP rate limits/caps are respected; a change of backup address still requires its existing verification flow (`backup_email_verified`). |
| T7 | Stale or deleted data stays on pCloud | Privacy / DPA breach | Switching off and account deletion remove the directory (§7); retention; disclosure that pCloud's own trash/recycle may keep deleted files for a period (confirm and state in the legal texts); failed deletion is retried (§7). |
| T8 | rclone/service outage or token expiry unnoticed | Silent loss of protection | Health check before each run; per-user status and mail; operator-level alert via the existing log/monitoring; last-success time shown in Settings; local archives continue regardless. |
| T9 | Operator misuse or process compromise (root) | Everything above, plus plaintext tokens in memory | Out of scope for cryptographic protection: the app runs as root on the server that already holds all ciphertext. Documented as a trust assumption. |

## 5. Retention and plan limits

Unchanged in behaviour, now per user directory:

- Feature gate: `pcloud_backup` (Pro) in `plans.py`; unchanged and not a pricing
  change. Enabling needs the plan; a downgraded user is skipped by the run (status
  `plan`, one mail) and their directory is deleted after the grace period already
  used for plan downgrades (task c to reuse the existing downgrade handling; if none
  exists for backups, the directory is kept and the run is skipped — never deleted on
  a downgrade alone).
- Retention: `NOTES_PCLOUD_RETENTION_DAYS` (default 7) via `rclone delete
  <remote>:<root>/<id> --include "backup-*.enc.json.gz" --min-age <N>d`. Today's
  behaviour is kept, with one addition required by the "how many backups are kept"
  line of the mail: after pruning, list the directory (`rclone lsf`, still only that
  directory) and count matching names. Prune never removes the newest file just
  uploaded (min-age > 0) and never runs if the upload failed.
- Local archive retention `NOTES_BACKUP_LOCAL_KEEP` (default 14) unchanged.
- The run stays inside the existing `maintenance_lock` and the existing cron (daily
  03:00); no new schedule.

## 6. E-mail after each run

Build on `mailer.send_plain_email`. One mail per user per run, to the user's
**verified** address only (`email_verify.recipient_verified`; target is
`backup_email` when set and verified, otherwise the account e-mail when
`account_verified`). If neither is verified: no mail, status shows it, the run still
happens.

- Preference column `users.pcloud_mail_pref TEXT NOT NULL DEFAULT 'both'` with
  values `both` | `failures` ("only errors"). `both` is the default as the owner
  asked. Validated against that set on write.
- **Success** (when pref = `both`): time (UTC and ISO), size of the new backup,
  number of backups kept, a one-line reminder of what is and is not in it, how to
  switch it off.
- **Failure** (always sent): one fixed sentence per reason code, what the user can do
  (retry later / contact support / free space etc.), no technical detail. No
  secrets, no paths, no stack traces, no rclone output, no other users' ids.
- Retry: a failed run is retried at the next schedule (no extra retries inside a
  run beyond rclone's own `--retries`); the failure is mailed **once per run**. A
  second consecutive failure is mailed again (once per run), as the owner asked for
  a mail after every run. Subject lines: `Deeperguard: pCloud backup succeeded` /
  `Deeperguard: pCloud backup failed`.
- The legacy token path keeps its current failure mail text, but its recipient also
  gains the verified check (small fix in task d) and the success mail honours the
  same preference.

## 7. Restore, switch-off and account deletion

**Restore** (task f): the user can list and restore only from their own directory.
The server lists `managed_remote_dir(user)` (names matching the regex, with size and
time), the client picks one entry, the server downloads it with `rclone copyto` to a
temporary file in a private temp dir (size-capped, deleted afterwards) and streams
it to the logged-in user. The response contains ciphertext only, and is decrypted
client-side with the user's key, exactly like a file backup today. No path or id is
accepted from the client; the dir id is never shown to the client. Plan check and
`auth.current_user_id()` as for the settings endpoint; rate-limited.

**Switching off**: the toggle off stops uploads immediately and then deletes the
user's remote directory (`rclone purge` on exactly `root/<id>`), after an explicit
confirm dialog that says the pCloud copies will be removed. Set `pcloud_enabled = 0`
first, then purge; on purge failure keep a `pcloud_cleanup_pending = 1` flag, retry
in the next cron run, show "removal pending" in Settings. When the purge is
confirmed, clear `pcloud_dir_id` (a new id is generated on the next enable). Local
archives are unaffected by this toggle (they follow the local retention).

**Account deletion**: `db.purge_user_data` must first (or as part of the same
flow) request remote removal using the same code. Because the user row is deleted
there, the pending state needs a small table `pcloud_cleanup(dir_id TEXT PRIMARY KEY,
created_at REAL, attempts INTEGER)` where only the opaque id is stored (not
e-mail); the cron retries until success or an operator-set maximum, then logs for the
operator. The id in that table is validated with the same regex before any call.

**Update `docs/DELETE_SPEC.md`** (task f/g): the "Server-side backups" row and the
claims need these changes: managed pCloud copies are removed when the user switches
the feature off or deletes the account (and not by deleting a single note); they
otherwise age out with the retention window; pCloud's own trash may keep deleted
files for a limited time (state the period once confirmed with pCloud). Claim 4
becomes "…pCloud copies on the Deeperguard account follow the retention window and
are removed when you switch the backup off or delete your account."

## 8. Migration of users with their own token

- Nothing changes for them automatically. Users with `pcloud_enabled = 1` and a
  stored token keep running through the **existing** code path to **their own**
  pCloud, with their own `pcloud_remote_path`. Their old backups are never touched,
  moved or deleted by the migration or by the switch-over.
- New column `users.pcloud_mode TEXT NOT NULL DEFAULT ''`: `''` = off,
  `'own'` = own token (existing behaviour), `'managed'` = service remote. A DB
  migration backfills `'own'` for every row with `pcloud_enabled = 1` and a
  non-empty `pcloud_username`, and `''` otherwise. `users_with_pcloud_enabled()` and
  the run dispatch on that column; `run_pcloud_backups` runs both lists, each user
  in its own try/except.
- Settings UI shows, for `own` users, their current setup with a notice "You use your
  own pCloud account" and a button "Switch to managed backup". For everyone else
  only the single toggle. The credentials fields are removed from the UI for users
  without a token; users with a token keep a collapsed "Own pCloud account
  (advanced)" section until they switch. Hidden on the server too: the
  `/api/backup/pcloud/settings` endpoint keeps accepting token fields **only** for
  `own` users.
- **Switching** `own` → `managed`: explicit confirm that says what happens: new
  backups go to the Deeperguard-managed pCloud; the old backups in the user's own
  pCloud stay there untouched and are not deleted by us (the user may delete them);
  their stored token is deleted from the server (`keys/pcloud-token-<id>`) so it is
  not kept unused; an immediate first managed backup is made. Switching back is
  possible only by pasting a token again (a deliberate asymmetry). A user is never
  in both modes.
- Plan downgrade or the managed service being unavailable never converts or removes
  `own` users.
- Rollback: unset `NOTES_PCLOUD_SERVICE_REMOTE`; managed users show as unavailable
  and are skipped (no data deletion); `own` users are unaffected.
- `NOTES_PCLOUD_CREDENTIALS_KEY` and the `docs/PCLOUD_CREDENTIALS_MIGRATION.md`
  steps stay valid for `own` users; that document gets a pointer to this note.

## 9. Data model and DB migration

Added by `ALTER TABLE` guards in the same style as `app/db.py:155-196` (check
`PRAGMA table_info`, add if missing; idempotent; no destructive change):

| Column / table | Type | Default | Purpose |
|---|---|---|---|
| `users.pcloud_mode` | TEXT | `''` | `''` / `'own'` / `'managed'`; backfilled as in §8 |
| `users.pcloud_dir_id` | TEXT | `''` | 32-hex opaque directory id; UNIQUE index `WHERE pcloud_dir_id != ''` |
| `users.pcloud_mail_pref` | TEXT | `'both'` | `'both'` / `'failures'` |
| `users.pcloud_cleanup_pending` | INTEGER | `0` | remote directory removal still to do |
| `users.pcloud_last_size` | INTEGER | `0` | size of last uploaded backup (for the status line) |
| `users.pcloud_last_kept` | INTEGER | `0` | backups kept after the last prune |
| `pcloud_cleanup` | table | — | `dir_id` (PK), `created_at`, `attempts`; for deleted accounts (§7) |

Existing `pcloud_last_sync_at/status/detail` are reused; for managed users
`status` ∈ `ok`/`error`/`skipped` and `detail` holds a reason code only. `pcloud_username`, `pcloud_region` and
`pcloud_remote_path` are ignored in managed mode. The existing `db.log_backup` row is
written with a fixed target label such as `managed`, not a path.

New helpers (names indicative): `db.set_pcloud_mode`, `db.ensure_pcloud_dir_id`,
`db.users_with_managed_pcloud_enabled`, `db.queue_pcloud_cleanup`. The settings API
`GET`-side payload (`app/app.py:2340`) gains `pcloud_mode`, `pcloud_managed_available`,
`pcloud_managed_reason`, `pcloud_mail_pref`, `pcloud_last_size`, `pcloud_last_kept`
and never `pcloud_dir_id`. A new endpoint for the toggle, mail preference, restore
list and restore download; all behind the session and the plan gate; none accepts a
path.

## 10. Operator text

**The only step is: set `NOTES_PCLOUD_SERVICE_REMOTE`.** Until it is set, the feature
is unavailable to users and nothing else changes.

Production on 2026-11-14 (checked read-only by the owner's assistant): rclone v1.68.2
at `/usr/bin/rclone`, app service runs as root, **no rclone remote exists yet** (no
`rclone.conf`, `rclone listremotes` is empty), a backup cron exists in
`/etc/cron.d/deeperguard-backup`. So the remote must be created once, by a human,
outside the app. The app never does this.

1. On a computer **with a browser** (not the server), with rclone installed:

   ```bash
   rclone authorize "pcloud"
   ```

   Log in to the dedicated pCloud service account in the browser. rclone prints a
   token JSON (`{"access_token":…}`). Copy it; treat it like a password.

2. On the server, as root, create the remote (name `deeperguard-service` here; any
   name matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` works):

   ```bash
   rclone config
   ```

   Choose `n` (new remote), name `deeperguard-service`, storage type `pcloud`, leave
   client id/secret empty, **region: EU** (`eapi.pcloud.com`, hostname for EU
   accounts), answer `n` to "Use auto config?" (the server has no browser), paste
   the token from step 1, confirm, `q`. Then restrict the file:

   ```bash
   chmod 600 "$(rclone config file | tail -n1)"
   ```

3. Verify:

   ```bash
   rclone lsd deeperguard-service:
   ```

   It must list the account's top-level folders (or nothing for a new account)
   without error.

4. Set the one setting in `/opt/deeperguard/config/deeperguard.env`:

   ```bash
   NOTES_PCLOUD_SERVICE_REMOTE=deeperguard-service
   ```

   (`NOTES_PCLOUD_SERVICE_ROOT` defaults to `Deeperguard/users`;
   `NOTES_PCLOUD_SERVICE_RCLONE_CONFIG` is only needed if the config is not in
   rclone's default location for root.)

5. Restart the app service (the deploy script does this) and check Settings: the
   toggle is available. The next 03:00 cron run uses it.

Notes for the operator: do not put the config or token in git or in `keys/`; use a
dedicated pCloud account with 2FA; watch the pCloud quota; before go-live the legal
texts below must be updated; to stop the feature unset the variable and restart.

## 11. Task split (unchanged from the idea)

(b) server credential, health check, `managed_remote_dir`, isolation tests;
(c) managed run, retention, `pcloud_mode` dispatch, reason codes, DB migration;
(d) e-mail after each run and preference; (e) Settings UI and status (toggle,
honest text from §3, mode notice); (f) restore and deletion, update
`DELETE_SPEC.md`; (g) docs, `deploy/deeperguard.env.example`, `docs/SELF_HOST.md`.
Free-tier and pricing tests stay as they are.

## Juridische teksten die de eigenaar vóór livegang moet bijwerken

This feature makes pCloud a storage provider for user ciphertext on the owner's own
account. This note changes **no** legal text. Before the feature goes live the owner
must update exactly these:

1. **Privacy Policy** (public page and `docs/PRIVACY.md` if it mirrors it):
   - name **pCloud** (pCloud AG / its EU entity, region EU) as a storage provider for
     the optional automatic backup, and the purpose and legal basis (performing the
     service the user switched on; off by default);
   - say that only **ciphertext** is stored and that the backup file is not readable
     by pCloud or by us;
   - list the **metadata** pCloud and we can see: number of backups, upload times,
     sizes, rough item count, the opaque directory id, IP of the server; and, if
     task (c) keeps it, the account e-mail and KDF salt in the file;
   - the **retention period** (7 days by default, per user directory, plus pCloud's
     own trash period once confirmed) and that local archives are kept longer;
   - **deletion**: removed when the user switches the feature off or deletes the
     account; what is not removed (copies the user exported, e-mailed backups, the
     user's own-token pCloud backups);
   - the difference with the "own pCloud account" mode;
   - the one-mail-per-run notification and the preference.
2. **List of processors / subprocessors**: add pCloud with its purpose, data
   categories (encrypted backups, metadata), location (EU) and the service name.
3. **Data processing agreement (DPA) with pCloud**: the owner must have a DPA /
   data-processing terms in place with pCloud for the service account (business
   terms rather than a consumer plan if needed), including EU data location, deletion
   on request, breach notification and subprocessor terms. Check the account type
   allows storing third parties' data.
4. **Terms of Service**: only if they name backup locations or storage providers
   (e.g. "backups go to your own pCloud / only e-mail"); update those passages, the
   Pro feature description for pCloud backup, the shared-account availability
   (best-effort, no guarantee), and the deletion behaviour. Also check any
   Security/FAQ page that repeats the wording of `docs/DELETE_SPEC.md` (SECURITY.md
   and the marketing FAQ carry it today).

Pricing and plan definitions are not changed.
