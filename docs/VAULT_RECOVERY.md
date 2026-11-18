# Vault recovery: recovery key, passkey (PRF) unlock, migration

Status: design contract (idea #210, parts 1 and 2). No production code changed by
this document. Later tasks build against it; if one needs to deviate, it changes
this file in the same pull request.

Language: the app says **recovery key** (never "seed phrase"). In the code and in
this document `recovery code(s)` always means the existing *account sign-in*
recovery codes, which do not open the vault.

## 0. What exists today (checked against the code and a running app)

### 0.1 Verified on a local server

Checked with `NOTES_STRICT_ZK=1` (the default) on a throwaway data dir, Chromium
via Playwright, using the same server bootstrap as `tests/e2e_signup_autounlock.py`:
register, store a note with `NotesStore.upsert` + `flush`, read `notes.db`
directly, change the vault password with `NotesStore.changePassword`, lock and
unlock again.

| Observation | Result |
| --- | --- |
| Columns in `users` that hold key material | none; only `kdf_salt`, `vault_kdf_version` (2 for new accounts), `srp_salt`, `srp_verifier` (512 hex chars), `auth_method='srp'` |
| Tables with wraps / recovery / PRF material | none (only `account_recovery_batches` and `account_recovery_codes`, which are the *sign-in* codes) |
| Note ciphertext in `items.ciphertext` | `{"v":1,"iv":"<b64 12 B>","data":"<b64>"}`, opens with `NotesCrypto.deriveKey(password, kdf_salt, {kdfVersion:2})` |
| After `changePassword(old, new)` | `kdf_salt` **unchanged**; `items.ciphertext` and `rev` changed (rev 1 to 2); the old password no longer decrypts the row (`aes/gcm: invalid ghash tag`), the new password does; `password_changed_at` set; `srp_verifier` replaced |
| `lock()` then `unlock(newPassword, salt)` | `isUnlocked()` false, then true |

One thing seen and not explained: in this harness a direct call to
`NotesSrpAuth.accountUnlock(email, password)` right after registering answered
401 once; the next call (inside `changePassword`) worked. `changePassword`
already treats a 401 there as "login password differs from vault password"
(`loginMatchesCurrent = false`, `store.js:6889-6905`). Not a recovery concern,
but a test that scripts the unlock proof should expect it.

### 0.2 How the vault key arises today

**The vault key is derived directly from the password. It is not a random key
that is wrapped.**

* `NotesCrypto.deriveKey(password, salt, {kdfVersion})` (`app/static/js/crypto.js:89`):
  * v2 (all new accounts): `Argon2id(password, kdf_salt, t=3, m=65536 KiB, p=2, dkLen=32)`
    (`ARGON2_PARAMS`, `deriveRawV2`). The result is the 32-byte key itself.
  * v1 (legacy accounts): `SHA-256(password || 0x00 || salt)` (`deriveRawV1`).
  * `kdf_salt` is 16 random bytes, base64, made at registration
    (`passwords.new_kdf_salt`, `app.py:1214`), returned by `/api/account`.
    The server also has a Python copy of the derivation, `app/vault_crypto.py`,
    used only when `NOTES_STRICT_ZK=0`.
* `NotesStore.deriveVaultKey` (`store.js:503`) caches and routes through the
  KDF worker; `NotesStore.unlock(password, salt, opts)` (`store.js:765`) sets
  `state.cryptoKey = {raw: Uint8Array(32)}`. `state.altCryptoKey` exists for
  vaults whose rows are mixed between KDF v1 and v2 (`probeVaultKdfVersion`).
* Items: `NotesStore.wrapItem` (`store.js:1690`) calls
  `NotesCrypto.encryptObject(key, content)` (`crypto.js:114`):
  AES-256-GCM (noble `gcm`, 12-byte random IV, **no AAD**), stored as the JSON
  string `{v:1, iv, data}` in `items.ciphertext`. Attachment bytes use the same
  key (`rekeyAttachmentFileEnc`, `rekeyAttachmentPreviewEnc`). `encryptBytes` /
  `decryptBytes` take an optional `aad` (`crypto.js:138`) and produce
  `{v:2, iv, data}`; today only `settings-sync.js:154,178` uses it.
* The key lives only in memory. `NotesStore.lock()` (`store.js:837`) zeroes the
  key bytes. The typed password is kept in memory by `NotesVaultSecrets`
  (`vault-secrets.js`); a page-reload stash exists in `sessionStorage`
  (`notes_boot_*`, encrypted with a per-tab key).
* The server never stores a key, a wrapped key or the password. It stores
  `kdf_salt`, `vault_kdf_version` and ciphertext rows. A guess of the password
  can be tested offline against any item's GCM tag; this is the existing offline
  oracle and the wraps below add no new one (section 6.2).

### 0.3 Login is a separate secret path

SRP-6a (`app/srp_auth.py`, `app/static/js/srp-auth.js`): 2048-bit group, SHA-256.
For `srp_kdf_version` 2 the SRP secret is
`x = HKDF-SHA256(Argon2id(password, srp_salt), salt=srp_salt, info="srp-auth:<identity>")`
(`generateX`, `srp-auth.js:94`), using **`srp_salt`, not `kdf_salt`**. So the login
verifier and the vault key are different values from the same password. The
server holds `srp_salt` and `srp_verifier` only.

### 0.4 What a password change does today

`NotesStore.changePassword(current, next)` (`store.js:6845`):

1. `verifyVaultPassword(current)` locally; hydrate attachment blobs.
2. SRP proof of the current password: `NotesSrpAuth.accountUnlock`, then
   `NotesSrpAuth.passwordChangeProve` which calls
   `POST /api/account/password/challenge` and `POST /api/account/password/prove`
   (`app.py:2162`, `2187`) and receives a `rotation_token` (valid
   `NOTES_PASSWORD_ROTATION_SECONDS`, default 600; `auth.issue_password_rotation_token`).
3. `unlock(next, salt, {kdfVersion})`: **a new vault key from the new password,
   same `kdf_salt`**. Every item (and attachment `file_enc` / `preview_enc`) is
   re-encrypted, stamped as a newer version (`NotesFreshness.stampForUpsert`) and
   pushed with `flush()`.
4. **Only after every row is on the server** the login change is committed:
   `NotesSrpAuth.passwordChangeCommit` (`POST /api/account/password`,
   `app.py:2234`): consumes the rotation token, `db.update_user_srp_verifier`
   (sets `password_changed_at` and `auth_security_at`), `db.clear_user_legacy_password`,
   `_revoke_other_sessions(uid, reason="password")` (`app.py:193`).
5. Failure before step 4: roll back by unlocking with the old password and
   re-pushing the old-key rows (`store.js:7051-7100`). Failure after the rows are
   pushed but before the commit: `vaultRekeyCommitted` error, user must retry
   while signed in.
6. Other devices learn about it by polling `/api/account`:
   `NotesStore.remotePasswordChanged` / `remoteAuthSecurityEvent`
   (`store.js:1275-1283`, handled at `app.js:7903` and `app.js:7976`), compare
   `password_changed_at` / `auth_security_at` with a locally acknowledged value.

Consequences that drive the whole design:

* **Every password change creates a new vault key.** Any stored copy of the old
  key is stale afterwards.
* The existing mixed-key situation (rows under the new key, login still on the old
  verifier) is a real, already-handled state, not a hypothetical one.

### 0.5 Name collision to avoid

`POST /api/auth/vault-recovery` and `/api/auth/vault-recovery/challenge`
(`app.py:1527`, `1561`; `auth.SRP_PURPOSE_VAULT_RECOVERY`) already exist. They
**re-align the SRP login verifier** with a vault password the user still knows.
They do not recover a vault. The new endpoints below live under
`/api/account/vault-keys/...` so nothing is renamed or broken.

### 0.6 Passkeys and account recovery codes today

* Passkeys: `app/webauthn_helper.py` (`registration_options`,
  `verify_registration`, `authentication_options`, `verify_authentication`;
  resident key and user verification `PREFERRED`, **no extensions, no PRF**),
  routes `app.py:1809-2012`, table `webauthn_credentials(credential_id UNIQUE,
  public_key, sign_count, transports, created_at)`, client `passkeys.js` and
  `passkey-signin.js`. Removal: `db.delete_webauthn_credential` (`db.py:867`).
* Account recovery codes: `app/passkey_signin.py`, tables
  `account_recovery_batches` / `account_recovery_codes`, login via
  `POST /api/auth/recovery-code` (`app.py:2028`). They produce a session only.
* Rate limiting: `auth_rate_limit.allow` (in memory, per process), key
  `"<ip>:<endpoint>:<email>"` (`app._auth_rate_key`), default 24 hits per 300 s,
  12 when `NOTES_DISABLE_CIDR_GATE=1` (env `NOTES_AUTH_RATE_LIMIT`,
  `NOTES_AUTH_RATE_WINDOW`, `NOTES_AUTH_RATE_LIMIT_WAN`). It counts every call,
  not only failures, and resets on restart.
* Sync concurrency: `items.rev` per row, client sends `base_rev`; the server
  answers `conflict` / `stale` / `unchanged` (`db.upsert_items_batch`,
  `db.py:2040-2075`). That is the compare-and-set pattern this design copies.
* Notification channels that exist: the `auth_security_at` poll above,
  `mailer.send_plain_email`, `signin_alert.py`, session list `/api/sessions` with
  `revoke_reason`.

## 1. Key scheme

### 1.1 Decision: the vault key stays password-derived; wraps hold copies

Three facts decide this:

1. Items are encrypted directly under the password-derived key (0.2).
2. The server cannot tell which app version a request comes from, and old app
   versions on other devices unlock by deriving the key from the password. Making
   the vault key a random key (password only wraps it) would make every old client
   report "wrong password" for the whole account.
3. The owner requires that migration does not re-encrypt data and does not lock
   out older versions.

Therefore, for this feature (all existing **and** new accounts):

* `VK` (vault key) remains `NotesCrypto.deriveKey(password, kdf_salt, v)`.
  There is **no password wrap**: the password is the input of the KDF as today.
* A recovery key and each passkey get an **additional AES-256-GCM wrapped copy of
  `VK`**. Wraps are additive; enrolling one changes no item, no verifier, no salt.
* Every password change or recovery produces a new `VK` (0.4) and therefore
  **must replace or invalidate every wrap in the same server transaction**
  (sections 3 and 6). The server decides staleness by `vault_key_id`.
* A random-key/password-wrap scheme ("key mode `wrapped`") is the longer-term
  target but cannot be switched on without a client version signal; it is out of
  scope here and listed in section 9 with the gate it needs. The data model has
  `key_mode` room for it (`'derived'` is the only value now).

The recovery path in section 3 therefore still creates a new password-derived key
and re-encrypts, exactly as a password change does today. That is the price of not
locking old clients out; it happens only on recovery or password change, never at
enrollment.

### 1.2 Primitives (all in the browser; reuse `NotesCrypto`)

| Item | Definition |
| --- | --- |
| Wrap cipher | AES-256-GCM, 12-byte random IV, via `NotesCrypto.encryptBytes(wrapKey, vkBytes, {aad})` / `decryptBytes`; blob `{v:2, iv, data}` (base64) |
| `wrap_version` | `1` (this document). Stored beside every wrap. Unknown versions are refused by the client and the server stores them untouched |
| `account_id` | `users.id` as decimal string (stable; email can change) |
| `key_id` | `hex(HKDF-SHA256(ikm=VK, salt=empty, info="deeperguard/keyid/v1", L=16))`, 32 hex chars. Public to the server; identifies which `VK` a wrap belongs to |
| AAD | UTF-8 of `"deeperguard|vault-wrap|v1|" + account_id + "|" + type + "|" + key_id + "|" + binding`, where `type` is `recovery`, `prf` or `pending-rekey`, and `binding` is the base64url credential id for `prf`, empty otherwise. None of the fields can contain `|` |
| Plaintext of a wrap | the 32 raw bytes of `VK` (for `pending-rekey`: raw bytes of the *new* `VK`) |

AAD means a wrap cannot be moved to another account, to another type, to another
credential, or presented as another `key_id`: decryption fails with a GCM tag
error. The client must check `wrap_version == 1` and recompute
`key_id(VK_unwrapped) == key_id_from_server` before using the result, and must
verify the unwrapped key against at least one item (existing `markKeyVerified`
logic) before pushing anything.

### 1.3 Recovery key

* **Entropy**: 160 random bits from `crypto.getRandomValues` (above the 128-bit
  minimum), generated only in the browser.
* **Display**: 32 Crockford base32 characters (no I, L, O, U) in 8 groups of 4,
  plus a check group of 2 characters:
  `ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-QR`.
  Check group = first 10 bits of `SHA-256("deeperguard/recovery/check/v1" || key bytes)`
  as 2 base32 characters. This is a hash-based check, not an error-correcting
  code: **any** typo, swap or transposition (in the key or in the check group)
  is caught with probability 1 - 2^-10 (about 99.9 %); roughly 1 in 1024 random
  mutations goes unnoticed. No guarantee is made for specific error classes.
  The check only saves a round trip; a wrong key that passes it still fails
  safely at the AES-GCM tag (and the server proof). Input is upper-cased, spaces and hyphens removed,
  `O`->`0`, `I`/`L`->`1`; a wrong check group is rejected **locally, before any
  request and without counting as an attempt**. A word list is deliberately not
  used (no shipped list to audit, fewer transcription ambiguities in code form).
* **Wrap key**: `WK_rec = HKDF-SHA256(ikm=RK, salt=recovery_salt, info="deeperguard/recovery/v1", L=32)`.
  `recovery_salt` is 16 random bytes made per recovery key and stored with it.
  No Argon2: `RK` is already 160 bits of entropy, a slow KDF adds nothing.
* **Server proof** (so the server can rate-limit and gate a recovery without ever
  being able to open it):
  `proof = HKDF-SHA256(ikm=RK, salt=recovery_salt, info="deeperguard/recovery-proof/v1", L=32)`;
  the server stores `proof_hash = SHA-256(proof)` (hex) and compares in constant
  time. HKDF outputs under different `info` are independent, so `proof_hash`
  reveals nothing about `WK_rec`.
* **Shown and confirmed**: at creation the key is shown once (words/code, print,
  download as a text file, copy via the existing sensitive-clipboard helper
  `clipboard-sensitive.js`). The user must confirm it is stored before the
  client sends the wrap (new accounts: required step, section 5.1). The key is
  never sent anywhere and never stored on the device; the settings page only
  shows *whether* one is active and when it was created.

### 1.4 Passkey PRF

* **Salt**: `prf_salt`, 32 random bytes per **account** (base64url), created by the
  client at the first PRF enrollment and stored on the server
  (`users.prf_salt`, set with compare-and-set, never changed afterwards). It is
  passed as `extensions.prf.eval.first` in `navigator.credentials.get`, and
  `evalByCredential` is used when several credentials are allowed.
* **Wrap key**: `WK_prf = HKDF-SHA256(ikm=prf_output(32 B), salt=empty, info="deeperguard/prf/v1", L=32)`.
  The authenticator already derives its output per credential and per salt, so
  every passkey gets a different `WK_prf` and **its own wrap** of the same `VK`.
* **Enrollment needs a ceremony that returns PRF output.** Many authenticators
  report `prf.enabled` at `create()` but only return a value at `get()`. The
  client therefore: creates the passkey (existing flow, now asking for
  `extensions.prf: {}` at `create()`, which Chromium needs to set up the
  secret on the credential; browsers that do not know it ignore it), then performs a
  `get()` with the PRF extension on that credential, wraps `VK`, uploads. If the
  `get()` returns no `prf.results.first`, the passkey has **no** vault unlock; the
  app says so (text in section 8.3) and the passkey keeps working for sign-in.
* **Existing sign-in-only passkeys** get the same `get()` ceremony after the user
  re-authenticates (password proof, 3.1); if it returns no PRF output the app
  explains that a new passkey on a PRF-capable authenticator is needed.
* **Feature detection** is honest, three states: browser lacks
  `PublicKeyCredential` / PRF support; browser supports it but the authenticator
  returned no result; works. The master password and recovery key remain.
* Both Part 2 requirements hold by construction: wraps are per credential
  (`vault_prf_wraps`, one row per `credential_id`), and deleting a passkey deletes
  its row (3.4).

## 2. Server fields and endpoints

Everything is ciphertext, public identifiers or hashes. The server never receives
`RK`, `WK_*`, `VK`, PRF output, or the password. The whole feature answers
**404 when `strict_zk()` is false** (`config.py:161`), because in that mode the
server verifies the vault password itself (`vault_crypto.py`) and zero-knowledge
claims would be false.

### 2.1 Schema (SQLite, `db.py` migrations by `ALTER TABLE ... ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`, same style as lines 172-213)

`users` (all defaulted, so existing rows need no backfill):

| Column | Type | Meaning |
| --- | --- | --- |
| `vault_key_id` | TEXT NOT NULL DEFAULT `''` | `key_id` of the current `VK` while at least one wrap exists; `''` = no wraps. Freely overwritable whenever no wrap exists (2.2), whatever `vault_key_rev` is |
| `vault_key_rev` | INTEGER NOT NULL DEFAULT 0 | compare-and-set counter for all wrap changes |
| `prf_salt` | TEXT NOT NULL DEFAULT `''` | per-account PRF salt (1.4) |
| `vault_keys_invalidated_at` | REAL NOT NULL DEFAULT 0 | set when wraps were dropped because of a legacy password change (6.2); cleared on next enrollment |
| `recovery_failed_count`, `recovery_locked_until`, `recovery_lock_level` | INTEGER / REAL / INTEGER, default 0 | persistent attempt limit (3.3) |

`vault_recovery_wraps` (zero or one row per user):
`user_id INTEGER PRIMARY KEY REFERENCES users ON DELETE CASCADE`, `key_id TEXT`,
`wrap_version INTEGER`, `recovery_salt TEXT` (b64), `wrap TEXT` (JSON blob),
`proof_hash TEXT` (hex), `created_at REAL`, `last_used_at REAL NOT NULL DEFAULT 0`.

`vault_prf_wraps`: `id`, `user_id` (FK cascade), `credential_id TEXT NOT NULL REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE`,
`key_id TEXT`, `wrap_version INTEGER`, `wrap TEXT`, `created_at REAL`,
`UNIQUE(user_id, credential_id)`. (`PRAGMA foreign_keys=ON` is set, `db.py:55`, so
deleting the passkey row removes the wrap; `delete_webauthn_credential` must still
bump `vault_key_rev` in the same transaction.)

`vault_pending_rekey` (zero or one row per user): `user_id` PK, `from_key_id`,
`to_key_id`, `wrap` (new `VK` under old `VK`, type `pending-rekey`), `created_at`,
`expires_at` (created + 24 h).

### 2.2 Compare-and-set rules (apply to every write below)

* Request carries `expected_key_rev` (integer). The server runs the write as
  `UPDATE users SET vault_key_rev = vault_key_rev + 1, ... WHERE id = ? AND vault_key_rev = ?`
  in the same transaction as the table change (`db.tx()`); zero rows updated =
  **409** `{"error":"key_rev_mismatch","key_rev":<current>,"key_id":"<current>"}`
  and nothing is changed. The client refetches status and decides again.
* Writes of a wrap also carry `key_id`. It must equal `users.vault_key_id`, **or**
  no wrap exists for the user (no recovery row and no PRF rows). In the second
  case the write overwrites `vault_key_id` with the request's `key_id`,
  independent of `vault_key_rev` (only the normal `expected_key_rev` CAS
  applies). So enrolling again after revoking all wraps, after the late
  fallback of 6.2, or after a password change without wraps always works.
  Every password change, with or without `vault_keys`, also writes
  `vault_key_id`: the new `to_key_id` when wraps are sent, `''` when none
  remain (`VK` is derived from the password, so the old id is stale either
  way). Residual: a stale device enrolling while no wrap exists can store a
  wrap of an old `VK`; it is never served as current because recovery checks
  the unwrapped `key_id` and decrypts a sample of items (3.2) and the device
  gets the remote-password-change prompt on its next poll. Otherwise **409** `{"error":"key_id_mismatch", ...}`: the device holds a `VK`
  that is no longer the account's (another device changed the password) and must
  go through the remote-password-change flow instead of uploading a stale wrap.
* Idempotence: repeating an identical request after a lost response returns 200
  with the current state when the stored row equals the request body
  (same pattern as `unchanged` in `upsert_items_batch`).

### 2.3 Endpoints

All require a session, CSRF (`auth.csrf_ok`) and a completed 2FA gate (they are
**not** added to the exempt list in `auth.py:810-832`), JSON in and out, and
`Cache-Control: no-store`. "Prove" = a one-time **vault-keys token** (TTL
`NOTES_PASSWORD_ROTATION_SECONDS`) obtained exactly like the password-change
rotation token: `POST /api/account/vault-keys/challenge` (SRP step 1, new
`auth.SRP_PURPOSE_VAULT_KEYS = "vault-keys"`) then `POST /api/account/vault-keys/prove`
(SRP step 2) returning `{"token":...,"expires_in":...}`. Enrolling, replacing or
revoking therefore needs the password even on a passkey-unlocked device.

| Method and path | Needs | Body | Effect / answer |
| --- | --- | --- | --- |
| `GET /api/account/vault-keys` | session | none | `{schema:1, account_id, key_id, key_rev, key_mode:"derived", recovery:{active, created_at, last_used_at, wrap_version}, prf_salt, prf:[{credential_id, created_at, current:bool}], pending_rekey:bool, invalidated_at, recovery_locked_until}`. **Never** returns a wrap |
| `PUT /api/account/vault-keys/recovery` | token | `expected_key_rev, key_id, wrap_version, recovery_salt, wrap, proof_hash` | create or **replace** the single recovery wrap; the old row is overwritten (old key invalid at once). Resets the failure counter. `auth_security_at` bump; the notice mail is **not sent yet** (follow-up, see 3.6). 200 `{key_rev, key_id, auth_security_at}` (the writing device acknowledges the bump, so only other devices show the notice) |
| `DELETE /api/account/vault-keys/recovery` | token | `expected_key_rev` | **revoke**: deletes the row; `auth_security_at` bump; the notice mail is **not sent yet** (follow-up, see 3.6) |
| `PUT /api/account/vault-keys/prf/<credential_id>` | token | `expected_key_rev, key_id, wrap_version, wrap, prf_salt` | upsert this passkey's wrap; `credential_id` must belong to the user. `prf_salt` is accepted only when the account has none (CAS) or equals the stored one |
| `GET /api/account/vault-keys/prf` | session | none | `{prf_salt, wraps:[{credential_id, key_id, wrap_version, wrap}]}` for wraps with `key_id == vault_key_id`; used to unlock a locked vault in a signed-in session. Rate limit `vault-keys-prf` (existing limiter) |
| `DELETE /api/account/vault-keys/prf/<credential_id>` | token | `expected_key_rev` | delete one wrap (passkey stays for sign-in) |
| `POST /api/account/vault-keys/recover/start` | session | none | locked-out check (3.3); returns `{key_id, key_rev, wrap_version, recovery_salt, wrap}`; 404 `no_recovery_key` if none; 429 with `retry_after` if locked. Does **not** count as a failed attempt |
| `PUT /api/account/vault-keys/recover/pending` | session | `proof, expected_key_rev, from_key_id, to_key_id, wrap_version, wrap` | verify `proof` (counts a failure when wrong), store `vault_pending_rekey` (3.2 step 4) |
| `POST /api/account/vault-keys/recover/pending/fetch` | session | `proof` | returns `{from_key_id, to_key_id, wrap_version, wrap, expires_at}` of the live pending row (7.1 step 2); a wrong `proof` counts as a failed attempt and returns no wrap; 404 `no_pending_rekey` when none or expired (an expired row is deleted) |
| `POST /api/account/vault-keys/recover/commit` | session | `proof, expected_key_rev, from_key_id, to_key_id, srp_salt, srp_verifier, srp_kdf_version, new_recovery:{recovery_salt, wrap, wrap_version, proof_hash}` | the atomic commit of 3.2 step 7; 409 `pending_mismatch` when a live pending row names another `to_key_id` |

**Implemented storage for PRF wraps (deviates from the rows above).** The salt is
stored **per passkey** next to its wrap, in `vault_prf_wraps(credential_id PK, user_id,
key_id, wrap_version, prf_salt, wrap, created_at)` with `credential_id` referencing
`webauthn_credentials ON DELETE CASCADE`; there is no `users.prf_salt`. The table is
created with `CREATE TABLE IF NOT EXISTS`, so existing passkeys and accounts are not
touched. `PUT /api/account/vault-keys/prf/<credential_id>` follows the CAS rules of 2.2
(an unchanged retry answers 200). The `GET .../prf` row is replaced by two calls on one
passkey: `POST .../prf/<credential_id>/options` (session + CSRF) returns assertion
options and that passkey's `prf_salt` (not secret; `''` without a wrap), and
`POST .../prf/<credential_id>/unwrap` verifies the WebAuthn assertion (single-use
challenge, signature, sign count) made with exactly that passkey and only then returns
its wrap, and only when `key_id` equals the account's current `vault_key_id`.
`GET /api/account/vault-keys` lists `prf:[{credential_id, created_at, current}]`, never
a wrap. Deleting a passkey deletes its wrap and bumps `vault_key_rev` in the same
transaction; when no wrap of any kind is left, `vault_key_id` is freed.

Changes to existing endpoints:

* `POST /api/account/password/prove` (`app.py:2187`): see 6.2.
* `POST /api/account/password` (`app.py:2234`): optional `vault_keys` object
  `{expected_key_rev, from_key_id, to_key_id, recovery:{...}|null, prf:[{credential_id, wrap, wrap_version}]}`
  applied in the same transaction as `update_user_srp_verifier` (3.5).
* `db.delete_webauthn_credential`: also bumps `vault_key_rev` when a wrap row
  existed.
* `GET /api/account` (`app.py:2332`): adds `vault_keys:{recovery_active, prf_count, invalidated}`
  so the existing boot payload can drive the reminder banner without an extra call.

Constants (one module, e.g. `app/vault_keys.py`, so tests import them):
`WRAP_VERSION = 1`, `RECOVERY_MAX_FAILED = 5`, `RECOVERY_LOCK_BASE_SECONDS = 900`,
`RECOVERY_LOCK_MAX_SECONDS = 86400`, `PENDING_REKEY_TTL_SECONDS = 86400`,
`MAX_WRAP_BYTES = 4096`. Wrap blobs larger than that or with a wrong shape are
rejected with 400 before touching the database.

## 3. Flows

### 3.1 Enrollment on an unlocked vault (new and existing accounts)

1. Client holds `VK` (just registered, or unlocked with the password). `GET /api/account/vault-keys`.
2. Prove the password (`challenge` + `prove`) to get the token.
3. Compute `key_id`, make `RK` / PRF output, build the wrap with the AAD of 1.2.
4. `PUT ...` with `expected_key_rev` from step 1. 409: refetch and retry from step 1
   once; if `key_id` changed, stop and run the remote-password-change flow.

No item, verifier or salt is touched, so this is safe to interrupt at any point:
the request either committed (one row, one `key_rev` bump) or did not.

### 3.2 Recovery with the recovery key (forgotten password)

The user needs a session first, by any existing means (passkey sign-in, account
recovery code via `/api/auth/recovery-code`, plus TOTP if enabled). The account
recovery code never opens the vault; it only reaches this step.

1. `POST recover/start` -> wrap, salt, `key_id`, `key_rev`.
2. User enters `RK`; the check group is validated locally. Client derives
   `WK_rec`, unwraps `VK_old`, checks `key_id`, decrypts a sample of items
   (needs the items; a new device pulls them first with the normal sync).
3. User chooses a new password. Client derives `VK_new = deriveKey(new, kdf_salt, v)`
   with the account's current `vault_kdf_version`, and the new SRP verifier
   (`NotesSrpAuth.makeVerifier`, `srp-auth.js:479`).
4. `PUT recover/pending` with `proof`, `wrap = AES-GCM(VK_old, VK_new, type=pending-rekey, key_id=to_key_id)`
   (`key_id` in the AAD is the id of the wrapped key, as for every wrap in 1.2).
   Wrong proof: failure counted (3.3), nothing stored. This is the checkpoint that
   makes interruption recoverable (7.1).
5. Client re-encrypts every item and attachment under `VK_new` using the existing
   rekey code and pushes with the normal `base_rev` sync. Rows are readable with
   either key from here on.
6. Client makes a **new** recovery key (`RK2`, `recovery_salt2`, wrap of `VK_new`,
   `proof_hash2`) and shows it; the user must confirm they stored it **before** the
   commit (otherwise a lost `RK2` leaves no recovery path; if they cannot
   confirm, the commit is not sent and step 4's pending state is kept).
   The client (`NotesStore.recoverWithRecoveryKey`) asks for this confirmation
   before step 4, so cancelling it changes nothing on the server.
7. `POST recover/commit` in **one transaction**: verify `proof`, `key_rev` and
   `from_key_id`; `update_user_srp_verifier` (bumps `password_changed_at` and
   `auth_security_at`, like `app.py:2271`); `vault_key_id = to_key_id`;
   replace the recovery row with `RK2`'s; **delete all `vault_prf_wraps`** (they
   wrap `VK_old`; each passkey re-enrolls with one ceremony, 3.4);
   delete the pending row; reset the failure counter; `vault_key_rev + 1`;
   `_revoke_other_sessions(uid, reason="vault-recovery")`; mail (3.6).
8. Client acknowledges the new `password_changed_at` / `auth_security_at`
   (`ackPasswordChanged`, `ackAuthSecurity`), stores nothing else.

`RK` is spent: the old row is gone after step 7, so `RK` fails everywhere
afterwards. Order mirrors `changePassword`: data first, credentials last.

### 3.3 Attempt limit (exact)

* A **failed attempt** is a `proof` that does not match `proof_hash` at `recover/pending`
  or `recover/commit`. Wrong check group, wrong GCM tag and a mismatching
  `key_id` are local errors and never reach the server.
* Persistent per account (`recovery_failed_count`, `recovery_lock_level`,
  `recovery_locked_until`), not per IP, so a distributed guesser is still capped
  and a restart does not reset it.
* After **5** failures: `recovery_locked_until = now + 900 * 2^recovery_lock_level`
  seconds, capped at 86400; `recovery_lock_level += 1`; `recovery_failed_count = 0`.
  While locked every `recover/*` call answers **429**
  `{"error":"recovery locked","retry_after":<seconds>}`.
* A success resets count, level and lock; enrollment of a new recovery key also
  resets them.
* In addition, all `recover/*` and `vault-keys/prf` calls pass the existing
  per-IP limiter (`_auth_rate_limited("vault-recovery-key", email)`, 24 per 300 s,
  12 WAN).
* Locking sends mail (3.6). A thief with a stolen session can lock the owner out
  of recovery for up to 24 h; that is accepted (they could already do more damage)
  and the lock never blocks normal password sign-in or unlock.

### 3.4 Replace, revoke, passkey delete, passkey re-enroll

* **Replace** = `PUT recovery` again (new `RK`, old one invalid at once). The UI
  confirms before overwriting and shows the new key like a new account does.
* **Revoke** = `DELETE recovery`.
* **Passkey delete** (`/api/auth/webauthn/remove`): the credential row goes, the
  FK removes its wrap, `vault_key_rev` bumps; if it was the last wrap,
  `vault_key_id` becomes `''`.
* **Passkey re-enroll** after a password change/recovery: the settings list shows
  `current:false` for passkeys whose wrap was dropped; one PRF ceremony re-creates it.

### 3.5 Password change by a current client when wraps exist

The client already holds `VK_old` (unlocked) and creates `VK_new`. It needs `RK` to
re-wrap the recovery copy, but the key is not stored. So after the rekey push it
generates a **new recovery key**, shows it (confirmation required before the
commit), and sends it in `vault_keys.recovery`; for the passkey it just used (if
unlocked by PRF in this session) it may send a fresh `vault_keys.prf` entry;
other passkeys are re-enrolled later (3.4). The server applies this atomically
with the verifier update; if `vault_keys` is absent but wraps exist, 6.2 applies.
A user who would rather not keep a recovery key can revoke it first (3.4).

### 3.6 Notification

On recovery commit, replace, revoke, lockout and legacy invalidation (6.2):

* a new helper `db.touch_auth_security_at(uid)` (a bump without a password change, using the
  existing `auth_security_at` column) so **every other device** shows the existing
  security notice on its next `/api/account` poll (`remoteAuthSecurityEvent`,
  `app.js:7976`).
* An email to `users.email` through `mailer.send_plain_email` that names the event
  and time and says what to do if it was not the owner. It never contains a
  recovery key, token or proof. Built today for recovery commit (`app.py`
  `_vault_recovery_mail`) and lockout only. **Replace (`PUT .../recovery`) and revoke
  (`DELETE .../recovery`) do not send it yet**: they only bump `auth_security_at`.
  The mail for those two is a deliberate follow-up task, not part of task 334.
* Recovery commit and password change end all other sessions through the same
  `_revoke_other_sessions` (reason `vault-recovery`), visible in `/api/sessions`.

## 4. UI contract (for the build tasks; wording must stay true to this document)

* New account: recovery key shown after registration and **must be confirmed** (checkbox
  "I stored my recovery key") before the account is declared set up; the
  existing `register-recover-ack` checkbox text ("Deeperguard can't recover my
  notes if I forget this password") must change with it, in the same task that
  ships Part 1.
* Existing account: after unlock with the password, a banner offers to create a
  recovery key; it returns on every unlock until done or **explicitly postponed**
  (postpone stored locally, returns after 14 days). Settings always offer it.
* Settings: "Recovery key: active since <date>" or "not set up"; buttons
  create / replace / remove; never a "show key".
* Text to change when the feature ships (today they say recovery is impossible):
  `app/templates/register.html:36,57`, `app.html:1728`, `security.html:40`,
  `marketing.html:525`, `legal.html:117`, `docs/HELP_RECOVERY.md`,
  `content/blog/zero-knowledge-notes-basics.md:42`,
  `content/blog/encrypted-email-backups.md:40`. Claims allowed: "without your
  password **or** recovery key we cannot open your notes" and "we cannot read
  your recovery key". Not allowed: audit claims, "unbreakable", anything about
  browsers beyond what feature detection shows.
* Unsupported PRF is shown as plain text and the password path stays visible
  (1.4).

## 5. Migration of existing accounts (no re-encryption)

### 5.1 New accounts

Registration (`/api/auth/srp/register`, `app.py:1178`; client `NotesSrpAuth.register`, `srp-auth.js:372`) is unchanged on the server. The client
(`auth-pages.js`) makes `VK` as today and marks the step as pending on this device
(`localStorage` `notes_recovery_key_pending:<email>`); after the vault unlocks,
`recovery-key-setup.js` runs 3.1 with the confirm step (tick box plus typing one
4-character group of the key) and checks that the key as shown opens the wrap before
the `PUT`. A failed save offers to try again; the mark stays until the wrap is stored,
so the step returns (with a new key) at the next unlock on that device.
The step cannot be skipped: the dialog has no close or skip control, and Escape does
not dismiss it. A new account has no wrap only if the mark is gone before the wrap is
stored (for example browser storage was cleared, or the account is first unlocked on
another device, where the mark does not exist). Such an account is in the same state
as an existing account (5.2, section 4).

### 5.2 Existing accounts

* Server upgrade: `ALTER TABLE` only, all defaults (`vault_key_id=''`, `vault_key_rev=0`,
  no wrap rows). **No data is read or rewritten.** Items, `kdf_salt`,
  `srp_*`, sessions and sign-in recovery codes are untouched.
* An account without wraps behaves exactly as today (unlock, password change,
  sync). This is the baseline state forever; nothing forces enrollment.
* On the first unlock after the client update the user is offered 3.1. The only
  write is the new wrap row. Items stay encrypted under the same key, so every old
  client keeps unlocking and syncing (it never reads the new tables or fields;
  JSON bodies with unknown fields are ignored, and `GET /api/account` only gains
  fields).
* KDF v1 accounts enroll the same way (`VK` is whatever the account derives
  today). Upgrading v1 to v2 stays the existing, separate flow
  (`/api/account/vault-kdf`, `retryPendingVaultKdfUpgrade`); wraps made before it
  go stale when the upgrade re-encrypts (it changes `VK`) and are replaced or
  dropped by the same rule as a password change (3.5, 6.2).
* Existing sign-in-only passkeys: after a password proof, a PRF `get()` (1.4).
  No PRF output means "new passkey needed", stated in the UI.

### 5.3 Where re-encryption is unavoidable, and the safest path

Re-encryption happens only when `VK` changes: password change, recovery, KDF
upgrade. Path chosen and why:

1. **Keep `VK` password-derived** (1.1). The alternative, converting accounts to a
   random `VK` wrapped by the password, would require either re-encrypting every
   item once at conversion, or freezing `VK` and breaking old clients at the next
   password change. Both fail the "old versions must not be locked out" and
   "no re-encryption unless needed" requirements, and a server that cannot see
   client versions cannot gate it safely.
2. When `VK` has to change, use the existing, tested rekey order (data first,
   credentials last, rollback possible) and add the pending-rekey checkpoint
   (3.2 step 4) so that interruption never leaves rows unreadable.
3. Never convert silently. A future `key_mode:"wrapped"` needs: a client version
   signal the server can enforce (e.g. a header recorded per session), a
   confirmation that every active session sent it, and a separate design review.

### 5.4 Interrupted migration and multiple devices

* Enrollment is one atomic request (3.1); there is no half-migrated state.
* Passkey enrollment has two steps (create, then PRF `get()` + `PUT`): between
  them the passkey exists for sign-in only; the settings list shows it as "no
  vault unlock yet" and offers to finish.
* Two devices enrolling at once: the second `PUT` gets 409 `key_rev_mismatch`,
  refetches, sees the first wrap, and (recovery) asks before replacing it.
* A device with a stale `VK` after another device changed the password gets 409
  `key_id_mismatch` and must unlock with the new password first.

## 6. Old clients

### 6.1 Unlock, sync, reading

Unaffected (5.2). Old clients never see the wraps, and the wraps do not change any
data they use.

### 6.2 An old client changes the password

Old clients send no `vault_keys` and no schema marker. Current clients send the
request header `X-DG-Vault-Schema: 1` on all `/api/account/*` calls.

1. **Refuse early, before anything moves.** In `POST /api/account/password/prove`,
   if the account has a recovery wrap or any PRF wrap **and** the header is
   missing, answer **409** `{"error":"Update Deeperguard to change the vault password. This account has a recovery key.","code":"vault_keys_need_update"}`
   and issue no rotation token. At that point nothing has been re-encrypted
   (compare 0.4: the proof comes before the rekey), so nothing is lost and the
   existing stale-key problem never starts. The user updates the app, or removes
   the recovery key from a current client.
2. **Late fallback** (race: a wrap was added after the old client's `prove`):
   the old client has already pushed all items under `VK_new`, so the commit must
   succeed or the account lands in the "rows under new key, old verifier" state of
   0.4. `POST /api/account/password` without `vault_keys` and with existing wraps
   therefore **accepts** the change and, in the same transaction, deletes the
   recovery and PRF wraps, sets `vault_key_id=''` (free for re-enrollment, 2.2), bumps `vault_key_rev`, sets
   `vault_keys_invalidated_at`, and sends the invalidation mail (3.6). The
   settings page then shows "Your recovery key was removed because the password
   was changed with an older app version. Create a new one."
3. Both outcomes are safe because a wrap of an old `VK` can never open data that is
   now under a new `VK`; keeping it would only mislead the user.

### 6.3 An old client on a *recovered* account

After a recovery the other sessions are ended and the password changed. An old
client signs in with the new password and gets the new `VK` by derivation, as
after any password change. No special handling.

## 7. Threat model

Attacker capabilities are stated as what they obtain and what they can do with it.
"Not protected" lists are part of the contract, not footnotes.

| Threat | What they have | Outcome | Not protected |
| --- | --- | --- | --- |
| Stolen server database / backup | all tables incl. wraps, `key_id`, `prf_salt`, `proof_hash`, `recovery_salt`, items | Recovery wrap needs a 160-bit key: not attackable. PRF wrap needs the authenticator secret. `proof_hash` is SHA-256 of an independent 256-bit HKDF output. The password wrap does not exist; the password remains attackable offline **exactly as before** against item GCM tags and `srp_verifier` | A weak password. Wraps and `key_id` add no oracle: any item is already one (see the note on `key_id` below the table) |
| Stolen server database during a pending rekey (3.2 step 4 to commit) | `vault_pending_rekey`: `VK_new` wrapped under `VK_old`, plus the items | Anyone who tests the **old** password offline (row above) also opens the pending wrap and gets `VK_new`, so for that window the new key is only as strong as the old password. The row is deleted at commit and expires after 24 h (P11) | A weak old password. The exposure lasts until commit or 24 h after step 4, whichever comes first |
| Stolen recovery key (paper, file, screenshot) | `RK` | With a session on the account (or a stolen session) they recover and **take the account's vault**: new password, notes readable. Without a session they cannot reach the endpoint. Mitigations: TOTP gate, attempt limit, mail + notice on all devices, other sessions ended, the owner can replace/revoke at once | Anyone with `RK` **and** a way to sign in. Treat `RK` like the master password |
| Malicious or compromised server | can serve any ciphertext, drop or reorder rows, lie in API answers | Cannot read notes or wraps. AAD stops moving a wrap between accounts, types, credentials or key ids; the client recomputes `key_id` of what it unwrapped. A server **can** withhold a wrap (denial of recovery), serve an **older** wrap of the same `key_id` (harmless: same `VK`), and show a wrong "recovery active" flag | The server can serve **malicious client code** (the web app) which sees the password, `RK` or `VK`; defence is the existing release integrity checks (`release-integrity.js`), not this design |
| Phishing | fake site asking for `RK` or the password | `RK` is as valuable as the password and the only server-visible sign is the mail after use | Human error. Help text must say: the app asks for the recovery key only on the recovery screen of this site; support never asks for it |
| Shared / borrowed device | browser profile | `VK` is zeroed on lock (`NotesStore.lock`); the recovery key is not stored on the device after creation; a passkey unlock needs the authenticator and, for platform passkeys, local user verification (set `userVerification:"required"` on PRF ceremonies) | A device left **unlocked**, malware, a browser extension in the page. A downloaded key file stays on the disk the user saved it to |
| Race between devices | two devices writing wraps/passwords | `vault_key_rev` compare-and-set and `key_id` equality (2.2); password change and recovery are single transactions | A concurrent edit of the *same* item is the existing sync conflict logic |
| Interrupted migration or recovery | crash/offline mid-way | enrollment atomic; rekey has the pending checkpoint (7.1) and the data-before-credentials order | Offline for longer than 24 h after step 4 loses the pending checkpoint (the recovery key still works from step 1 and rows are readable with `VK_old` or the recomputable `VK_new`) |
| Old clients | other devices on old app | not locked out (6.1); password change refused early or wraps dropped (6.2) | Old clients cannot create or use wraps; PRF/recovery exist only in current clients |
| Online guessing of `RK` | session + automation | 5 failures then 15 min doubling to 24 h per account (3.3) | n/a: 160-bit space is not guessable even without the limit; the limit protects mostly against mistakes and abuse |
| PRF extension quirks | browser/authenticator without PRF, PRF only at `get()` | detected and said honestly (1.4) | No unlock with such a passkey; hardware keys need a supporting browser |

Additional non-goals (stated plainly): metadata is visible to the server (item
count, sizes, times, existence and creation time of a recovery key and number of
passkey wraps); no protection if the password is weak; no social recovery,
multisig, third-party emergency access or OPAQUE (out of scope of idea #210).

Note on `key_id`: it is a hash of `VK`. Anyone able to test a password guess
against `key_id` must first run Argon2id(password, `kdf_salt`) (same cost as
testing it against an item's GCM tag, which the server already stores), so it
adds no cheaper oracle. It is truncated to 128 bits.

### 7.1 Interruption states

| Stop point in 3.2 | Server state | What the user does |
| --- | --- | --- |
| before step 4 | unchanged | start again with `RK` |
| after 4, during 5 | pending row; some rows under `VK_new` | start again with `RK`: step 2 unwraps `VK_old`, then the pending wrap (under `VK_old`) yields `VK_new`; rows decrypt with either key; step 5 continues or restarts with the new password typed again (its derived key must match `to_key_id`, else a new pending row replaces it) |
| after 5, before 7 | rows under `VK_new`, login and wraps old | same as above; `RK` still valid because the row is replaced only at commit |
| after 7 | consistent | done; `RK2` active |

## 8. Texts that must stay honest (checklist for UI/help tasks)

1. A recovery key can open the notes of an account that can be signed in to; it
   does not replace the password for sign-in.
2. Recovery re-encrypts the notes and ends the other sessions.
3. A passkey unlocks the vault only when browser **and** authenticator return PRF;
   otherwise it only signs in. The password and recovery key always keep working.
4. No claim about audits, other products, or browsers not in the supported list
   produced by feature detection plus a manual matrix of tested browsers.

## 9. Test matrix (tick when a test exists and passes)

Layers: **P** = pytest on the Flask app (`tests/test_*.py`, in the style of
`tests/test_app.py`), **N** = node unit test of the client code (`tests/test_*.js`,
like `tests/test_change_password_browser_path.js`), **E** = Playwright e2e on a
real server (`tests/e2e_*.py`, bootstrap `e2e_signup_autounlock.start_server`;
Chromium's virtual authenticator with `hasPrf:true` for PRF). Each test asserts on
behaviour (DB rows, ciphertext bytes, HTTP status, visible UI), not on source text.

### 9.1 New account
- [ ] N1 `recovery key` generator: 160 bits, 8x4+2 format, check group rejects wrong keys with a measured miss rate of about 1/1024 (over e.g. 200 000 random single-character mutations, assert a miss rate between 0.05 % and 0.2 %; the check is hash-based, so no error class is guaranteed); normalisation of `o/O/i/l`, spaces, hyphens.
- [ ] N2 Wrap/unwrap round trip with the AAD of 1.2; fails when `account_id`, `type`, `key_id` or `binding` differ by one character; fails on `wrap_version != 1`.
- [ ] N3 HKDF vectors for `deeperguard/recovery/v1`, `/recovery-proof/v1`, `/prf/v1`, `/keyid/v1` (fixed inputs, fixed outputs) so other implementations agree.
- [x] E1 (`tests/test_e2e_recovery_key_setup.py`) Register: recovery key screen blocks continuing until the confirm box is ticked; server row exists with `key_id` equal to the client's; no request body contained the key or `VK` (capture all requests, search for the raw/base64/hex key bytes).
- [ ] P1 Schema migration on a database made by the previous release: existing rows unchanged, new columns default, `items` byte-identical.

### 9.2 Existing account (derived key, no wraps)
- [ ] E2 Account created before the feature: unlock still works, banner offers a recovery key, postponing hides it until the stored date, it returns after.
- [ ] E3 Enrol: `items.ciphertext`, `items.rev`, `kdf_salt`, `srp_verifier`, `password_changed_at` identical before/after; only one wrap row and `vault_key_rev` 0 -> 1.
- [ ] E4 KDF v1 account enrols and recovers the same way.
- [ ] P2 `GET /api/account/vault-keys` on an account with nothing: `recovery.active=false`, never contains `wrap`.

### 9.3 Recovery
- [ ] P3 `recover/start` 404 without a wrap; 401 without a session; 403 without 2FA; 404 when `NOTES_STRICT_ZK=0`.
- [ ] E5 Full recovery on a *fresh browser context* (no local data): sign in with an account recovery code, enter `RK`, new password; afterwards: old password rejected, new password unlocks, every item decrypts, `RK` fails, `RK2` active, `kdf_salt` unchanged.
- [ ] P4 Commit is atomic: inject a failure after the verifier update, assert verifier, `vault_key_id`, wraps and sessions all unchanged.
- [ ] P5 Other sessions end with `revoke_reason='vault-recovery'`; the current one survives; `auth_security_at` advanced; a mail is queued (mock `send_plain_email`) containing no key material.
- [ ] P6 Attempt limit: 4 wrong proofs ok, 5th returns lock; 6th request 429 with `retry_after` about 900; after the lock level doubles (1800); cap 86400; counter survives a server restart; success resets; local check-group errors never count.
- [ ] P7 Stale password wraps: after recovery `vault_prf_wraps` is empty and `GET .../prf` returns none.

### 9.4 Replace
- [ ] E6 Replace the recovery key: old `RK` fails at `recover/start` flow (GCM tag error locally and proof mismatch server-side), new one works; settings show the new date, never the key.
- [ ] P8 `PUT recovery` with stale `expected_key_rev` -> 409 and unchanged row.

### 9.5 Revoke
- [ ] P9 `DELETE recovery`: row gone, `recover/start` 404, mail queued, `key_rev` +1.
- [ ] P10 Deleting a passkey removes only its wrap and bumps `key_rev`; the other passkey's wrap stays.
- [ ] E7 Passkey unlock (virtual authenticator with PRF): lock, unlock with the passkey, items decrypt; a passkey without PRF shows the honest message and the password still works; browser without `PublicKeyCredential` shows the unsupported text.
- [ ] N4 Existing sign-in-only passkey after password proof: PRF result -> wrap uploaded; no result -> "new passkey needed", nothing uploaded.

### 9.6 Interrupted migration
- [x] E8 (`tests/test_e2e_vault_recovery_flow.py`) Kill the page between `recover/pending` and the end of the re-encrypt push (abort the request after N rows): reload, sign in, `RK`, finish; every item readable; no row lost; final state equals E5.
- [ ] E9 Enrollment request dropped before response: retry is idempotent (200, one row).
- [ ] E10 Passkey created but PRF step cancelled: passkey signs in, list shows "no vault unlock yet", finishing works.
- [ ] P11 Pending row expires after 24 h; expired row is ignored and cleaned; commit with a mismatching `to_key_id` is rejected.

### 9.7 Two devices
- [ ] E11 Device A enrols a recovery key while device B (same session account) enrols too: one wins, the other gets 409, refetches and sees `active`.
- [ ] E12 Device A changes the password; device B (unlocked with the old key) tries to upload a wrap: 409 `key_id_mismatch`; B then shows the existing remote-password-change prompt (`remotePasswordChanged`).
- [ ] P12 Concurrent `PUT recovery` and `POST /api/account/password` with `vault_keys`: exactly one `key_rev` outcome, no wrap with a `key_id` that differs from `users.vault_key_id`.
- [ ] E13 Password change by a current client with wraps: new recovery key shown and confirmed, commit atomic, other passkeys marked `current:false`.
- [ ] E14 Revoke all wraps, change the password (wraps absent, current or old client), enrol a recovery key again with the new `key_id`: 200, `users.vault_key_id` equals the new id, `vault_key_rev` strictly increased. Same after the 6.2 late fallback.

### 9.8 Old client
- [ ] P13 Old-client request shapes (no header, no `vault_keys`): unlock proof, sync push/pull, `GET /api/account` all behave as before the feature (golden responses minus the added fields).
- [ ] P14 Old client with a recovery key: `password/prove` -> 409 `vault_keys_need_update`, no rotation token issued, nothing else changed.
- [ ] P15 Race: wraps added after `prove`, old client then commits: change accepted, wraps deleted, `vault_keys_invalidated_at` set, mail queued, settings show the explanation.
- [ ] E15 An old client build (previous release's static files) unlocks an account that has a recovery key and passkey wraps and reads/writes notes normally.

### 9.9 Cross-cutting
- [ ] P16 Every new endpoint: 401 without session, 400 without CSRF, 403 without 2FA, rate-limited, `no-store`.
- [ ] P17 Wrap shape validation: oversize, non-JSON, wrong `wrap_version`, `credential_id` of another user -> 400/404, nothing stored.
- [ ] P18 Grep of server logs and DB after the e2e runs finds no `RK`, `VK` or PRF output.

## 10. Where the code goes (for the build tasks)

* Client crypto: new `app/static/js/vault-keys.js` (recovery key encode/decode,
  HKDF via `crypto.subtle` as in `srp-auth.js:84`, wrap via `NotesCrypto.encryptBytes`),
  plus PRF helpers next to `passkeys.js`; `store.js` gets thin hooks:
  `changePassword` (3.5), a `recoverWithKey` that reuses the rekey loop at
  `store.js:6964-7000`, and the `vault_key_id` check after unlock.
* Server: `app/vault_keys.py` (constants, validation, transactions), routes in
  `app/app.py` next to `/api/account/password`, DB helpers in `app/db.py`,
  `auth.SRP_PURPOSE_VAULT_KEYS`.
* Static files change: regenerate the client manifest with
  `scripts/build-client-manifest.py` (an edit without it makes the browser unlock
  time out).
