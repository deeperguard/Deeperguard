# 2FA: QR scanner, import from other apps, icons, search and tags: specification

Status: design. Nothing in this document is implemented yet unless section 1
says it is. It describes what will be built, so that code, tests,
SECURITY.md/PRIVACY.md and the in-app texts can be checked against one source.

Goal: a user can move every authenticator account they have into the vault in
one sitting. They can scan a QR code with the camera, read one from a
screenshot, paste a link, or import an export file from Aegis, 2FAS or Google
Authenticator. Each account then shows a recognisable icon, and the user can
find it by searching or by tag.

Hard rules that run through every section:

- **Zero knowledge stays intact.** Secrets, labels, issuers, tags and icon
  choices exist in plaintext only in browser memory while the vault is open.
  The server only ever sees vault ciphertext. No import step involves the
  server.
- **No network traffic for 2FA features.** Decoders, KDFs and icons are all
  vendored, pinned and served from our own origin. We never fetch favicons,
  icon CDNs or "logo APIs", and we never phone home during import.
- **Import files and QR payloads are untrusted input.** They are parsed with
  hard limits and shown as text only. Nothing in them is loaded, executed or
  rendered as HTML (Aegis and 2FAS embedded icons included, see 6.5).
- **Secrets never leave the import flow other than into the vault.** They
  never go to the console, error texts, toasts, URLs, `localStorage`,
  `sessionStorage`, IndexedDB outside the encrypted item cache, or the
  service-worker cache.

## 1. Inventory: what exists today

Read from the code at the time of writing, not assumed.

### 1.1 Done and in use

| Piece | Where | Notes |
| --- | --- | --- |
| Vault item type `totp` | `addTotpAccount` in `app/static/js/store.js:4593` | One vault item per account. Content: `{type:'totp', issuer, account, secret, host, digits, period, algorithm, created_at, updated_at}`. `secret` is normalised Base32 (upper case, no spaces, dashes or `=`). Adding a secret that already exists returns the existing item (`created:false`). |
| Encryption | `upsert` → `NotesCrypto.encryptObject(state.cryptoKey, …)` in `app/static/js/store.js:5037` and `:1678` | Every `totp` item is encrypted like any other vault item. There is no separate 2FA key or store. |
| List / edit / remove | `listTotpAccounts` (`store.js:4527`, dedupes on normalised secret), `updateTotpAccount` (`:4616`, only issuer/account/host), `removeTotpAccount` (`:4627`), `dedupeTotpAccounts` (`:4545`, keeps the best-labelled copy and merges in missing fields) | |
| Code generation | `NotesTotp.generate` in `app/static/js/totp.js:243` | WebCrypto HMAC with SHA-1/256/512. TOTP only. Digits are clamped to 6–10 and period to ≥ 1. |
| Base32 | `decodeBase32` (`totp.js:188`), `looksLikeSecret` (`:204`, min. 8 chars) | |
| otpauth parsing | `parseOtpauth` in `totp.js:274` | Single `otpauth://totp/…` URI. Reads `secret`, `issuer`, label `Issuer:Account`, `digits`, `period`, `algorithm`. |
| Free-text parsing | `parseText` (`totp.js:387`), `tryParseJsonPayload` (`:99`), `tokenEntriesFromUnknown` (`:72`) | Finds otpauth links, `name: SECRET` lines, tables and generic JSON (`tokens`/`entries`/`accounts`/`items` arrays) in notes. |
| Migration from notes | `migrateFromNotes` (`totp.js:596`), `migrateTotpFromNotes` (`app/static/js/app.js:4341`) | Moves secrets out of notes titled or tagged "2FA" into `totp` items. It deletes a note only when every secret in it is already in the vault. |
| Site binding | `normalizeBoundHost`, `hostsMatchExact`, `formatTotpCopyLabel` (`totp.js:522` ff.) | `host` field: the code is only offered for an exact site match. |
| Add dialog | `saveTotpAddDialog` (`app.js:4864`), `entryFromFields` (`totp.js:553`) | Manual secret or pasted otpauth URI. |
| QR from camera | `startTotpQrScan` (`app.js:4814`), `tickTotpQrScan`, `stopTotpQrScan` (`:4636`) | `getUserMedia` with the rear camera. Polls every 250 ms. |
| QR decoding | `decodeQrFromSource` (`app.js:4771`) | Native `BarcodeDetector({formats:['qr_code']})` first, then the vendored `jsQR` on a canvas with `inversionAttempts:'attemptBoth'`. |
| QR from image | `importTotpQrFile` (`app.js:4840`), button `btn-totp-pick-qr` (`app.js:21733`) | `createImageBitmap`, with an `<img>` + object URL as fallback. Also the fallback when there is no camera. |
| Vendored decoder | `app/static/js/vendor/jsQR.js`, loaded in `app/templates/app.html:2714`, hashed in `app/static/client-manifest.json` | SHA-256 `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859`. |
| Search | `filteredTotpEntries` (`app.js:4439`) | Case-insensitive substring over `issuer account host`. |
| Icon | `kindIconSvg('totp')` (`app.js:3175`, `:4508`) | One generic icon for every account. No per-issuer icons. |
| Tests | `tests/test_totp.js`, `tests/test_vault_totp_host.js`, `tests/test_clipboard_totp_ios.js`, `tests/test_round86_totp_list_narrow.js` | RFC 6238 vectors, note detection, parsing, host binding, copy, layout. |

