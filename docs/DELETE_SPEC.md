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
4. "Existing backups are not changed. They age out: server copies after the retention window (default: 7 days on pCloud, newest 14 local archives); backup emails already in your inbox stay until you delete them."
5. "Secure Send links made from this note keep working until revoked or expired."
6. "We cannot delete copies you exported or that a recipient saved."

## Claims the dialog must not make

- "Permanently erased", "gone everywhere", or "no copies remain".
- That the server tombstone is deleted.
- That backups are purged by a note delete.
- That a Secure Send link stops working because the note was deleted.
- That an offline or unsynced device is confirmed gone.

## Gaps vs current copy

`app/static/js/deletion-sync-honesty.js` already covers items 1–3. It does not
mention backups, the retained server marker, or Secure Send links (items 4–5);
adding them is the follow-up code change.
