# Sign out: what is wiped and what stays

Scope: "Sign out" in Settings (`#btn-logout`) and the one on the unlock screen.
Both end in `signOutCompletely()` / `clearLocalVaultAndLeave()` (`app.js`) and
`NotesStore.clearDeviceData()` (`store.js`). This file is the contract for
`tests/e2e_sign_out_storage.py`, which was checked against the running app: it
registers, signs out via Settings, reloads and lists what is left.

## Order

1. Pending changes are flushed (at most 5 s).
2. The vault key and decrypted notes are dropped and the unlock screen is shown
   at once, before the server is asked anything.
3. `POST /api/auth/logout` is sent (CSRF token fetched from `/api/account`).
   If it fails or hangs, the local wipe still happens.
4. Local data is wiped, then the browser goes to `/login`.

## Must be gone after sign out and a reload

| Where | What | Why |
|---|---|---|
| Server | The session. `auth.logout()` revokes the token (`revoke_session_by_token`), so the old `session` cookie gets 401 from `/api/account`. | A stolen or copied cookie must stop working. |
| Cookie | The `session` cookie (cleared by `session.clear()`). | No session token in the browser. |
| `sessionStorage` | Everything (`sessionStorage.clear()`): `notes_csrf`, `notes_unlocked`, `notes_salt`, `notes_kdf_cache`, boot password/key stash. | Key material and per-session flags. |
| `localStorage` | `notes_device_password_enc` and `notes_device_key` (the remembered-device password and the key that decrypts it), `notes_kdf_salt`, `notes_vault_kdf_version`, `notes_last_sync`, `notes_sync_log`, `notes_email`. | Without them nobody can unlock from this browser without the password. |
| IndexedDB `deeperguard` | All rows in `items`, `blobs` and `meta` (the database itself stays, empty). | Encrypted notes and sync cursor of the account. |
| Memory | Vault key, passwords, decrypted notes, search index, previews. | Not reachable after the reload anyway. |
| Cache Storage | All caches (`caches.delete`). | Cached app responses. |

After the reload the app is on `/login`, not unlocked, and has no `session` cookie.

## Stays on purpose

| Where | What | Why |
|---|---|---|
| `localStorage` `notes_device_id` | Random id of this browser. | Not a secret. The server lists signed-in devices by it, and the next sign-in from this browser keeps the same device entry. |
| `localStorage` `deeperguard-prefs` | Theme, font size and other preferences. | Not account data. |
| `localStorage` `notes_idb_owner` | Email of the account the IndexedDB database belongs to (`idb.js`). | Decides whether the next sign-in by a different account gets a separate database. |
| `localStorage` `notes_auth_security_ack_at`, `notes_device_selftest_v1` | Timestamp of the security notice, results of the device self-test. | Not tied to a session or key. |
| Server | Encrypted notes. | Sign out only ends this browser's session. |

The encryption format and the login are unchanged.
