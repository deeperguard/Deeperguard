# Revocation limits: what logging out, revoking and removing a device do and do not protect

Scope: the current build. It covers logging out, revoking a session or device from the session list, changing your password, and what happens to data a device already holds. It is a description of what the code does, not a promise. Line numbers refer to the tree at the time of writing; re-check them when those paths change. Use-time checks for share links and collaborator access are a separate topic: see [REVOCATION_SPEC.md](REVOCATION_SPEC.md).

## 1. Summary

- The server holds only ciphertext. Revoking a session stops the server from serving that device new data. It cannot take back data the device already has.
- A device that already has the vault key, or the password it needs to derive the key, and a copy of the ciphertext, can decrypt that data offline. Nothing on the server is in that decryption path, so no revocation or lease can stop it.
- There is no offline lease and no setting for a maximum offline read window. A revoked device that stays offline keeps whatever it already holds with no time limit.
- Changing the password re-encrypts what the device that changes it holds and pushes the new ciphertext. It does not change what other devices have already read or cached.
- There is no separate key-rotation feature.

## 2. What is stored in the browser

| Item | Where | Lifetime |
|---|---|---|
| Ciphertext of notes, attachments and the unsynced queue | IndexedDB (`store.js` `persistLocal`, `persistDirtyNow`) | Kept across lock and reload, so notes open offline. Removed by sign-out (`clearDeviceData`, `store.js` ~3988). |
| Vault key (raw bytes, not a non-extractable `CryptoKey`) | JavaScript memory (`store.js` `state.cryptoKey`) | While unlocked. Dropped on lock and on reload. Lock does not overwrite the bytes ([LOCK_SPEC.md](LOCK_SPEC.md)). |
| Password and key stash for page loads | `sessionStorage` (`notes_boot_password_enc`, `notes_boot_kdf`, `notes_boot_key`) | Per tab. Cleared on lock. The key sits next to its ciphertext, so this is obfuscation only. |
| Remembered-device password and its decrypt key | `localStorage` (`vault-secrets.js` `saveDevicePassword`, ~247) | Lock leaves it in place, so auto-unlock can still read it. Sign-out clears saved unlock secrets (`clearSavedUnlockSecrets`, `app.js` ~6712). |
| Session cookie | Browser cookie | Until the session is revoked or expires. |
| App shell and static files | Service worker cache (`sw.js`) | Code only. Notes are not cached there. |

Outside the app's control: files you exported or downloaded, backup files, screenshots, clipboard contents, and anything a browser or OS has written to disk, swap or crash dumps.

## 3. What each action does

| Action | What the server does | What the device that does it does | What other devices do |
|---|---|---|---|
| **Log out** (`api_logout`, `app.py` ~1597; `auth.logout`, `auth.py` ~527) | Revokes that one session (`revoke_session_by_token`, `db.py` ~1321). | `signOutCompletely` (`app.js` ~8175) calls the logout endpoint, then `clearLocalVaultAndLeave` (`app.js` ~8109) locks, clears saved unlock secrets and calls `clearDeviceData`. The local clear runs even if the logout request fails. | Not affected. |
| **Log out while offline** | Nothing. The logout request never arrives. | Local data is still cleared. | The server session stays valid until it expires or is revoked. A cookie copied from the device stays usable against the server. |
| **Revoke or remove a device** from the session list (`api_revoke_session`, `app.py` ~1711; `revoke_user_session`, `db.py` ~1284, reason `user`) | Marks the session revoked. Requests with its cookie are refused (`auth.authenticated`, `auth.py` ~544). | On its next contact with the server, the device gets `session_revoked` (`app.py` ~673, `auth.session_requires_wipe`, `auth.py` ~561). The app then clears local data (`wipeAfterRemoteSignOut`, `app.js` ~8211). | Each device signs out on its next contact. |
| **Revoke a device while it is offline** | Session revoked. | Nothing happens. It has not reached the server, so no wipe runs. | Nothing. It keeps its cache and key for as long as it stays offline. |
| **Change password** (`changePassword`, `store.js` ~5893; account password endpoint, `app.py` ~2196 and ~2211) | Replaces the verifier, then revokes every other session (reason `password`). | The device that changed the password re-keys the items it holds under the new password and pushes them. The server commits the change only after the pushes succeed. | Other sessions are revoked with reason `password`. That reason does not trigger the local clear (`app.py` ~673 only acts on reason `user`), so their local cache and any remembered password stay until the user clears them. |

Notes on the table:

