# Lock: what it does today and what it must do

Scope: the vault Lock (manual, idle, leaving-the-app) in the browser client.
This is a spec and an audit; no code changes come with it. Line numbers refer
to the tree at the time of writing; re-check them when those paths change.

## 1. Audit: where secrets and plaintext live after unlock

**The vault key is not a `CryptoKey`.** `crypto.js` derives 32 raw bytes
(Argon2id, `t=3, m=65536, p=2`, KDF v2; SHA-256 for legacy v1) and wraps them as
`{ raw: Uint8Array }`. AES-GCM runs in the noble library (`noble().gcm(...)`,
`crypto.js` `encryptObject`), not in WebCrypto. So today the key is a plain,
extractable byte array in the JS heap, and it is copied to several places.
"Non-extractable `CryptoKey`" is a target (section 2), not the current state.

| What | Where | Cleared by lock today? |
|---|---|---|
| Vault key `{raw}` | `store.js` `state.cryptoKey` | Set to `null` (`lock()`, ~853). The bytes are not zeroed. |
| Second-version probe key | `state.altCryptoKey` | Set to `null` |
| Same key, cached | `store.js` `lastDerivedKdf` = `{password, salt, version, key, fp}` (`rememberDerivedKdf`). It also holds the **plain password**. | Set to `null` |
| Same key, passed to freshness | `freshness.js` `setCryptoKey` | `NotesFreshness.clearMemory()` |
| Vault password | `vault-secrets.js` `vaultPassword`, `accountPassword` | `clearSecrets()` |
| Password and derived key stashed across page loads | `sessionStorage`: `notes_boot_password_enc`, `notes_boot_kdf`, `notes_boot_key` (the AES key sits beside the ciphertext, so this is obfuscation, not protection). `auth-pages.js` writes them at sign-in (~116, ~971); `app.js` ~8368 adopts them via `adoptDerivedVaultKey`. | `clearSecrets()` removes them |
| Remembered-device password | `localStorage`: `notes_device_password_enc` + `notes_device_key` (`saveDevicePassword`). The decrypt key is in the same storage. | **No.** Lock leaves it; auto-unlock can read it (`loadDevicePassword`, `refreshDevicePasswordCache`). This is the largest gap against "unlock needs the password." |
| Decrypted notes | `store.js` `state.items` (`VaultItemMap`), `blocked`, `undecryptable` | Cleared |
| Search index | `search.js` `noteIndex`, `termCache` (note text and tokens) | `clearMemoryIndex()` |
| Editor and list DOM | `ui.body.value`, `ui.title`, `ui.noteList` | List emptied, editor hidden. **Editor field values are not cleared.** |
| UI plaintext state | `app.js` `unlockedNotes` (per-note locks), `currentId`, preview and thumbnail caches | Cleared (`unlockedNotes.clear()`, `clearPreviewCache`, `clearListThumbCache`) |
| Object URLs of decrypted attachments | `URL.createObjectURL` in `app.js` (~11178, ~11284, ~11488) and `preview.js` | Only if the two caches above revoke them; verify |
| AI chat history | `NotesAiChat` | `reset()` |
| Cloud tokens in prefs | `prefs.dropbox*`, `googleOauthClientId` | Zeroed in memory and cleared from local |
| Crypto worker | `crypto.js` `workerRef`, `crypto-worker.js`. Receives the password for derive and the base64 key for each `decryptObjectInWorker` call. | `terminateWorker()` from `lock()` |
| In-flight decrypt batches | `attachmentDecryptInFlight` | Nulled, but the batch is not cancelled. Only `lockEpoch` guards sync. |
| PDF/OCR workers | `client-ocr-engine.js`, `preview.js` blob workers | **Not terminated by lock** |
| IndexedDB | Ciphertext rows plus the unsynced queue (`persistDirtyNow`) | Kept on purpose (offline vault). It is ciphertext. |
| Service worker | `sw.js` caches app shell and static files | Plaintext notes are not cached there (confirm when changing `sw.js`) |

### Lock paths

- `lockVault()` in `app.js` (~3936) is the single UI entry. Triggers: manual
  button, `bumpIdle()` (~3581, `prefs.autoLockMin`), `lockVaultAfterUnfocus()`
  (`prefs.lockOnUnfocus`: never / immediate / 1 min, timestamp in
  `notes_unfocused_at`), a remote password change, and failed-unlock cleanups
  (`NotesStore.lock()` called directly in `verifyAndUnlock`).
- Order today: show the lock UI, `flushSave()` (editor to store), then
  `NotesStore.flush()` raced against `LOCK_FLUSH_WAIT_MS` (2500 ms), then UI
  teardown, then `NotesStore.lock()`. `lock()` itself calls `persistDirtyNow()`
  and bumps `lockEpoch`.
- `mayLockVault()` (`vaultlock.js`) refuses to lock while an app update runs.
  Idle lock is postponed while an unlock is in flight, the unlock screen is
  visible, or an iOS text field has focus.
