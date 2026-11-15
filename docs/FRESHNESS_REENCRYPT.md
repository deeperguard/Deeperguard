# Freshness: re-encrypt and re-push paths

Other devices remember the highest version (`__fv`) and `content_hash` they
accepted per item (hwm). `NotesFreshness.checkIncoming` reports a **fork** when
an item arrives at the same `__fv` with a different hash, and a **rollback**
when it arrives at a lower `__fv`. Every encryption uses a fresh IV, so a path
that pushes an existing item again with new ciphertext must publish it as a
newer version (`stampForUpsert` with `bump: true`). `stampForWrap` keeps the
version as is ("re-encrypt only") and is only safe when the ciphertext is the
first copy of that version to reach the server.

Fixed paths use `bumpFreshness(uuid, content, floor)` in `store.js`. It wraps
`stampForUpsert({ bump: true, existing: floor })`: the new `__fv` is one above
the highest of the content's own `__fv`, the floor item's `__fv` (e.g. the
server copy) and this device's hwm. `checkIncoming` is unchanged; a real fork
(same `__fv`, different content) is still reported.

Audit: `grep -n "stampForWrap\|wrapItem\|wrapItemForPush\|encryptObject\|dirty.add"`
over `app/`.

| # | File | Function / path | Verdict | Test |
|---|------|-----------------|---------|------|
| 1 | app/static/js/store.js | `upsert` (all edits, incl. `repairAttachmentsWithPreviousPassword`, `restoreAgendaBackup`, `migrateLegacyAgendaSubscriptions`, `writeAgendaPackContent`) | Safe: `stampForUpsert` bumps on every change that syncs | existing |
| 2 | app/static/js/store.js | `changePassword` re-encrypt loop | Safe: bumped (task #143) | test_sync_freshness.js, case 9 below |
| 3 | app/static/js/store.js | `wrapItemForPush` cache (`reuseCachedPushRow`) | Safe: re-sends the same ciphertext and hash | — |
| 4 | app/static/js/store.js | `wrapItem` / `stampForWrap` in `pushDirty` (dirty items, retries) | Safe: an item is dirty only after a bump (or a path below); a retry re-wraps a version the server never accepted. A lost response is matched by `sync_retry_key` | — |
| 5 | app/static/js/store.js | `pushDirty` `sealAttachmentContent` before wrap | Safe: same as 4 (first push of that version) | — |
| 6 | app/static/js/store.js | `persistLocal` / `migrateLegacyBlobs` | Safe: local IndexedDB copy only, keeps the server `content_hash`; not pushed by itself | — |
| 7 | app/static/js/store.js | `pushDirtyPersisted` (locked vault) | Safe: pushes stored ciphertext of dirty items (versions not yet on the server) | — |
| 8 | app/static/js/store.js | `backupAgendaPack` | Safe: local encrypted backup in meta, never pushed | — |
| 9 | app/static/js/store.js | `resolvePushConflict` → note: `mergeCrossDeviceProtection` + `winLocal` | **Was unsafe** (merged content re-pushed at the old `__fv`, possibly equal to the server copy's). Fixed: `winLocal(remote)` bumps above the server copy, drops the push cache, persists | test_freshness_reencrypt_paths.js case 1 |
| 10 | app/static/js/store.js | `resolvePushConflict` → `agenda_pack`: `mergeAgendaPacks` + `winLocal` | **Was unsafe**. Fixed: same `winLocal(remote)` bump | case 2 |
| 11 | app/static/js/store.js | `resolvePushConflict` → clock win, edit-beats-delete, unreadable server copy | **Was unsafe** (our copy re-pushed over the server copy at the same `__fv`). Fixed: `winLocal` bumps (floor = server copy when readable, else hwm) | case 3 |
| 12 | app/static/js/store.js | `resolvePushConflict` → `search_index` | Safe: type not tracked by freshness | — |
| 13 | app/static/js/store.js | `applySyncPayload` local wins, note protection merged and queued | **Was unsafe**. Fixed: merged content bumped above the pulled copy, push cache cleared | case 4 |
| 14 | app/static/js/store.js | `applySyncPayload` agenda pack merged and queued | **Was unsafe** (merged pack pushed at the pulled pack's `__fv`). Fixed: bumped above the pulled copy; hwm stored without the server hash until the push records it | case 5 |
| 15 | app/static/js/store.js | `applySyncPayload` search index merge | Safe: type not tracked | — |
| 16 | app/static/js/store.js | `migratePlainAttachments` (unlock maintenance) | **Was unsafe** (sealed copy replaces the plain one at the same `__fv`). Fixed: bumped | case 6 |
| 17 | app/static/js/store.js | `importBackup` (restore/merge from a backup file) | **Was unsafe** (backup copy pushed at its old `__fv`: fork or rollback on other devices). Fixed: bumped above the local item and hwm | case 7 |
| 18 | app/static/js/store.js | `migrateVaultKdfIfNeeded` (re-encrypt all items with the KDF v2 key) | **Was unsafe** (same as password change before #143). Fixed: bumped | case 8 |
| 19 | app/static/js/store.js | `changePassword` rollback (old-key copies re-pushed over rows already sent under the new key) | **Was unsafe** (old `__fv` below the pushed one: rollback/fork). Fixed: bumped above the live item | case 9 |
| 20 | app/static/js/app.js | backup export (`encryptObject` of item content) | Safe: writes a backup file, not a sync push (restore is path 17) | — |
| 21 | app/static/js/secure-send.js | `encryptObject` with a per-send key | Safe: not a vault item | — |

Tests: `node tests/test_freshness_reencrypt_paths.js` drives each fixed path
through the real `NotesStore` code and checks the pushed row on a second,
independent `NotesFreshness` instance that holds the server copy's hwm: it must
be accepted as a newer version without a fork warning. The same file and
`tests/test_sync_freshness.js` check that a real fork (same `__fv`, different
content) is still reported.
