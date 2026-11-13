# Change vault password: can a failed or double change lock an account out?

Status: investigation only, no production code changed.
Test: `tests/test_change_password_browser_path.js` (runs `changePassword` with the
browser path of `unlock()`; run with `node tests/test_change_password_browser_path.js`).
Related: idea #28 (key never marked verified after rekey), beta-tester run 4.

## Verdict

* **With the code as it is today, a failed or double change does NOT lock an
  account out on the server side.** In a real browser the change always fails
  before anything is uploaded or committed (idea #28), so the server's items,
  the SRP salt/verifier and `kdf_salt` stay exactly as they were. The old
  password keeps working. The test asserts: zero `POST /api/sync/items`, zero
  `POST /api/account/password`, and a rejected second concurrent call.
* **The tester's "Wrong password." for both passwords is not reproduced.** I
  found no path in the current code that changes the server verifier without the
  items being re-encrypted (or the reverse). Only an unconfirmed local-only
  hypothesis (below) could explain it.
* **Applying the idea #28 fix naively would create a real lockout path** (see
  "Latent failure path"). The fix must also restore the verified state on
  rollback.

## How the pieces fit (files and functions)

`app/static/js/store.js`, `changePassword()` (~line 5906):

1. `verifyVaultPassword(current)` — returns false when `state.keyVerified` is false.
2. `NotesSrpAuth.accountUnlock` / `/api/account/unlock`, then
   `passwordChangeProve` or `POST /api/account/password/prove` -> `rotation_token`
   (`app/app.py` `api_account_password_prove`). Nothing is written yet.
3. `unlock(next, salt, …)` (~line 753) derives the new key into `state.cryptoKey`.
   In a browser it sets `state.keyVerified = false` (only Node sets it true,
   line ~786). The salt is **not** changed: the same `kdf_salt` is reused; only
   the password (and so the key) changes.
4. Every item is re-keyed, set dirty and `persistLocal()`-ed (IndexedDB now holds
   rows under the **new** key).
5. `flush()` -> `pushDirty()` (~line 3109). `if (!state.keyVerified) return false;`
   (line 3124) so nothing is sent; `changePassword` throws `REKEY_UPLOAD_FAILED`
   ("N items could not be uploaded…"). Commit step 6 is never reached.
6. Commit (only after a fully successful push): `passwordChangeCommit` or
   `POST /api/account/password` (`api_account_password`), which consumes the
   rotation token and calls `db.update_user_srp_verifier`. This is the only place
   that changes the verifier.
7. Rollback (`catch`, `if (rotated)`): `unlock(current, salt)` again (this sets
   `keyVerified = false` again in a browser), restores the pristine items under
   the old key, `persistLocal()` them, and a best-effort `flush()`.

Double click: `passwordChangeInFlight` is set synchronously right after the
argument checks, so a concurrent second call throws "Password change already in
progress" and touches no state (asserted in the test). A second click *after* the
first failure just runs the same safe failure again; the rotation token is
single-use, so a repeated commit cannot happen. The guard is per tab only; two
tabs/devices changing at once is not covered (see Risks).

## Exact failure path today (account that already has notes)

Register, create a note, Settings -> change password with the right current password:

1. `verifyVaultPassword` passes (key verified after the earlier unlock/pull).
2. Prove succeeds; a rotation token is issued (server state: only a token).
3. `unlock(next)` -> `keyVerified=false`; items re-keyed, dirty, written to IndexedDB.
4. `flush()` -> `pushDirty()` returns false at `store.js:3124`; `unsynced > 0`.
5. `REKEY_UPLOAD_FAILED` thrown; rollback re-unlocks with the old password and
   rewrites IndexedDB under the old key. Server: items unchanged, verifier
   unchanged. Client: `keyVerified=false`, dirty queue non-empty, rollback's own
   `flush()` is also blocked, so the dirty rows wait until a pull proves the key.

Result: safe, but the password can never be changed (idea #28).

## Latent failure path (becomes real if #28 is fixed incompletely)

If the fix only marks the *new* key verified before the first `flush()`:

1. Rekey; first chunk(s) of `POST /api/sync/items` succeed — those rows are now
   ciphertext under the **new** key on the server; a later chunk fails (offline,
   quota, 5xx). The verifier is still the old one.
2. Rollback calls `unlock(current)`, which resets `keyVerified=false`. The rollback
   `flush()` is then a no-op (`store.js:3124`), so the rows already on the server
   under the new key are **not** overwritten under the old key.
3. Server state: mixed rows (some new-key, some old-key), verifier = old password.
   On the next unlock with the old password, decrypting a new-key row fails; with
   the new password the login (verifier) is rejected. That is exactly "both
   passwords refused" until the dirty queue is drained. Whether the queue survives
   depends on the persisted dirty list; closing the tab before a verified push
   loses the in-memory copy (see `lock()`), though IndexedDB rows and the persisted
   queue (`pushDirtyPersisted`) can still re-push once a key is verified.

The existing Node test (`tests/test_sync_change_password.js`, case 4) covers this
rollback but passes only because Node forces `keyVerified=true`; it hides the
browser behaviour.

## Unconfirmed hypothesis for the tester's report

Between step 4 (IndexedDB rewritten under the new key) and the rollback's
`persistLocal()` (rewritten under the old key) the tab can be closed/reloaded
(Argon2 unlock runs twice, which is slow) or the rollback can throw (it only
`console.warn`s). Then IndexedDB holds new-key rows while the server verifier is
still old: unlocking with the old password fails to decrypt the local rows, and the
new password is rejected by login. I could not reproduce this in a test (it needs
a real IndexedDB + reload); treat as plausible but unconfirmed. The server data is
intact in that case, so clearing the local cache and pulling recovers the vault.

## Risks that remain regardless

* Commit is not atomic with the item upload: items are pushed first, then the
  verifier is updated. If the commit call fails after a successful push
  (`syncedNewKey`), items are under the new key and the verifier is old; the code
  reports `vaultRekeyCommitted` and tells the user to retry/repair. Recovery works
  only while the session lives and the new password is remembered.
* No server-side guard ties verifier changes to a rekey generation, and no
  cross-tab/device lock exists.

## Recommended fix (not applied)

1. In `changePassword`, after `await unlock(next, …)` call `markKeyVerified()`
   (current password was just proven to the server and the old key decrypted the
   vault); do not relax the gate in `pushDirty`.
2. Remember `const wasVerified = state.keyVerified` before the rekey and restore
   it after the rollback's `unlock(current, …)` **before** the rollback `flush()`,
   so rows that already reached the server under the new key are overwritten with
   the old key. Do this in a `finally`-safe way and surface a clear error if the
   rollback flush still fails.
3. Avoid persisting `vault_kdf_version`/new-key rows locally until the push
   succeeds (or write rekeyed rows to IndexedDB only after a successful flush).
4. Make the server commit atomic with the rekey if feasible (e.g. send the
   re-encrypted items and the new verifier in one transaction) or add a
   rekey-generation check.
5. Regression tests: run `changePassword` with the browser path (as in
   `tests/test_change_password_browser_path.js`) and assert (a) success pushes
   items and commits once, (b) a failure on chunk 2 re-pushes every row under the
   old key and the old password still works, (c) a double click commits once.