- Defaults: `autoLockMin` = 15 (`app.js` ~174); the select offers Never, 5, 15,
  30 (`app.html` ~1762). `lockOnUnfocus` defaults to `1min`.
- Unlock: `verifyAndUnlock()` -> `NotesStore.unlock(password, salt)`
  (`store.js` ~765) -> `deriveVaultKey()`. That reuses `lastDerivedKdf` if
  password, salt and version match, and otherwise runs Argon2id (in the worker
  when enabled). `adoptDerivedVaultKey()` can install a key with **no
  derivation** from the boot stash.

### Findings

1. After lock, no module-level reference to the key survives on the main
   path, but the bytes are only dereferenced, not overwritten.
2. The remembered-device password in `localStorage` lets the app unlock without
   the user typing the password. That conflicts with the target.
3. A key may be installed without Argon2 via the sessionStorage boot stash.
   It is cleared on lock but is also decryptable by anyone with script access to
   the same tab.
4. Editor text can remain in DOM field values after lock.
5. Unsaved edits are saved by `flushSave()` into the store and then pushed
   best-effort, but the 2.5 s race means a slow save can be skipped, and the
   behaviour is not written down anywhere.
6. The idle timer measures time since `bumpIdle()` calls, not since the last
   user input; which events call it is not specified.

## 2. Target semantics

### 2.1 Lock

On lock, in this order:

1. **Stop accepting input.** Show the lock screen and set `locked` first so no
   new edits start.
2. **Save unsaved edits (section 4).**
3. **Evict the key.** Drop every reference to the vault key: `state.cryptoKey`,
   `altCryptoKey`, `lastDerivedKdf`, the freshness copy, and any key held by
   workers. Zero the `Uint8Array` bytes (`fill(0)`) where we own the buffer,
   as a best effort (section 5).
4. **Drop all plaintext state:** `state.items` and sets, search index, term
   cache, `unlockedNotes`, preview/thumbnail caches (revoking object URLs),
   editor field values, find-bar text, AI chat, vault and account passwords,
   cloud tokens in prefs.
5. **Terminate every worker** that has seen the password or key or note text
   (crypto, OCR, PDF).
6. **Remove the sessionStorage boot stash** (`notes_boot_*`).
7. **Do not keep the remembered-device password usable for unlock** (2.2).

Lock must be idempotent and must never throw before step 3: wrap each step so a
failure in one cannot leave the key in memory. IndexedDB ciphertext and the
unsynced queue stay.

**Target key type.** Once unlocked, the key should be held as a
non-extractable `CryptoKey` (`importKey(..., false, ['encrypt','decrypt'])`)
used through WebCrypto AES-GCM. Then lock means dropping the reference, and
script cannot read the bytes while unlocked. This needs: the derive step to
import and immediately zero its raw output; workers to receive the
`CryptoKey` by `postMessage` (structured clone allows it) instead of base64
bytes; and a decision on the legacy KDF v1 path and the noble-based
`encryptObject`/`decryptObject`, which currently require raw bytes. If that
migration is too large for one step, the minimum is: keep raw bytes, zero them
on lock, and remove every extra copy (`lastDerivedKdf.key`, worker base64).

### 2.2 Unlock

- Unlock after any lock requires the user's password and a fresh **Argon2id
  derivation** (KDF v2 parameters from the account). No key cache may satisfy
  it: remove the `lastDerivedKdf` reuse path for post-lock unlocks and the
  `adoptDerivedVaultKey` shortcut.
- The one exception is the first load right after sign-in or sign-up, where the
  user just typed the password. That may hand the password (never a derived
  key) to the unlock step in memory only, not through sessionStorage.
- Remembered-device unlock (`saveDevicePassword`) must not run after a lock.
  Either remove the feature, or make it opt-in and apply only on cold start,
  never after idle, manual or leaving-the-app lock. Decide in the task that
  changes it; this spec requires only that a lock is never undone without the
  password.
- A wrong password leaves the app locked with no key retained
  (`NotesStore.lock()` on failure, already the case).
- Legacy KDF v1 accounts still unlock with SHA-256 until upgraded; the spec
  does not change that, but lock/unlock behaviour is the same.

### 2.3 Auto-lock

- **Idle** = no user input (pointer, key, touch, scroll, focus changes) in the
  app. Reset on those events, not on sync or timers.
- Setting `autoLockMin`: **default 15 minutes**, configurable, with an
  **Off** option (`0`). Offer Off, 1, 5, 15, 30, 60 minutes. Keep storing minutes
  as a number in prefs; `0` means off. Invalid or negative values fall back to 15.
- Turning it off needs no extra prompt, but the setting hint should say that the
  key then stays in memory until the tab closes or the user locks.
- Idle lock waits (retries after a short delay) during an in-flight unlock,
  an open unlock screen, or an app update, as now. It does **not** wait for
  typing in a field: typing is input and resets the timer.
- `lockOnUnfocus` stays a separate setting. Both feed the same `lockVault()`.
- Closing the tab or reloading drops memory, so the key is gone; the next load
  is a cold start and needs the password (2.2).

## 3. Observable results (what tests assert)