- A revoked device is not forgotten by the server, and is not forgotten by the device. Revocation only affects what the server returns to it.
- The wipe on "revoke a device" depends on the device reaching the server. A device that stays offline is never told.

## 4. Why revocation cannot protect data already read

Decryption is local. Notes are encrypted with AES-256-GCM in the browser, using a vault key derived with Argon2id from the password and the account's salt. Once a device has the key, or the password and the salt, it can decrypt any ciphertext it holds without contacting the server. No token, lease or revocation check runs during decryption.

So:

- An offline device with the vault key and a cache of the ciphertext can read that data indefinitely. Nothing the server does can end that.
- A device that holds the password can derive the key again at any time. Revoking its session does not change the password.
- Copies that already left the app (exports, downloaded attachments, screenshots, clipboard) are not reached by revocation at all.
- Backups made by the operator or by a backup provider are outside the app's control. For pCloud backups the retention is described in [SECURITY.md](../SECURITY.md) (7 days by default). Other operators' backups are their own responsibility.

Revocation limits what **new** data the server serves to a device. It is not a way to take back data that was already readable on that device.

## 5. New content after a password change, and key rotation

**Password change: implemented.** `changePassword` (`store.js` ~5893) does the following:

1. Proves the current password (SRP for SRP accounts), then gets a rotation token from the server.
2. Derives a new key from the new password (`unlock(next, salt)`) and re-encrypts every item the device holds, including attachment bytes and previews (`rekeyAttachmentFileEnc`, `rekeyAttachmentPreviewEnc`).
3. Pushes the re-encrypted items. The password change is committed on the server only after every item is accepted. If any item cannot be pushed, the change is not committed, so other devices do not unlock with a password that cannot read their rows.
4. Revokes the other sessions (section 3).

What this means for data:

- Content written after the change uses the new key. Other devices get it once they sign in with the new password.
- Items the server refuses for size or quota are marked blocked. They do not hold the change back, and they stay on the device (`store.js` ~6033). Any other item that fails to upload stops the change, and the app reports that nothing was changed.
- A device that is offline during the change keeps its old cache and its old key. It can still read everything it cached before the change. The change does not reach it until it syncs.
- Old ciphertext copies held by anyone else are not replaced by this process.

**Key rotation: not available.** The code has no separate rotation of the vault key. Keys change only through a password change or the vault KDF upgrade (`/api/account/vault-kdf`, `store.js` ~5860). The KDF upgrade re-encrypts items, but it exists to move accounts to the current KDF, not to revoke access. There is no per-device key, no key versioning for revocation, and no scheduled rotation.

**Share links and collaborator access** are separate. Share-link and collaborator revocation is covered in [REVOCATION_SPEC.md](REVOCATION_SPEC.md).

## 6. Offline read window (lease length)

There is no lease. No setting, server value or client check limits how long an offline device can keep reading data it already holds. The read window for a revoked device that stays offline has no upper bound. Anyone deciding how to set this up should assume that and act on the practical steps in section 7.

## 7. Practical advice

- **Lost or stolen device you can still reach:** clear the app's site data in the browser (cookies, IndexedDB, local storage for the app's origin). This removes the local cache and saved passwords. It does not remove copies that were already exported.
- **Lost device you cannot reach:** revoke its session from another signed-in device, then change your password from a trusted device. This stops new data from reaching the lost device and re-keys what you push from now on. It does **not** stop the lost device from reading what it already holds. Treat anything it had as possibly read.
- **Shared or public computers:** turn off **Remember password on this device**, use **Clear saved password**, and sign out before leaving. Lock is not enough, because a remembered password can unlock the vault on the next page load.
- **Anything sensitive in your notes** (passwords, recovery codes, keys, personal data) may have been read by a device that still held the vault. Change those secrets at their source.
- **Secure Send links and collaborator access:** revoke them separately (see [SECURITY.md](../SECURITY.md) and [REVOCATION_SPEC.md](REVOCATION_SPEC.md)). Revoking a device does not revoke links you created.
- **Do not rely on a server-side action alone** when the device is gone. Changing the password and revoking sessions are still worth doing, but they only limit what happens next.

## 8. Limits of this document

- This was written by reading the code. It was not checked against a live deployment, and it does not cover the browser or operating system outside the app.
- The claim that a device revoked with reason `password` keeps its local data is based on reading `app.py` ~673 and the client wipe path. Confirm it with a test before relying on it for a compliance statement.
- Line numbers will drift. Search for the function names if they no longer match.