Not part of this work: `app/totp.py` and `app/static/js/totp-page.js`. Those
are the server-side 2FA for **signing in to Deeperguard** (pyotp). They are a
different feature and stay unchanged.

### 1.2 Half done, or missing

1. **HOTP is rejected.** `parseOtpauth` returns `null` for `otpauth://hotp/…`
   (`totp.js:279`). The item has no `type` or `counter`.
2. **Unknown algorithms fall back silently.** `generate` maps anything that is
   not SHA256/SHA512 to SHA-1 (`totp.js:210`), so an `MD5` or misspelled
   algorithm produces wrong codes instead of an error.
3. **Digits are not validated.** Parsing accepts any number, and `generate`
   clamps it to 6–10 after the fact.
4. **There is no file import.** Aegis, 2FAS and Google Authenticator exports
   are only picked up by accident: `tokenEntriesFromUnknown` reads loose JSON
   when it sits in a note. Encrypted exports are not handled at all.
5. **`otpauth-migration://` is not recognised.** Scanning a Google
   Authenticator export QR code gives "That QR code is not a TOTP
   authenticator code." (`applyTotpQrPayload`, `app.js:4745`).
6. **Only one QR code per scan.** The scan stops after the first hit and saves
   it right away (`applyTotpQrPayload` → `saveTotpAddDialog`). There is no
   preview, and no way to collect batches.
7. **A pasted list does not work.** The secret field takes one otpauth URI and
   ignores the rest.
8. **There are no icons, tags or sort order** on accounts. Search does not
   cover tags.
9. **The label field is called `account` in storage.** The target model calls
   it `label` (section 2). The migration keeps `account`.
10. The `jsQR` file has no recorded upstream version or licence notice in the
    repo. Section 5.2 fixes that.

## 2. Target data model

One vault item per account, as today: `type: 'totp'`, encrypted by `upsert`
with the vault key (`store.js:1678`). The item type is not renamed. A new type
would mean a sync migration and risk losing data on older clients.

| Field | Type | Rules |
| --- | --- | --- |
| `schema` | int | `2` for the new model. Missing means `1` (today). |
| `otp_type` | `'totp'` \| `'hotp'` | Default `'totp'`. `steam`, `motp`, `yandex` and other types are **not imported** (they are listed as skipped, see 3.0). |
| `issuer` | string | Trimmed, ≤ 128 chars, control chars removed. May be empty. |
| `label` | string | The account name (e-mail, user name). Trimmed, ≤ 256 chars, control chars removed. Never empty: falls back to `issuer`, then `'Account'`. |
| `account` | string | **Alias of `label`**, kept so clients from before schema 2 still show the account. Always written equal to `label`. |
| `secret` | string | Normalised Base32 (A–Z, 2–7, no padding). Decoded length 10–128 bytes. Shorter secrets are refused. Below 16 bytes the preview shows a "weak secret" note but the import is allowed. |
| `algorithm` | `'SHA1'` \| `'SHA256'` \| `'SHA512'` | Anything else is refused per account with a visible reason. No silent fallback. |
| `digits` | int | 6, 7 or 8. Anything else is refused. |
| `period` | int | TOTP only. 1–300 s, default 30. |
| `counter` | int | HOTP only. 0 … 2^53−1 (safe integer). It is incremented and saved **before** the code is shown, so a crash cannot show the same code twice. |
| `host` | string | Unchanged (site binding). |
| `icon_id` | string \| null | Slug from the vendored icon set (section 6), or `null` for "automatic" (issuer matching), or `'letter'` to force the letter avatar. Never a URL and never image data. |
| `tags` | string[] | ≤ 20 tags, each trimmed, ≤ 40 chars, deduped case-insensitively. Stored as tag names inside the item (see 7.2). |
| `sort` | number \| null | Optional manual order. `null` means alphabetical. |
| `source` | string | E.g. `'aegis'`, `'2fas'`, `'google-migration'`, `'otpauth'`, `'manual'`, `'qr'`. Informational only. |
| `note` | string | Optional free text, ≤ 2000 chars (Aegis `note`). Shown as text only. |
| `created_at`, `updated_at` | ISO string | As today. |

### 2.1 Encryption