After lock: `NotesStore.isUnlocked()` is false; `state.items` is empty; no
module field holds the key or the password; the search index is empty; editor
fields are empty; workers are terminated; no `notes_boot_*` keys in
sessionStorage. After unlock: Argon2id ran (a spy on the derive call sees it);
a second unlock after lock never reuses a cached key.

## 4. Unsaved edits

- Before step 3 of lock, flush the open editor into the store (`flushSave()`),
  **encrypt** it with the still-held key, and write it to IndexedDB
  (`persistDirtyNow`). Plaintext is never written to disk or storage.
- The network push is best effort and capped (today 2500 ms). It must not delay
  eviction: the encrypted local save must finish first, the push may be
  abandoned and resumes after the next unlock from the persisted queue.
- If the encrypted local save **fails** (quota, IndexedDB error): do not lose
  the text silently. Keep the lock screen, and keep the unsaved buffer only in
  an encrypted form, or show a clear error and let the user retry or discard
  before the key is dropped. Auto-lock never destroys text the user typed; if
  that is not possible, the lock still happens, and the failure is reported at
  next unlock.
- A note whose text changed under the editor (sync reconcile) is not
  overwritten by a stale buffer, as `flushSave()` already does.

## 5. Limits (honest)

- JavaScript gives no way to erase memory. `fill(0)` on a `Uint8Array` clears
  that buffer, but the engine may have copied it (JIT, string conversions,
  `structuredClone`, `postMessage`), and the garbage collector decides when
  unreferenced objects are freed and when the pages are reused or overwritten.
- Strings are immutable. The password, note text, JSON and base64 forms of the
  key cannot be wiped. They disappear only when collected, and may stay in
  freed heap pages, swap, hibernation files, or crash dumps.
- A non-extractable `CryptoKey` stops script reading the bytes; it does not stop
  script using the key while unlocked. Any code running in the page (XSS, a
  malicious extension) can ask the browser to decrypt during that time.
  Dropping the reference makes it unusable to later script, but the browser
  may hold key material internally until it collects the object.
- Terminating a worker frees its heap, but timing is up to the browser.
- Lock protects against someone using an unattended, unlocked device and against
  later script access in the same page. It does **not** protect against malware
  or an attacker with memory access while the vault is unlocked, a compromised
  browser, or anything that already copied plaintext (clipboard, screenshots,
  OS keyboard history, exports, downloaded attachments).
- Idle lock depends on timers; browsers throttle or suspend them in background
  tabs and on mobile. Leaving-the-app lock and a timestamp check on return
  (`shouldLockOnReturn`) cover that, with a delay.
- IndexedDB keeps ciphertext after lock by design; the password strength and
  Argon2id cost are what protect it.

## 6. Files the later tasks must change

| File | Change |
|---|---|
| `app/static/js/store.js` | `lock()`: zero key bytes, drop all copies; `unlock()`: always derive (remove `reuseDerivedKdf` post-lock reuse and `adoptDerivedVaultKey`); move to non-extractable `CryptoKey`; do not keep the password in `lastDerivedKdf` |
| `app/static/js/crypto.js` | Import derived bytes as non-extractable `CryptoKey`; WebCrypto AES-GCM path; zero raw output; `decryptObjectInWorker` takes a `CryptoKey` |
| `app/static/js/crypto-worker.js` | Accept `CryptoKey`; no base64 key copies |
| `app/static/js/vault-secrets.js` | Remove `stashBootDerivedKey`/`BOOT_KDF` and the stored derived key; keep the password stash only for the sign-in handoff; rework or gate remembered-device password |
| `app/static/js/auth-pages.js` | Stop stashing the derived key (~951-971); password handoff in memory only |
| `app/static/js/app.js` | `lockVault()` ordering and failure handling; clear editor fields and revoke object URLs; terminate OCR/PDF workers; `bumpIdle()` driven by real input events; auto-lock options and default; remove boot-derived adoption (~8368) and the device-password auto-unlock after lock |
| `app/static/js/vaultlock.js` | Pure helpers for the new rules (idle options, normalisation, "may auto-unlock") |
| `app/static/js/freshness.js` | Hold no raw key; clear on lock |
| `app/static/js/search.js` | No change beyond keeping `clearMemoryIndex` in the lock path (verify) |
| `app/static/js/client-ocr-engine.js`, `app/static/js/preview.js` | Expose a terminate/revoke hook that lock calls |
| `app/templates/app.html` | `pref-auto-lock` options (Off, 1, 5, 15, 30, 60) and hint text |
| `app/static/client-manifest.json` | Regenerate with `scripts/build-client-manifest.py` after any `app/static` edit |
| `tests/test_vaultlock.js` and new tests (e.g. `tests/test_lock_evicts_key.js`) | Assert section 3; also update `test_round53_lock_reason.js`, `test_vault_kdf_unlock.js`, `test_kdf_unlock_after_reload.js`, `test_round50_boot_unlock.js` where they rely on key reuse or the boot stash |
| `docs/PRIVACY.md`, `SECURITY.md` | Describe lock and its limits in the same words as section 5 |
