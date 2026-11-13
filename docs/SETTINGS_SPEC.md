# Encrypted user settings sync: specification

Status: design. Nothing in this document is implemented yet. It describes what
will be built, so that code, tests and SECURITY.md/PRIVACY.md can be checked
against one source. All file:line references are to the tree at the time of
writing (branch `bot/task-41-...`); line numbers drift, function and constant
names are the stable handle.

Goal (idea #48): a setting such as the Agenda view (3-day, week, ...) is
remembered after an app restart and on every device of the same account. The
same applies to the other user settings that are safe to sync.

Hard rules:

- Only allowlisted keys sync (section 2). Secrets, free text, e-mail, keys and
  passwords never enter the settings record.
- The record is encrypted with the vault key before it leaves the device. The
  server only ever sees ciphertext.
- Nothing readable is kept in localStorage / sessionStorage / cookies for the
  synced keys (section 5).

## 1. Inventory of existing settings

### 1.1 Does an agenda exist?

**Yes.** `app/static/js/agenda.js` ("week / day / 3-day / month / list views;
vault-encrypted events", header line 2). The view ids are
`day`, `3day`, `week`, `month`, `agenda` (list):

- Whitelist regex on load: `agenda.js:2920`
  (`/^(day|3day|week|month|agenda)$/`).
- Default per screen size: `defaultAgendaView()` at `agenda.js:87-92`
  (`<=430px` -> `day`, `<=768px` -> `3day`, otherwise `week`; no `matchMedia`
  -> `week`). Initial `state.view: 'week'` at `agenda.js:280`.
- View picker buttons (`month`, `week`, `3day`, `day`): `agenda.js:999-1002`;
  click handler `agenda.js:1330-1334`; keyboard shortcut `view:` at
  `agenda.js:2873-2877`; `onTabShown()` re-writes it at `agenda.js:2940`.
  Jumping to a day sets `state.view = 'day'` at `agenda.js:1388` and `1441`
  (those two paths do not persist the choice today).

**Current bug behind the idea:** the agenda view is stored only in
`sessionStorage['notes_agenda_view']` (`agenda.js:1334`, `1389`, `2877`,
`2919`, `2940`). sessionStorage dies with the tab/app, so the choice is lost on
restart and never reaches other devices.

### 1.2 Existing sync mechanism for settings (important)

Settings already sync, in a limited way:

- `app.js:253-267` defines `GLOBAL_PREF_KEYS`, `VAULT_ONLY_PREF_KEYS`,
  `DEVICE_PREF_KEYS`.
- `pushGlobalPrefs()` `app.js:288`, `pullGlobalPrefs()` `app.js:312`,
  `savePrefs()` `app.js:380` (writes localStorage `deeperguard-prefs`, then
  pushes).
- Store side: `SETTINGS_TYPE = 'settings'`, `settingsItem()`,
  `getGlobalSettings()`, `saveGlobalSettings()` at `store.js:5231-5272`. It is
  one vault item `{type:'settings', prefs:{...}}` pushed through the normal
  item sync.

Gaps this spec closes:

1. The agenda view is not in `GLOBAL_PREF_KEYS` at all.
2. `GLOBAL_PREF_KEYS` contains secrets: `aiChat` (holds an API key,
   `app.js:20993`, `21036`), `googleOauthClientId`, `dropboxAppKey`,
   `dropboxRefreshToken`, `dropboxAccessToken`, `dropboxTokenExpiresAt`,
   `dropboxConnected` (`app.js:255-260`). They are encrypted inside the vault,
   but the new record must not carry them (they stay in the existing item,
   untouched by this spec).
3. No per-key timestamps: the whole item is last-writer-wins on its single
   `updated_at` (`pullGlobalPrefs`, `app.js:319`), so two devices changing
   different settings overwrite each other.
4. No padding and no AAD: `NotesCrypto.encryptObject` (`crypto.js:114-121`)
   encrypts `JSON.stringify(obj)` with AES-256-GCM and a random 12-byte IV
   (`randomIv()`, `crypto.js:105-112`), but no additional authenticated data
   and no length hiding.
5. Unlocked-only read is true for the vault item, but the same prefs are also
   mirrored in plain `localStorage['deeperguard-prefs']` (`app.js:202`, `331`,
   `381`, `459`).

### 1.3 All existing settings

Defaults are in the `prefs` object, `app.js:163-196`. "Where" is the main
read/write site.

| Key | Where | Today stored in | Syncs today |
| --- | --- | --- | --- |
| `theme` | `app.js:164`, UI `20740-20742` | localStorage prefs + vault item | yes |
| `fontSize` | `app.js:165`, input `app.js:21065`, `app.html:1692` (13-22) | same | yes |
| `monospace` | `app.js:166`, `21069` | same | yes |
| `spellcheck` | `app.js:167`, `21073` | same | yes |
| `hidePreviews` | `app.js:168`, `20913` | same | yes |
| `compactList` | `app.js:169`, `20900-20909` | same | yes |
| `sort` | `app.js:170`, `NOTE_SORT_ORDER` `app.js:344`, `setNoteSort` `369` | same | yes |
| `autoPreview` | `app.js:171`, `21077` | same | yes |
| `autoOpenPdfOnly` | `app.js:173`, `21082`, read `3232` | same | yes |
| `autoLockMin` | `app.js:174`, `21086`, `app.html:1766-1771` | same | yes |
| `lockOnUnfocus` | `app.js:175`, `208-213`, `21091`, `app.html:1777-1779` | same | yes |
| `navPinned` | `app.js:178`, `20798-20799` | localStorage prefs | **no** |
| `rememberDevice` | `app.js:176`, `21096-21099` | localStorage prefs | no (device) |
| `lightVault` | `app.js:177`, `207`, `20917` | localStorage prefs | no (device) |
| `tagsCollapsed` / `foldersCollapsed` / `viewsCollapsed` | `app.js:186-188`, `19057-19080` | localStorage prefs | no (device) |
| `searchFilters` (`titlesOnly`, `includeArchived`, `includeTrashed`, `includeProtected`, `tagIds`) | `app.js:189-195`, `241-251` | localStorage prefs | no (device) |
| `listPaneWidth` | `app.js:413-460` | localStorage prefs | no (device) |
| `listChromeDense`, `snListStyle`, `tagsExpandedDefault` | `app.js:215-240` | localStorage prefs (one-time migration markers) | no |
| `aiChat` (incl. API key) | `app.js:179`, `20993`, `21036` | vault item only | yes (secret) |
| `googleOauthClientId` | `app.js:180`, `22808` | vault item only | yes (secret/ID) |
| `dropboxAppKey`, `dropboxRefreshToken`, `dropboxAccessToken`, `dropboxTokenExpiresAt`, `dropboxConnected` | `app.js:181-185`, `22559-22569`, `23094` | vault item (`dropboxConnected` also localStorage) | yes (secret) |
| `agenda_reminder_email`, `agenda_reminder_push` | `agenda-reminders.js:185-196`, `403-413` | localStorage `deeperguard-prefs` | no |
| Agenda view (`day`/`3day`/`week`/`month`/`agenda`) | `agenda.js:2919-2920`, `1334`, `2877` | sessionStorage `notes_agenda_view` | **no** |
| Cloud backup prefs | `cloud-backup.js:23`, `64` (`deeperguard-cloud-backup[:scope]`) | localStorage | no (tokens, device) |
| Vault copy counters | `vault-copy-meta.js:7` | localStorage, "not synced" by design | no |
| AI send consent / cloud acks | `ai-chat.js:25-28`, `384-430` | localStorage | no (consent is per device on purpose) |
| Device phrase (anti-phishing text) | `device-phrase.js` (`notes_device_phrase*`), `auth-pages.js:203` | localStorage | no (free text) |
| Verify-ask-AI pin seen | `verify-ask-ai-provider.js:8` | localStorage | no |
| Release hash cache, sync log, last sync, KDF flags, device id, deep link, selftest, reminder pending | `release-integrity.js:21`, `store.js:193`, `897`, `415-694`, `srp-auth.js:187`, `app.js:1580`, `14974`, `16405` | localStorage / sessionStorage | no (bookkeeping, not settings) |
| Auth/session keys (`notes_email`, `notes_kdf_salt`, `notes_csrf`, boot/device keys, ...) | `auth-pages.js`, `vault-secrets.js`, `store.js:1298-1329` | local/sessionStorage | no (credentials) |

## 2. Allowlist

Single source of truth: a frozen constant `SETTINGS_ALLOWLIST` (planned in a new
`app/static/js/settings-sync.js`). Anything not listed is dropped on read and on
write.

| Key | Type | Allowed values | Default |
| --- | --- | --- | --- |
| `theme` | enum string | `light`, `dark`, `system` (`app.js:532-535`, `661`) | `light` |
| `fontSize` | integer | 13..22 | `16` |
| `monospace` | boolean | `true`, `false` | `false` |
| `spellcheck` | boolean | `true`, `false` | `true` |
| `hidePreviews` | boolean | `true`, `false` | `false` |
| `compactList` | boolean | `true`, `false` | `true` |
| `sort` | enum string | `updated`, `created`, `title` | `updated` |
| `autoPreview` | boolean | `true`, `false` | `false` |
| `autoOpenPdfOnly` | boolean | `true`, `false` | `true` |
| `autoLockMin` | integer | `0`, `1`, `5`, `15`, `30`, `60` (`app.html:1766-1771`) | `15` |
| `lockOnUnfocus` | enum string | `never`, `immediate`, `1min` | `1min` |
| `navPinned` | boolean | `true`, `false` | `false` |
| `agendaView` | enum string | `day`, `3day`, `week`, `month`, `agenda` | `null` = "no choice yet": use `defaultAgendaView()` (`agenda.js:87`) |

Notes:

- `agendaView` is a **preference with a screen-size default**. A device that has
  never chosen a view keeps using `defaultAgendaView()`; once the user picks a
  view it is synced and wins everywhere. Acceptable trade-off: a phone choice of
  `day` also applies on a desktop. If that proves annoying, split into
  `agendaViewCompact` / `agendaViewWide` (decide before implementing; default
  of this spec: one key).
- Security-relevant keys (`autoLockMin`, `lockOnUnfocus`) are included because
  they already sync today. A synced value can only be one of the enumerated
  values; the client never accepts "never lock" unless the user chose it.
  `lockOnUnfocus` keeps today's normalisation (`app.js:208-213`, `325-327`).
- Booleans must be real booleans, integers real integers (no numeric strings).

Explicitly excluded (never in the record):

- Anything with secrets: `aiChat` (API key), `googleOauthClientId`,
  `dropboxAppKey`, `dropboxRefreshToken`, `dropboxAccessToken`,
  `dropboxTokenExpiresAt`, `dropboxConnected`, cloud backup prefs, device/boot
  keys, TOTP data.
- Free text and identity: device phrase, e-mail, `notes_email`, search text,
  `searchFilters.tagIds` (tag ids are vault data), folder/tag names.
- Device-specific behaviour: `rememberDevice`, `lightVault`, `listPaneWidth`,
  collapsed-section flags, `searchFilters`, agenda reminder channels
  (push depends on this device's subscription), AI consent acks, migration
  markers (`listChromeDense`, `snListStyle`, `tagsExpandedDefault`).
- Scroll position and similar ephemeral UI state (`agenda.js:535-654`).

## 3. Storage format

One settings record per user.

Plaintext (before encryption):

```json
{
  "v": 1,
  "keys": {
    "agendaView": { "value": "3day", "updatedAt": 1767225600123 },
    "theme":      { "value": "dark", "updatedAt": 1767225000000 }
  }
}
```

- `v`: schema version (integer). A reader that sees `v` greater than it knows
  treats the record as undecryptable-for-our-purposes: use defaults, do not
  overwrite (section 7).
- Per key: `value` plus `updatedAt` (ms since epoch, integer, from the writing
  device's clock; see section 6 for clock skew).
- Only keys changed by the user need an entry; missing keys mean "default".

Encryption:

- AES-256-GCM with the existing vault key (the same raw key used by
  `NotesCrypto.encryptObject`, `crypto.js:114`; `noble().gcm(...)`).
- Fresh random 96-bit IV per write via `randomIv()` (`crypto.js:105`). Never
  reused, never derived.
- AAD (additional authenticated data), UTF-8 bytes of
  `dg:settings:v1|<user_id>`: binds the ciphertext to its record type and
  user, so a server cannot swap another record or another user's record into
  this slot. **Gap:** the current client code does not hold the numeric
  `user_id` (no match in `store.js`), so a small read-only addition to the
  account payload is needed. `encryptObject`/`decryptObject` currently take no
  AAD, so add an optional `aad` argument (new payload version `v: 2`; `v: 1`
  stays decryptable for all existing items).
- Padding before encryption to a fixed size: serialise to UTF-8, prefix with a
  4-byte big-endian length, append zero bytes to exactly **1024 bytes**. If the
  plaintext would exceed 1024 bytes, round up to the next multiple of 1024.
  With the allowlist above (13 keys) the record stays far below 1024 bytes, so
  in practice every record is the same size. On read, check the length prefix
  against the buffer, reject if inconsistent.
- Wire payload is the existing shape `{ v: 2, iv, data }` (base64), serialised
  as the item `ciphertext` string.

## 4. Storage path: reuse the existing sync

No new endpoint. The record is an ordinary vault item and travels through the
existing encrypted sync:

- Client: `NotesStore.upsert(uuid, content)` (`store.js:4812`) -> wrap and
  encrypt (`store.js:1655-1693`, `syncPushWrapStamp` `1620`) -> `POST
  /api/sync/items` (`app.py:3279`, `api_sync_push`) -> `db.upsert_items_batch`
  (`db.py:2003`). Pull via `/api/sync/pull` (`app.py:3251`).
- The item's `type` lives inside the ciphertext (like `SETTINGS_TYPE` at
  `store.js:5232`); the new type string is `ui_settings`, separate from the
  existing `settings` item so the secret-bearing item is left alone.
- `item_uuid` is deterministic so that two devices never create two records:
  first 16 bytes of HMAC-SHA256(vault key, `"dg:settings:v1:uuid"`), formatted
  as a UUID. Opaque to the server, identical on every device. This removes the
  duplicate-retirement loop that `saveGlobalSettings` needs (`store.js:5266`).
- Auth, per-item size limit (`SYNC_MAX_ITEM_BYTES`, `db.py:1810`), quota and
  existing sync rate handling apply automatically. The record is about 1.4 KB
  base64, negligible against quota.
- The `NotesFreshness` stamping (`store.js:1666`) applies like for other
  item types; the record merge logic in section 6 runs after it.
- `GLOBAL_PREF_KEYS` shrinks accordingly (the non-secret keys move to the new
  record; secrets stay in the old item). Migration: on first unlock after
  update, if no `ui_settings` item exists, seed it from the legacy values
  (once, with `updatedAt` = legacy item time), then stop writing those keys to
  the old item.

A new endpoint is **not needed**; do not add one.

## 5. Loading and local copies

- Loaded only after unlock: the record is read from the in-memory item store
  (`NotesStore.isUnlocked()` true, as `pushGlobalPrefs` checks at `app.js:289`).
  Before unlock (lock screen, login pages) built-in defaults are used.
- Remove the readable copies: synced keys are no longer written to
  `localStorage['deeperguard-prefs']` (`localPrefsJson`, `app.js:274-278`) nor
  `sessionStorage['notes_agenda_view']` (`agenda.js:1334`, `1389`, `2877`,
  `2940`). `localStorage` keeps only device-only keys from section 1.3.
  On first run after update, delete the old synced keys from
  `deeperguard-prefs` and delete `notes_agenda_view` after migrating them.
- Offline: the record is part of the offline IndexedDB vault copy (same as
  every other item, `idb.js`), so settings are available offline after unlock.
- Lock: on vault lock, in-memory settings are cleared with the other items.
  Theme before unlock falls back to `system`-style defaults; this is the
  intended cost of "nothing readable".
- Cookies: none used.

## 6. Writes and conflicts

- Write: on a user change, set `keys[k] = {value, updatedAt: Date.now()}` in the
  in-memory record and schedule one save, **debounced 1 s** (trailing). Slider
  input (`fontSize`) therefore produces one write. Flush immediately on vault
  lock and on `visibilitychange` to hidden.
- Merge (pull and push): per key, last-writer-wins on `updatedAt`. Higher wins;
  tie -> lexicographically larger JSON of `value` wins, so all devices converge.
  Keys present on only one side are kept. After merging, if the result differs
  from the server copy, write it back (still debounced).
- Item-level conflicts from `/api/sync/items` (`stale`/`conflict` results,
  `app.py:3304-3306`): re-pull, re-merge per key, retry once.
- Clock skew: `updatedAt` comes from device clocks. Clamp any value more than
  5 minutes in the future to "now" on read, so a wrong clock cannot pin a key
  forever. Residual risk: a device with a slow clock can lose to older data;
  acceptable for UI preferences.
- Do not write on load, only on user action (avoids the Round 55 race noted at
  `app.js:269-272`): keep the "hydrated before first push" guard
  (`globalPrefsHydrated`).

## 7. Validation after decryption

Order: decrypt -> check length prefix -> JSON parse -> check `v` -> validate
each key against the allowlist.

- Unknown keys: ignored (and not re-written by this client, so a newer client's
  keys are lost only if it is also older than the writer; see below).
- Invalid value (wrong type, not in the allowed set, out of range): ignore that
  key, use its default. Valid sibling keys still apply.
- Newer schema `v`: apply nothing, use defaults, and **do not write** back, so
  an old client cannot destroy a newer client's data.
- Decryption failure (bad tag, wrong key, bad padding, malformed JSON): use
  defaults for all keys, show no crash, log nothing sensitive, and **never push
  over the server record** in that session until a valid record has been read
  or the user explicitly changes a setting. Even then the write is a fresh
  merge that starts from defaults, so the first explicit change after a failed
  decrypt is the only case that replaces the record; surface a quiet one-line
  notice instead of failing silently. (Rationale: do not let a transient key or
  network problem wipe settings, but do not make settings permanently
  unwritable.)
- Existing guard: `unverifiedKeyError()` in `upsert` (`store.js:4813`) already
  stops writes with an unverified key; keep it.

## 8. Metadata the server still sees

The server stores `items` rows (`db.py:88-99`): `user_id`, `item_uuid`,
`content_version`, `ciphertext`, `content_hash`, `deleted`, `updated_at`.

For the settings record it therefore sees:

- That a settings record **exists** for the user (a row with a stable, opaque
  `item_uuid`; it cannot tell it is a settings record because type is inside
  the ciphertext and the uuid is HMAC-derived, but the same uuid being rewritten
  repeatedly and staying about 1.4 KB makes it guessable).
- **When** it changed (`updated_at`) and how often (each save is a row update
  and a line in the sync log, `app.py:3310-3316`: user id, counts, bytes, time).
- Ciphertext size: constant (fixed padding) while below 1024 bytes, so the
  number of set keys and the values' lengths are hidden.
- `content_hash`, a hash of the ciphertext, which changes with every write
  because of the fresh IV, even when the content is identical. A device that
  skips unchanged writes (compare plaintext before saving) avoids needless
  updates.
- IP address and time of the sync request, as for any request.

It does **not** see key names, values, the agenda view, or which keys changed.

## 9. Test plan

Unit (Node, like `tests/test_crypto.js`, `tests/test_round55_prefs_counts.js`,
`tests/test_light_vault_settings.js`):

1. Allowlist: every key accepts each allowed value and rejects others (wrong
   type, out of range `fontSize` 12/23, `autoLockMin` 7, unknown enum, string
   `"true"`); unknown keys dropped; secrets (`aiChat`, `dropboxRefreshToken`,
   `googleOauthClientId`) never serialised, even if present in `prefs`.
2. Format: plaintext has `v` and per-key `value`+`updatedAt`; padded plaintext
   is exactly 1024 bytes for small records and a multiple of 1024 for larger;
   two records with different content produce equal ciphertext length.
3. Crypto: round trip; two encryptions of the same record give different IVs
   and ciphertexts; IV is 12 bytes; tampering with one ciphertext byte fails;
   wrong AAD (other `user_id`, other record type) fails; wrong key fails.
4. Merge: per-key LWW (A changes theme, B changes agendaView, both survive);
   tie-break deterministic and commutative; future `updatedAt` clamped;
   missing keys fall back to defaults.
5. Validation: invalid value falls back for that key only; newer `v` ->
   defaults and no write; corrupted ciphertext -> defaults, no throw, **no
   push** (spy on `NotesStore.upsert` / `/api/sync/items`).
6. Debounce: 10 rapid changes -> one save after 1 s; flush on lock.
7. Storage hygiene: after changing every synced key, `localStorage`,
   `sessionStorage` and `document.cookie` contain none of the synced keys or
   values (scan serialised storage for `3day`, `dark`, key names); legacy
   `notes_agenda_view` and synced keys in `deeperguard-prefs` are removed after
   migration.
8. Lock: after vault lock, in-memory settings are cleared and defaults apply;
   nothing is read before unlock.
9. Agenda: `init()` uses the synced `agendaView` when valid, else
   `defaultAgendaView()`; changing view via button, shortcut and "jump to day"
   (`agenda.js:1388`, `1441`) records it; invalid stored view falls back.
10. Migration: legacy `settings` item with non-secret prefs seeds the new
    record once; secret keys stay only in the legacy item; second run is a
    no-op.

Server / integration (Python, against a test DB, like the existing sync tests):

11. The record round-trips through `/api/sync/items` and `/api/sync/pull`
    unchanged; the server row contains no plaintext key names or values
    (grep the stored `ciphertext` for `agendaView`, `3day`, `theme`).
12. Another user's session cannot read or overwrite the row (existing auth
    path); a record copied into another user's account fails to decrypt (AAD).
13. Size/quota: a settings write does not trip `too_large` or quota handling.

Manual / e2e (extend `tests/e2e_live_r19_prefs.py`):

14. Pick 3-day view, close and reopen the app, unlock: still 3-day.
15. Pick week on device A, unlock device B: B shows week after sync.
16. Change `theme` on A and `agendaView` on B while offline, reconnect: both
    changes survive on both devices.
17. Break the key (wrong password path): defaults, no crash, server record
    unchanged (compare `content_hash` before and after).

## 10. Docs to update when implemented

- `SECURITY.md` / `docs/PRIVACY.md`: settings are encrypted, padded, AAD-bound;
  list the metadata in section 8; state that the old plain `deeperguard-prefs`
  no longer holds synced settings.
- `client-manifest.json` must be regenerated with
  `scripts/build-client-manifest.py` whenever files under `app/static` change.