Nothing new. Every field above lives inside the encrypted item content, so
the server sees the same opaque ciphertext and sizes it sees today. No 2FA
field goes into item metadata, sync cursors, the search index on the server,
or plaintext IndexedDB columns. Import passwords (Aegis/2FAS) and derived
keys stay in local variables. Their byte buffers are zeroed with `fill(0)`
when the import finishes, fails or is cancelled. They are never stored.

### 2.2 Migration without data loss

- **Lazy and additive.** Readers treat a missing `schema` as 1 and map it to:
  `label = account`, `otp_type = 'totp'`, `tags = []`, `icon_id = null`,
  `counter` absent. Nothing is rewritten just because the user opened the
  vault.
- **On the first write** of an item (edit, tag, icon change), it is saved as
  schema 2 with **both** `label` and `account` set. All existing fields,
  including unknown ones, are copied through (`{...item.content, …}`, as
  `updateTotpAccount` already does), so a field added by a newer client
  survives an edit on an older one.
- **Old clients** keep working. They read `issuer`/`account`/`secret`/
  `digits`/`period`/`algorithm` and ignore the rest. An old client editing a
  schema 2 item keeps the new fields, because `updateTotpAccount` spreads the
  old content.
- **HOTP items on old clients:** an old client would treat them as TOTP and
  show wrong codes. So HOTP items get an extra `secret` guard: the HOTP item
  stores its secret in `hotp_secret`, and `secret` is set to `''`. Old clients
  skip items without a secret (`listTotpAccounts` filters on it), so they never
  show a wrong code. New clients read `hotp_secret` when
  `otp_type === 'hotp'`.
- **Dedupe** (`planDedupe`, `listTotpAccounts`) stays keyed on the normalised
  secret. For HOTP the key is `hotp:` + secret, so that TOTP and HOTP with the
  same secret are not merged.
- **Test:** schema 1 items round-trip through read → edit → save → read on
  both the new code and a copy of the old `totpAccountFromItem` without losing
  any field.

## 3. Import formats

### 3.0 Shared import flow and limits

1. **Input.** The user picks a file, drops it, pastes text, or scans one or
   more QR codes. Detection uses content, not file names:
   `otpauth-migration://` → Google; `otpauth://` lines → otpauth list; JSON
   with `header` + `db` → Aegis; JSON with `services` or `servicesEncrypted` →
   2FAS. Anything else is "Unknown format".
2. **Password.** Asked for encrypted Aegis/2FAS only, in a password field that
   is never autofilled into or saved by us (`autocomplete="off"`). A wrong
   password gives the generic text "Wrong password or damaged file". The text
   is the same for both causes, it does not leak details, and the user can
   retry. KDF work runs in a dedicated worker so the UI stays responsive, and
   the user can cancel it.
