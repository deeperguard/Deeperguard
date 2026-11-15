# What "delete" actually does — spec of truthful claims

Scope: permanent delete / Empty trash of a note (and its attachments). Moving to
Trash is only an edit (`content.trashed`) and removes nothing. Verified against
the code at the paths cited; re-check them when those paths change.

## Copy by copy

| Copy | What delete does | Confirmed when | Source |
|---|---|---|---|
| In-memory note, search index | Marked deleted, removed from the search index. Attachments of the note are deleted with it. | Immediately | `store.js` `remove`, `persistLocal` |
| This device's IndexedDB | The note row is removed. If the delete has not been pushed yet, a small tombstone row (empty ciphertext, `deleted: true`, id + timestamp only) is kept so the delete survives a lock/reload. That row is dropped after the server accepts it. | Immediately (tombstone row excepted until pushed) | `store.js` `persistLocal`, ~2373 |
| `localStorage` / `sessionStorage` | Not a note store. Delete does not scrub it. | n/a | — |
| Server row | On the next successful sync push, the server row is overwritten with `deleted = 1`, the pushed ciphertext (an encrypted tombstone, not the note body) and an emptied `blob_ciphertext`. The old note ciphertext is replaced in that row. | Only when the push returns `ok` | `db.py` `upsert_item`; `store.js` ~2117 |
| Server tombstone | The `deleted = 1` row (uuid, timestamps, rev, small ciphertext) stays so other devices learn of the delete. We found no routine purge of tombstones; they go only with account deletion (`purge_user_data`). | Never removed while the account exists | `db.py` |
| Other signed-in devices | Remove their copy when they next pull the tombstone. Offline devices still hold the note. A newer edit elsewhere can win (last-writer-wins) and the note may reappear. | Per device, after it syncs | `store.js` ~2976 |
| Server-side backups | Backups are built from `deleted = 0` rows, so new backups omit the note. Already-written backups are not rewritten: local archives (newest `NOTES_BACKUP_LOCAL_KEEP`, default 14), pCloud copies (`NOTES_PCLOUD_RETENTION_DAYS`, default 7 days), and emailed backups already in the user's mailbox. They are ciphertext, but still contain the note until they age out or are deleted by the user. | Gone only after the retention window; emailed copies never (user-controlled) | `backup_mail.py`, `backup_pcloud.py`, `db.iter_backup_items` |
| Exports / downloads the user made | Not reachable. | Never | — |
| Secure Send links | Deleting a note does not revoke a link made from it. Links die on revoke, view limit, lockout or expiry (max 7 days); ciphertext is purged then and the metadata row is dropped 7 days after expiry. | By revoke/expiry, not by note delete | `secure_send.py`, `db.prune_secure_sends` |
| Anything a recipient already opened or saved | Not reachable. | Never | — |

There is no per-note sharing of live notes with other accounts; "shared" copies
means Secure Send links (above) and anything the user exported.

## Claims the dialog may make

1. "Removed from this device as soon as you confirm."
2. "Removed from the server once sync uploads the delete. The server keeps a small encrypted marker so your other devices know." (Not "erased".)
3. "Other devices remove it when they next sync; offline devices still have it until then."
4. "Existing backups are not changed. They age out: server copies after the retention window (default: 7 days on pCloud, newest 14 local archives); backup emails already in your inbox stay until you delete them. pCloud copies on the Deeperguard account follow the retention window and are removed when you switch the backup off or delete your account."
5. "Secure Send links made from this note keep working until revoked or expired."
6. "We cannot delete copies you exported or that a recipient saved."

## Claims the dialog must not make

- "Permanently erased", "gone everywhere", or "no copies remain".
- That the server tombstone is deleted.
- That backups are purged by a note delete.
- That a Secure Send link stops working because the note was deleted.
- That an offline or unsynced device is confirmed gone.

## Review status

Reviewed against `db.upsert_item`, `db.iter_backup_items`, `db.prune_secure_sends`,
the backup retention settings and the client push payload. The dialog in
`app/static/js/deletion-sync-honesty.js` now covers items 1–6 and makes none of
the forbidden claims. SECURITY.md and the marketing FAQ carry the same wording.

## Managed pCloud backup: removal on switch-off and account delete

Scope: the per-user directory on the Deeperguard service remote
(`NOTES_PCLOUD_SERVICE_REMOTE` / `NOTES_PCLOUD_SERVICE_ROOT`, see
`MANAGED_PCLOUD_BACKUP.md`). A single note delete never touches it.

| Trigger | What happens | Source |
|---|---|---|
| User switches managed backup off (after the confirm dialog; the API needs `confirm: true`) | `managed_backup_enabled = 0` first (no more uploads), the opaque id is queued in `pcloud_cleanup`, then `rclone purge <remote>:<root>/<dir_id>` runs on exactly that path. Only after rclone reports success is the queue row dropped and `users.pcloud_dir_id` cleared (a new id is made on the next enable). | `backup_pcloud.disable_managed_and_cleanup`, `attempt_cleanup`, `db.finish_pcloud_cleanup` |
| Account is deleted | `db.purge_user_data` queues the user's `pcloud_dir_id` (only the opaque id, no e-mail) before the user row is deleted, then a background purge is attempted. Deleting the account is never blocked by the remote. | `db.purge_user_data`, `admin_api.api_admin_delete_user` |
| Remote unreachable / rclone fails | The queue row stays (attempt counter +1), the id stays on the user row (switch-off) and the next backup cron run retries (`run_pending_cleanups`), up to 50 attempts, then it is left for the operator. Settings shows "removal pending". Switching the backup on again cancels the pending removal so a stale retry can never purge newer backups. | `backup_cron._run_backups_locked`, `db.enable_managed_backup` |
| Directory already gone | rclone "not found" counts as purged. | `backup_pcloud.purge_remote_dir` |

Safety rules for the purge: the path is only `<configured root>/<dir_id>`, and
`dir_id` must match `^[0-9a-f]{32}$`. An empty, short, non-hex or traversal id is
refused (`bad_path`) before rclone is called, so purge can never target the root or
a parent folder. An invalid queued id is dropped, not retried.

Restore (read side): a user can only list and restore from their own directory
(`user_backup_path`). The `backup_id` from the request must match
`^[0-9]{8}-[0-9]{6}$` and be present in the server-side listing of that user's own
directory, otherwise it is refused. Restore writes ciphertext only and needs a
confirm dialog (`confirm: true`).

Honest claims: pCloud copies are removed from the Deeperguard service account when
switching off or deleting the account; pCloud's own trash may keep deleted files for a
limited period (confirm the exact period with pCloud before stating it in the UI).
Backups already mailed to the user, or exported by the user, are not reachable.