3. **Preview.** A list with issuer, label, type, icon and tags, plus a
   checkbox per account (all on by default). Accounts already in the vault
   (same dedupe key) show "Already in vault" and are unchecked. Skipped
   accounts are listed with their reason ("HOTP counter missing", "Steam codes
   not supported", "Secret too short", "Algorithm MD5 not supported"). The
   preview **never shows secrets or codes**.
4. **Save.** The checked accounts are saved through `addTotpAccount` in one
   batch, then one sync. The toast says "Imported N accounts, skipped M". The
   source file is not stored.
5. **After the import** the flow tells the user, as text only, to delete the
   export file from their device. Export files are plaintext secrets.

Global limits, checked before parsing:

| Limit | Value |
| --- | --- |
| File / pasted text size | 5 MB |
| Accounts per import | 2 000 (more → refuse the whole import with a clear message) |
| JSON nesting depth | 32 |
| Single string field | 4 096 chars (secrets: 128 decoded bytes, see section 2) |
| Embedded icon data (Aegis/2FAS) | not decoded at all (see 6.5) |
| KDF cost | see per format. Over the cap means refuse before deriving. |

### 3.1 otpauth:// (single and list)

Single URI, from QR, paste or the secret field: the
[Key Uri Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format).

| URI part | Field | Rule |
| --- | --- | --- |
| host `totp` / `hotp` | `otp_type` | Anything else is refused. |
| path label `Issuer:Account` (percent-decoded) | `issuer`, `label` | If the label has no `:`, all of it is the `label`. |
| `secret` | `secret` | Required, Base32, case and spaces ignored. |
| `issuer` | `issuer` | Wins over the label prefix. If the two differ, the preview shows the `issuer` parameter. |
| `algorithm` | `algorithm` | SHA1/SHA256/SHA512 (also accepted as `SHA-256` and in lower case). Default SHA1. |
| `digits` | `digits` | 6/7/8, default 6. |
| `period` | `period` | TOTP, 1–300, default 30. |
| `counter` | `counter` | **Required** for HOTP. Without it the account is skipped. |
| `image`, other params | ignored | Never fetched. |

Limits: one URI ≤ 4 096 chars. Duplicate query parameters mean the URI is
refused.

**List:** text with one `otpauth://` URI per line (blank lines and lines
starting with `#` are ignored). The same limits apply, plus 2 000 lines. A bad
line skips that line and leaves the rest. Export from the vault (outside this
spec) uses the same format, so the user can round-trip.

### 3.2 Aegis JSON (plain and encrypted)

Format as written by Aegis Authenticator (vault `version` 1, db `version` 2
or 3). The structure:

```
{ "version": 1,
  "header": { "slots": [...] | null, "params": { "nonce": hex, "tag": hex } | null },
  "db": { ...plain db... } | "base64 ciphertext" }
```

**Plain:** `header.slots` and `header.params` are `null` and `db` is an
object.

**Encrypted:** `db` is a base64 string. Decryption:

1. Take the slots from `header.slots`. Aegis slot types:
   - **type 0 = raw**: a slot for a raw key file. Not supported for import,
     because we have no raw key to offer. Skipped.
   - **type 1 = password**: the scrypt slot. **This is the slot we use.**
   - **type 2 = biometric**: a key in the Android Keystore. It can never be
     opened outside that device. Skipped.

   If there is no type 1 slot, refuse with "This Aegis backup has no password
   slot". Try every type 1 slot in order until one opens.
2. For a type 1 slot: `kek = scrypt(password UTF-8, salt = hex(slot.salt),
   N = slot.n, r = slot.r, p = slot.p, dkLen = 32)`.
3. `masterKey = AES-256-GCM-decrypt(kek, nonce = hex(slot.key_params.nonce),
   ciphertext = hex(slot.key) ‖ hex(slot.key_params.tag))`. This must give 32
   bytes. A GCM tag failure means try the next slot, and in the end show
   "Wrong password or damaged file".
4. `db = JSON.parse(UTF-8(AES-256-GCM-decrypt(masterKey, nonce =
   hex(header.params.nonce), ciphertext = base64(db) ‖ hex(header.params.tag))))`.
5. Zero `kek`, `masterKey` and the password bytes.

**Confirm before shipping:** the slot type numbers (0 raw, 1 password/scrypt,
2 biometric), the field names (`n`, `r`, `p`, `salt`, `key`, `key_params`) and
the GCM layout must be checked against a real Aegis export. Make that export
with **made-up test accounts** on a test device, encrypted with a test
password, and commit it as a fixture (section 8). Do the same for 2FAS. If
Aegis behaves differently, the export wins and this section must be updated in
the same PR.

scrypt limits (Aegis default is N = 2^15, r = 8, p = 1): N must be a power of
two with 2^10 ≤ N ≤ 2^20, 1 ≤ r ≤ 16, 1 ≤ p ≤ 4, and 128·N·r·p ≤ 256 MiB.
Anything outside these bounds is refused before deriving. This stops a crafted
file from freezing or crashing the tab. WebCrypto has no scrypt. We use
`scrypt` from `@noble/hashes` (MIT, the same author and licence as
`app/static/js/vendor/noble-crypto.js`). Today's bundle exports only `gcm`,
`pbkdf2Async` and `sha256`. The bundle is rebuilt with `scryptAsync` added.
The version is pinned, the hash is recorded in `client-manifest.json`, and the
vendoring note in `docs/CRYPTO_KEY_VALIDATION_AUDIT.md` is updated. AES-GCM
uses WebCrypto (`crypto.subtle`), with noble `gcm` as fallback.

**Entry mapping** (`db.entries[]`):

| Aegis | Our field | Rule |
| --- | --- | --- |
| `type` | `otp_type` | `totp`, `hotp`. `steam`, `motp`, `yandex` → skipped with reason. |
| `name` | `label` | |
| `issuer` | `issuer` | |
| `info.secret` | `secret` | Base32. |
| `info.algo` | `algorithm` | SHA1/SHA256/SHA512. MD5 → skipped. |
| `info.digits` | `digits` | 6–8. |
| `info.period` | `period` | TOTP. |
| `info.counter` | `counter` | HOTP, required. |
| `note` | `note` | Text only. |
| `favorite` | tag `Favourite` | |
| `groups[]` (db v3: uuids into `db.groups[{uuid,name}]`) or `group` (db v2: a name) | `tags` | Group names become tags. |
| `uuid` | not stored | Only used to dedupe within one file. |
| `icon`, `icon_mime`, `icon_hash` | **ignored** | See 6.5. `icon_id` is set by issuer matching. |

Limits: those in 3.0. Top-level `version` ≠ 1 or db `version` not in {1, 2, 3}
means "Unsupported Aegis version", so we never guess.

### 3.3 2FAS `.2fas` (plain and encrypted)

A JSON file from the 2FAS app backup (`schemaVersion` 3 or 4 seen in the
wild; others are refused).

**Plain:** a top-level `services[]` array.

**Encrypted:** `services` is empty or missing, and `servicesEncrypted` is a
string of three base64 parts joined by `:`:
`base64(ciphertext ‖ GCM tag) : base64(salt) : base64(iv)`.

1. `key = PBKDF2-HMAC-SHA256(password UTF-8, salt, iterations = 10 000,
   dkLen = 32)`. Use WebCrypto `deriveBits`.
2. `services = JSON.parse(UTF-8(AES-256-GCM-decrypt(key, iv, ciphertext‖tag)))`.
   The IV is 12 bytes and the tag is 16 bytes.
3. `reference`, if present, is also decrypted, as a password check. A
   failure gives "Wrong password or damaged file".
4. Zero the key and password bytes.

**Confirm before shipping:** the iteration count, the salt length and the
order of the three parts must be checked against a 2FAS export with made-up
test accounts and a test password. Commit that export as a fixture. If 2FAS
behaves differently, the export wins.

Limits: iterations as found in the file, but only 1 000 ≤ iterations ≤
2 000 000 (otherwise refuse). Salt 8–512 bytes. IV exactly 12 bytes.

**Service mapping** (`services[]`):

| 2FAS | Our field | Rule |
| --- | --- | --- |
| `secret` | `secret` | Base32. |
| `otp.tokenType` | `otp_type` | `TOTP`, `HOTP`. `STEAM` → skipped. |
| `otp.issuer`, else `name` | `issuer` | |
| `otp.account`, else `otp.label` | `label` | |
| `otp.algorithm` | `algorithm` | |
| `otp.digits` | `digits` | |
| `otp.period` | `period` | |
| `otp.counter` | `counter` | HOTP, required. |
| `groupId` → `groups[{id,name}]` | `tags` | |
| `order.position` | `sort` | Only if every imported service has one. |
| `icon.*` (`label`, `iconCollection.id`, colours) | **ignored** | We use issuer matching. 2FAS icon ids do not map to our set. |
| `updatedAt`, `badge`, `otp.source`, `otp.link` | ignored | `otp.link` is not parsed a second time. |

### 3.4 Google Authenticator `otpauth-migration://`

Source: Google Authenticator's "Transfer accounts → Export" shows one or more
QR codes, each with `otpauth-migration://offline?data=<base64>`. The base64
may be URL-encoded (`%2B`, `%2F`, `%3D`), and both standard and URL-safe
base64 are accepted.

`data` is a protobuf `MigrationPayload`. We decode it with a small hand-written
protobuf reader (varint and length-delimited wire types only, about 100
lines). We add no protobuf library.

```
MigrationPayload {
  repeated OtpParameters otp_parameters = 1;
  int32 version = 2;  int32 batch_size = 3;  int32 batch_index = 4;  int32 batch_id = 5;
}
OtpParameters {
  bytes secret = 1;  string name = 2;  string issuer = 3;
  Algorithm algorithm = 4;   // 0 unspecified→SHA1, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5→skip
  DigitCount digits = 5;     // 0 unspecified→6, 1 SIX, 2 EIGHT
  OtpType type = 6;          // 0 unspecified→skip, 1 HOTP, 2 TOTP
  int64 counter = 7;
}
```

| Protobuf | Our field | Rule |
| --- | --- | --- |
| `secret` (raw bytes) | `secret` | Base32-encode it. 10–128 bytes. |
| `name` | `label` | If it looks like `Issuer:Account` and `issuer` is empty, split it as in 3.1. |
| `issuer` | `issuer` | |
| `algorithm` | `algorithm` | See the enum above. |
| `digits` | `digits` | |
| `type` | `otp_type` | |
| `counter` | `counter` | HOTP. |
| (none) | `period` | Always 30. The format has no period field. |

**Batches.** A large export is split over several QR codes, all sharing
`batch_id`, numbered `batch_index` 0 … `batch_size − 1`. The scanner keeps
scanning, shows "QR 2 of 4 scanned", ignores a batch it has already seen, and
offers the preview once all batches are in. The user may also choose
"Import what I have" (with a warning), or cancel. A batch with a different
`batch_id` starts a separate collection, and the UI says so.

Limits: `data` ≤ 4 096 chars after decoding the URI. `batch_size` ≤ 50. At
most 2 000 accounts in total. Unknown protobuf fields are skipped by wire
type. A truncated varint, a length past the end of the buffer, nesting deeper
than 2, or a varint longer than 10 bytes means that batch is refused.

## 4. Authy: no official export

**Authy (Twilio) has no official export function.** It has never offered
one. Its desktop apps, which unofficial tools used to read secrets from, were
shut down in 2024. We do not build, ship or link to any tool that extracts
secrets from Authy. We do not promise an "Import from Authy" button.

The honest route, which the app shows when the user picks "Authy" in the
import screen:

1. **Re-link per site (recommended).** For each account in Authy: sign in to
   that site, open its 2FA/security settings, choose to set up a new
   authenticator app (or "disable and enable 2FA again"), and scan the new QR
   code with our scanner. Check that a code from us works on the site. Only
   then remove the account from Authy. This also rotates the secret, which is
   good hygiene. The screen shows this as a checklist the user can follow
   site by site. Nothing is saved besides the accounts the user adds.
2. **If the user already has the secrets** as `otpauth://` links (for
   example noted down when they first set up 2FA, or exported from another
   app they used in parallel), they can paste them as an otpauth list
   (section 3.1).

The text must not suggest that we can read Authy data, and must not name
third-party extraction tools.

## 5. Scanner

### 5.1 Order of decoders

1. **Native `BarcodeDetector`** (`formats: ['qr_code']`) when
   `BarcodeDetector.getSupportedFormats()` includes `qr_code`. This is
   available in Chromium on Android, macOS and ChromeOS, and Safari has it
   behind flags or partially.
2. **Fallback: the vendored jsQR**, as `decodeQrFromSource` already does
   (`app.js:4771`). Keep `inversionAttempts:'attemptBoth'` for dark-mode QR
   codes. On mobile, decoding moves to a worker with `OffscreenCanvas` where
   available, so the camera preview does not stutter.

### 5.2 jsQR: the pinned fallback

| | |
| --- | --- |
| Candidate | **jsQR** (`jsqr` on npm, github.com/cozmo/jsQR), the UMD build `dist/jsQR.js` |
| Version | **1.4.0** (the last release; the project is stable and no longer changes) |
| Licence | **Apache-2.0** |
| File | `app/static/js/vendor/jsQR.js` (already in the repo) |
| SHA-256 | `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` (of the file now in the repo, also recorded in `app/static/client-manifest.json`) |

Work for the builder:

- Compare the repo file with `dist/jsQR.js` from the `jsqr@1.4.0` npm tarball
  (check the tarball against the registry integrity hash). If they are equal,
  record that. If they differ, replace the file with the upstream one and
  update the hash here and in the manifest in the same PR.
- Add `app/static/js/vendor/jsQR.LICENSE` (the Apache-2.0 text plus the
  upstream copyright line) and a line in the third-party notices.
- Add a test that fails when the SHA-256 of `vendor/jsQR.js` is not the one
  in this table. Changing the decoder means a reviewed change of both.

Rejected candidates: `zxing-js/library` (Apache-2.0, but more than 10× the
size for a single format, in maintenance mode); `html5-qrcode` (wraps zxing
and adds UI we do not want); WASM decoders (an extra CSP `wasm-unsafe-eval`
for the main page, which we do not want).

### 5.3 Camera, image and paste

- **Camera:** as today (`getUserMedia`, rear camera, no audio). Additions:
  - a torch toggle where `track.getCapabilities().torch` exists;
  - the stream is stopped on dialog close, vault lock, tab hide
    (`visibilitychange`) and after 2 minutes without a hit;
  - nothing is recorded and no frame leaves memory.
- **Multi-scan mode:** for Google batches and for adding several accounts in a
  row, results are collected into the preview (section 3.0) instead of being
  saved on the first hit.
- **Image:** pick or drop a screenshot (PNG/JPEG/WebP/GIF, ≤ 10 MB, decoded at
  most 4 096 px on the long side). Use `BarcodeDetector.detect` on the bitmap,
  then jsQR. If nothing is found, try once more at 50% scale and once
  grey-scaled. Object URLs are revoked right after use. HEIC goes through the
  existing vendored `heic2any` only if it is already loaded; otherwise show
  "Convert to PNG first".
- **Paste:** in the import screen, Ctrl/Cmd+V accepts:
  - text: `otpauth://`, a list, `otpauth-migration://`, or Aegis/2FAS JSON;
  - an image from the clipboard (`ClipboardEvent.clipboardData.files`), which
    is decoded like an image file.

  We do not read the clipboard without a user paste event.
- **Payload routing:** each decoded QR string goes through the same detector
  as 3.0. Anything that is not `otpauth://` or `otpauth-migration://` is shown
  as "This QR code is not an authenticator code". We never show, open or fetch
  its content (a URL in a QR code is never followed).

## 6. Icons

### 6.1 The set

| | |
| --- | --- |
| Set | **Simple Icons** (`simple-icons` on npm, simpleicons.org): monochrome SVG brand logos with an official brand colour per icon |
| Version | pinned to **`simple-icons@14.0.0`**. The vendored tarball's SHA-256 and the registry integrity string are written to `app/static/icons/brands/SOURCE.txt` when vendoring. The build checks them. |
| Licence | **CC0-1.0** for the collection. **Exclude** every icon whose entry in the package's data file has its own `license` field that is not CC0 (a small number carry other terms). |
| Where | `app/static/icons/brands/` as **one** sprite file `brands.svg` (`<symbol id="si-<slug>">`) plus `brands.json` (`slug → {title, hex, aliases}`), generated by a script in `scripts/` from the pinned tarball. The sprite goes into `client-manifest.json`. |
| Size budget | Only the brands that are common 2FA issuers are kept (an allow-list of about 400 slugs in the script), so the sprite stays small and is loaded only when the 2FA tab opens. |

Upgrading the set is a reviewed change that updates version, hash and the
allow-list together.

### 6.2 Trademark caveat

CC0 covers the copyright in the SVG drawings only. **The logos are trademarks
of their owners.** We use them only to identify the account the user added
("nominative use"), never to suggest endorsement or partnership, and never in
marketing material or app-store screenshots of our own. We show logos in
their own brand colour or monochrome, without changes. `SOURCE.txt` and the
third-party notices say this. If a trademark owner asks us to remove a logo,
we remove it from the allow-list, and that account falls back to the letter
avatar.

### 6.3 Matching on issuer

`icon_id === null` (automatic) resolves at render time:

1. Normalise `issuer`: NFKC, lower case, strip accents, and remove the
   suffixes ` inc`, ` llc`, ` ltd`, `.com` and similar, plus all non-`[a-z0-9]`.
2. Look it up in an exact map of `slug`, the normalised `title`, and
   `aliases` from `brands.json`, plus a small hand-kept alias table (e.g.
   `google workspace → google`, `twitter → x`).
3. If there is no match and `host` is set, try the registrable domain of
   `host` (`accounts.example.com → example`).
4. No fuzzy matching. A wrong logo is worse than a letter.

The user can override the icon in the edit dialog. A searchable picker over
the vendored set sets `icon_id` to a slug, and "Letter" sets it to `'letter'`.

### 6.4 Letter avatar (fallback)

A rounded square with the first grapheme of `issuer` (else of `label`) in
upper case, white or black text (whichever has WCAG AA contrast). The
background is one of 12 fixed colours from the app palette, picked by a stable
hash of the normalised issuer. It is generated as inline SVG/CSS text, never
an image from elsewhere. It must look right in light and dark themes and at
the narrow list width (`tests/test_round86_totp_list_narrow.js`).

### 6.5 Embedded icons in imports

Aegis (`icon` base64) and 2FAS (`iconCollection`) icons are **not imported**.
Decoding user-supplied images (possibly SVG) into the app is an XSS and
parser risk, and it would put arbitrary blobs into the vault. Issuer matching
covers the common cases, and the user can pick an icon by hand.

### 6.6 No network

All icons come from our own origin. The 2FA view sets no `<img src>` to
another host. A test fails if `brands.svg`, `brands.json` or any 2FA template
or module contains `http://` or `https://` outside comments and the
`SOURCE.txt` provenance line. We never fetch favicons, Clearbit-style logo
APIs, Google s2 favicons, or DuckDuckGo icons.

## 7. Search, labels and tags

### 7.1 Search

- One field, as today (`filteredTotpEntries`). It now matches `issuer`,
  `label`, `host`, `tags` and `note`. The query is split on whitespace and
  every term must match (AND). Matching is case- and accent-insensitive
  (NFKD, combining marks removed).
- `tag:work` limits the list to a tag, and `#work` is a short form.
- The search runs in memory over the decrypted list only. Nothing goes to the
  server, nothing is saved in history or `localStorage`, and the field is
  cleared on lock.
- Keyboard: `/` focuses search. With one result, Enter copies its code
  (through the existing `copyScope:'totp'` path).

### 7.2 Labels and tags

- The `label` is the account name (section 2). It can be edited in the edit
  dialog alongside `issuer`.
- `tags` are free names stored **inside each 2FA item**. They are not shared
  with note tags. Note tags are separate vault items, and linking them would
  leak note-structure changes into 2FA syncs. The tag picker suggests existing
  2FA tags (autocomplete, like `tagsuggest.js`).
- Above the list sits a row of tag chips: "All", then each tag with a count.
  Renaming or deleting a tag updates every item that carries it (one batch,
  one sync).
- Imported groups (Aegis groups, 2FAS groups) and Aegis `favorite` become
  tags (sections 3.2–3.3).
- Order: alphabetical by `issuer` then `label` (as today), or manual `sort`
  when the user drags. Favourites are pinned on top.

## 8. Security requirements and test fixtures

### 8.1 Requirements

1. Zero knowledge: all parsing, KDFs and decryption run client-side. No new
   server route, and no change to `app/` Python code for this feature.
2. No network: no request leaves the page during scan, import or icon
   rendering. A test puts a stub on `fetch`, `XMLHttpRequest`, `Image.src`
   and `navigator.sendBeacon` and asserts zero calls during a full import of
   every fixture.
3. No new CSP relaxations for the main page. The KDF worker gets its own
   minimal CSP (`default-src 'none'`), as the ICS fetch worker does
   (`ICS_FETCH_WORKER_CSP` in `app/app.py:573`), and has no `connect-src`.
4. Secrets, passwords and decrypted file contents never reach `console.*`,
   error messages, toasts, `Error.message`, analytics, URLs, `localStorage`,
   `sessionStorage` or the service-worker cache. A test captures all of those
   during each fixture import and checks that the fixture secrets and password
   do not appear.
5. Bounded work: every size, count, depth and KDF parameter limit in section 3
   is enforced **before** the expensive step. Crafted fixtures must be
   refused within 1 s, with no tab freeze.
6. Constant error text for a wrong password or a damaged file (no oracle).
7. Password and key buffers are zeroed after use. Import state is dropped on
   vault lock, logout and tab close. An import in progress is cancelled by
   lock.
8. Untrusted text: every string from a file or QR code is rendered with
   `textContent` (or the existing `escapeHtml`). It is never rendered with
   `innerHTML`, never as a link, never fetched.
9. Atomic save: an import either saves all checked accounts or none (on a
   storage error it rolls back the items it wrote in that batch). Existing
   accounts are never overwritten by an import.
10. Vendored code (jsQR, noble with scrypt, Simple Icons) is pinned by hash in
    `client-manifest.json` and tested as in 5.2/6.1.
11. HOTP counter is written before the code is shown (section 2).
12. The export file is never kept. The UI advises the user to delete it.

### 8.2 Fixtures

All fixtures live under `tests/fixtures/2fa/`. They are **made by us with
made-up accounts and random secrets** (e.g. issuer `Example Bank`, label
`test@example.invalid`, secrets generated for the test). They **never** hold
real secrets. Each file has a header comment, or a sibling `.txt`, saying how
it was made. The test password is `test-password-not-real`. A test asserts
that every fixture's issuers use `example`, `.invalid` or `Test` names.

| Format | Fixtures | Must check |
| --- | --- | --- |
| otpauth | `otpauth-single-totp.txt`, `otpauth-hotp.txt`, `otpauth-list.txt` (TOTP, HOTP, SHA256 / 8 digits / 60 s, a label with `%3A` and Unicode, one broken line, one MD5 line), `otpauth-hotp-no-counter.txt`, `otpauth-too-long.txt` | Mapping per field; bad lines skipped and the rest kept; RFC 6238/4226 codes match. |
| Aegis plain | `aegis-plain-v2.json` (db v2, `group` string), `aegis-plain-v3.json` (db v3, `groups` uuids, `favorite`, a `steam` entry, an entry with an `icon`) | Groups → tags; steam skipped; icon ignored. |
| Aegis encrypted | `aegis-encrypted.json`: **made with the real Aegis app** on a test device, with made-up accounts and the test password. It has one **type 1 (password/scrypt)** slot. `aegis-encrypted-raw-only.json`: only a **type 0 (raw)** slot. `aegis-encrypted-biometric-only.json`: only a **type 2 (biometric)** slot. `aegis-encrypted-two-password-slots.json`: two type 1 slots, the first with a different password. `aegis-scrypt-n-too-big.json`: N = 2^24 | Opens with the right password; wrong password gives the constant error; raw-only and biometric-only give "no password slot"; the second password slot is tried; the over-cap N is refused before deriving. This fixture also confirms the slot type numbers (0/1/2) and field names in 3.2. |
| 2FAS plain | `2fas-plain-v4.json` (TOTP, HOTP, STEAM, groups, `order`) | Mapping; STEAM skipped; groups → tags. |
| 2FAS encrypted | `2fas-encrypted.2fas`: **made with the real 2FAS app** with made-up accounts and the test password, plus `2fas-iterations-too-high.2fas` and `2fas-bad-iv.2fas` | Opens; constant error; limits enforced. Confirms 3.3. |
| Google migration | `google-single.txt` (one `otpauth-migration://` URI), `google-batch-{0,1,2}-of-3.txt` (same `batch_id`), `google-other-batch.txt`, `google-md5-and-unspecified-type.txt`, `google-truncated-varint.txt`, plus the same payloads rendered as `google-batch-*.png` QR images | Batch collection and dedupe; MD5 and unspecified type skipped; a malformed protobuf is refused; the PNGs decode through jsQR (with `BarcodeDetector` stubbed out) to the same accounts. Payloads are generated by a test helper from made-up secrets. Confirm the encoding once against a real Google Authenticator export of made-up accounts. |
| Scanner | `qr-otpauth.png`, `qr-otpauth-inverted.png`, `qr-not-otp-url.png`, `qr-none.png` | jsQR fallback; inversion; a non-OTP QR is refused without fetching; "No QR code found". |
| Icons | `issuers.json` (issuer → expected slug or `letter`) | Matching rules from 6.3, no fuzzy matches, letter avatar contrast. |
| Migration | `totp-schema1-items.json` (items as stored today) | Section 2.2 round-trip, no field lost, old reader still works. |

Generated fixtures (otpauth, Google, crafted bad files) are produced by a
script in `tests/` with fixed random seeds, so they can be rebuilt. App-made
fixtures (Aegis, 2FAS, one Google check) are committed as files, with the app
name, app version and date of creation noted next to them.
