# Contacts: data model, encryption, sync, UI, search, import and export formats: specification

Status: design. Nothing in this document is implemented. It exists so that the
build tasks, the tests, `PRIVACY.md` and the in-app texts can be checked
against one source. Section 11 lists the test cases the build tasks must turn
into tests.

Request (idea #225, owner, 19-11-2026): a new section **Contacts** in the
navigation, in this order: **Notes, Agenda, Contacts, 2FA**. It must import
every common contact format that other programs export.

Hard rules that run through every section:

- **Zero knowledge stays intact.** A contact is one vault item. Its content is
  encrypted in the browser with the vault key before it is pushed, exactly like
  a note, an agenda pack or a 2FA account. The server never receives a name, a
  number, an address or a photo in readable form.
- **Imported files never leave the browser.** The importer reads the file with
  the File API, parses it in the page and writes vault items. It makes no
  network request of its own. The only traffic after an import is the normal
  encrypted sync push.
- **Import files are untrusted input.** Hard limits, text only, no HTML, no
  fetching of URLs found in a file, no prototype-polluting keys (section 9).
- **Nothing is sent anywhere by an action on a contact.** `tel:`, `mailto:` and
  copy are local handoffs to the operating system or the clipboard. No map,
  avatar, lookup or "enrich" service is ever called.
- **Nothing is lost on a round trip.** Fields the model does not know are kept
  verbatim in `extra` and written back on export (section 2.4).

## 1. Inventory: what exists today

Checked by reading the code in this worktree at `bd24169` and by running the
app: a local server was started on an empty data directory (the same helper the
e2e tests use, `tests/e2e_signup_autounlock.py: start_server`), an account was
registered in Chromium and the app was opened at 1280x800 and 390x844. Line
numbers are the ones at that commit.

### 1.1 Contacts do not exist yet

A search of `app/` for a contacts feature found only unrelated hits:
`app/templates/contact.html` and `CONTACT_EMAIL` (the site's own "contact us"
page and address) and the `contact_email` argument of `_promo_payload` in
`app/app.py`. There is no contact item type, no tab, no import or export. So
everything below is new work, and no existing behaviour is renamed or
restructured.

### 1.2 How an item is stored and synced today

| Fact | Checked against |
| --- | --- |
| The server stores one opaque row per item: `item_uuid`, `content_version`, `ciphertext`, `content_hash`, `deleted`, `updated_at` (and a separate blob column used by attachments). There is no column for an item type, a title or a search key. | `CREATE TABLE IF NOT EXISTS items` in `app/db.py:90`. |
| The client builds the row in `wrapItem` (`app/static/js/store.js:1702`): `NotesCrypto.encryptObject(state.cryptoKey, content)` gives `{v:1, iv, data}` (AES-GCM through the vendored noble library), the row carries `JSON.stringify(payload)` as `ciphertext` and a hash of it as `content_hash`. | `wrapItem` (`store.js:1702`), `encryptObject` (`app/static/js/crypto.js:114`). |
| Every vault item type goes through the same `upsert` (`store.js:5792`): it stamps a version (`__fid`, `__fv`) through `NotesFreshness.stampForUpsert`, sets `updated_at`, marks the uuid dirty and calls `schedulePush`. Only `search_index` and `vault_head` are exempt from the version stamp. | `upsert` (`store.js:5792`), `shouldTrackType` (`app/static/js/freshness.js:195`). |
| Item types are told apart only after decryption, by `content.type`: `note`, `attachment`, `tag`, `folder`, `template`, `agenda_pack`, `totp`, `search_index`, `vault_head`. A reader filters `state.items` on its own type, e.g. `listTotpAccounts` (`store.js:5100`) filters on `type === 'totp'`. A type a reader does not filter on is ignored by it, so older clients keep contact items without showing or changing them. | `listTotpAccounts` (`store.js:5100`), `listNotes` (`store.js:5088`). |
| Push is `POST /api/sync/items`. The server answers per item with `ok`, `unchanged`, `stale`, `conflict`, `quota_exceeded`, `too_large` or `rejected`. A client that sends `base_rev` gets `conflict` when another device wrote since; the server never picks a winner by clock in that case. | `api_sync_push` (`app/app.py:4030`), `_plan_sync_item` (`app/db.py:2705`). |
| Limits: one item at most 75 MiB (`SYNC_MAX_ITEM_BYTES`, `app/db.py:2611`); one request body at most 80 MiB (`app.config["MAX_CONTENT_LENGTH"]`, `app/app.py:162`); the account quota counts ciphertext plus blob bytes of every live item (`_plan_sync_item`). Plan quotas are 50 MB, 100 MB and 5120 MB (`storage_quota_mb`, `app/plans.py:34,43,52`). | as listed. |
| The client resolves a `conflict` in `resolvePushConflict` (`store.js:3772`). Notes keep both texts (the loser becomes a "(conflict copy)" note, `keepConflictCopy`, `store.js:1539`). The agenda pack is merged event by event (`mergeAgendaPacks`). A tag's note order is merged per note. **Every other item kind falls through to the last two lines: the newer `updated_at` wins and the other copy is dropped** (`store.js:3860-3862`). | `resolvePushConflict`. |
| Every item is persisted in IndexedDB on write (`persistLocal`, `store.js:1367`), so a vault opens and edits offline. Dirty items are pushed later (`pushDirty`, `store.js:3865`; `pushDirtyPersisted` when the vault is locked). | as listed. |
| The sync log line on the server contains user id, counts, outcome counts and request bytes, never item content. | `api_sync_push` calls `_sync_log_line` (`app.py:4067`). |

### 1.3 How 2FA, the closest sibling, is built

2FA is the most recent "tab with its own list, search, add dialog and import"
and the model to follow.

| Piece | Checked against |
| --- | --- |
| Tab button and pane. The tab bar is `<nav class="app-tabs" role="tablist">` with `<button class="app-tab" id="app-tab-2fa" data-app-tab="2fa" role="tab" aria-selected aria-controls="totp-pane">`. Order today: Notes, Agenda, 2FA. The pane is `<section id="totp-pane" class="totp-pane" hidden>`. | `app/templates/app.html:766-770`, `:1664`. |
| Tab switching: `normalizeAppTab` accepts only `'2fa'`, `'agenda'`, everything else becomes `'notes'`; `setAppTab` hides the notes shell and the other panes, sets `root.dataset.appTab`, writes `sessionStorage['notes_app_tab']`, and calls the pane's refresh. `restoreAppTab` re-applies it on load. | `normalizeAppTab`, `setAppTab`, `restoreAppTab` (`app/static/js/app.js:4552`, `:4573`, `:4667`). |
| 2FA is gated by plan: `setAppTab` refuses `'2fa'` unless `planHas('vault_authenticator')`, a Pro feature. | `setAppTab` (`app.js:4575`), `planHas` (`app.js:726`), `FEATURE_CATALOG["vault_authenticator"]` (`app/plans.py:137`). |
| While locked the list is empty: `refreshTotpVault` clears its entries when `!NotesStore.isUnlocked()`. | `refreshTotpVault` (`app.js:4774`). |
| 2FA search is a pure function over its own list: `filteredTotpEntries` calls `NotesTotp.filterAccounts(entries, input.value, activeTag)`. The text and the active tag live in memory only. | `app.js:4969`, `app/static/js/totp.js`. |
| Tags are names stored inside each item; renaming one rewrites every item that carries it. | `renameTotpTag` (`store.js:5215`). |
| Import dialog: `role="dialog" aria-modal="true" aria-labelledby`, a hidden `<input type="file">` with class `sr-file`, preview list with a `role="status" aria-live="polite"` summary, then a confirm button. Dialog focus trap and focus return are generic (`app/static/js/dialog-a11y.js`, applies to every `[role=dialog][aria-modal=true]`). | `app/templates/app.html:2814-2867`, `dialog-a11y.js:1-20`. |

### 1.4 How the other imports and exports work

| Piece | Checked against |
| --- | --- |
| Notes imports (Evernote ENEX, Keep, Markdown, Standard Notes) parse in the browser into a plain object, show a `confirmAction` summary, then call `NotesStore.importMarkdownNotes(parsed)`, which throws `'Unlock the vault first'` without a key. Limits are constants at the top of each parser, e.g. 10 MiB and 10,000 notes for Markdown. | `app/static/js/md-import.js:16-21`, `enex-import.js:13-22`, `keep-import.js:14-17`, `importMarkdownNotes` (`store.js:7584`), `docs/IMPORT_EXPORT_SPEC.md` section 4. |
| The result text is built by `importResultToast` (`app.js:26147`). **There is no undo for any existing import.** Undo for contacts is new (section 7.6). | `importResultToast`. |
| 2FA import: `app/static/js/totp-import.js`, specified in `docs/2FA_IMPORT_SPEC.md` (preview, per-entry skip reasons, duplicates by secret). | `docs/2FA_IMPORT_SPEC.md` section 3. |
| Encrypted backup `.dgbackup`: `buildLocalBackup` iterates **all** live items of `NotesStore.state.items` and writes each one's ciphertext row. It does not filter by type. Contacts are therefore in the encrypted backup, and restored, with no change (section 3.6). | `buildLocalBackup` (`app.js:26284`), restore `NotesStore.importBackup` (`store.js:7660`). |
| Readable (unencrypted) ZIP export: warning text, then the vault password is typed again and checked in the browser by `NotesStore.verifyVaultPassword` (`store.js:6285`); wrong password exports nothing. Implemented as `confirmAction(message, {title, confirmLabel, danger:true, checkbox, verifyPassword, wrongPasswordMessage})`. Contacts export reuses this dialog unchanged (section 8). | `app.js:25300-25345`, `docs/IMPORT_EXPORT_SPEC.md` section 5. |
| The global search box says "Search notes and scanned documents" and searches notes only. | `<input id="search" ... aria-label="Search notes and scanned documents">` (`app.html:1071`), `app.js:11640`. |
| Content-Security-Policy of the app allows `img-src 'self' data: blob:`, so a re-encoded photo can be shown from a `blob:` URL without a CSP change. `connect-src` is `'self'` plus fixed third parties; none is used by contacts. | `app/auth.py:1145`. |

### 1.5 Seen in the running app

- At 1280x800 the tab bar is a row of pill buttons 32 px high (Notes 60 px,
  Agenda 72 px, 2FA 48 px wide). At 390x844 the three tabs fill the row, 44 px
  high, 120, 133 and 105 px wide (`.app-tab { flex: 1 1 0 }`,
  `app/static/css/app.css:189`; phone override `:9033`, `min-height: 44px`).
  **Four tabs leave (width - 24 - 12) / 4 px per tab: 88.5 px at 390 px, 81 px
  at 360 px, 71 px at 320 px.** Measured in the same Chromium with
  `canvas.measureText` at the tab's font (650 weight, 15 px, system font stack):
  "Contacts" is 64.2 px wide, "Agenda" 55.0 px. With the current 12 px side
  padding "Contacts" needs 88.2 px, which just fits at 390 px and does not fit at
  360 px or 320 px. Section 4.1 reduces the padding on phones. (The width of
  the real font on a phone differs from this headless fallback font, so the
  build task measures again on its own fonts.)
- The 2FA pane at 390 px: heading, a "+" button, "Import", then lock, settings
  and sidebar-toggle icon buttons, a search field, and an empty-state sentence
  in a dashed box. At 1280 px the same pane has a 64 px left rail with lock,
  settings and sidebar toggle, the heading top left and "+" / "Import" top
  right. Contacts copies this skeleton (section 4).
- A synthetic contact object of 417 bytes (name, one phone, one email, one
  address, 100-character note, `__fid`, `__fv`) encrypted with the real
  `NotesCrypto.encryptObject` in the running page gives a `ciphertext` string
  of **621 bytes**. The ratio (about 1.5x) comes from the base64 in `{v, iv,
  data}`. Section 3.4 and 7.8 derive limits from this.
- A canvas of worst-case photo content (sinusoid plus noise, so harder to
  compress than a real face) re-encoded by `canvas.toBlob`: JPEG q0.7 / q0.8 /
  WebP q0.8 at 96 px: 2,439 / 3,084 / 3,006 bytes; 128 px: 3,745 / 4,910 /
  4,952; 256 px: 12,491 / 17,242 / 17,752; 512 px: 47,544 / 66,355 / 68,494.
  These are bytes of the image before base64.

## 2. Data model

### 2.1 Decision: one vault item per contact, `type: 'contact'`

Rejected: one pack item holding all contacts (as `agenda_pack` does). A pack
means every edit re-encrypts and re-uploads the whole address book, and two
devices editing two different contacts would conflict on the pack. The agenda
needed a pack for its own reasons (recurrence expansion); contacts have none.
One item per contact gives the cheapest push (hundreds of bytes), conflicts
only when the same contact is edited twice, a trivial delete, and the existing
quota accounting.

Cost accepted: the server can count items. It cannot tell a contact from a
note (the type is inside the ciphertext), but a 3,000-contact import is a burst
of 3,000 small rows (section 9.5).

The item type is new. Older clients keep the row and ignore it (section 1.2,
type filtering), so no migration of existing data and no server change are
needed. **Server code does not change at all** for contacts.

### 2.2 Fields

All of this is inside the encrypted content. Text is stored as typed (NFC),
trimmed, control characters except newline in `note` removed. Every list entry
has an `id` (8 random base32 characters) that is stable across edits; it is
what the merge in 3.3 and the UI keys on.

```jsonc
{
  "type": "contact",
  "schema": 1,
  "uid": "urn:uuid:5b1c...",            // vCard UID; created if absent; written back on export
  "name": {
    "prefix": "Dr.", "given": "Eva", "additional": "Maria",
    "family": "Bakker", "suffix": "MSc",
    "formatted": "Dr. Eva Maria Bakker MSc",   // FN as given; see 2.3
    "phonetic_given": "", "phonetic_family": ""
  },
  "nickname": "Evie",
  "org": { "name": "Bakker Bouw B.V.", "unit": "Inkoop" },
  "title": "Inkoper",
  "phones":    [ { "id": "K3M9Q2TA", "type": "mobile", "label": "", "value": "+31 6 12345678", "pref": true } ],
  "emails":    [ { "id": "...", "type": "work", "label": "", "value": "eva@bakkerbouw.example", "pref": false } ],
  "addresses": [ { "id": "...", "type": "home", "label": "",
                   "street": "Keizersgracht 1", "extended": "", "po_box": "",
                   "city": "Amsterdam", "region": "NH", "postal": "1015 AA", "country": "Nederland",
                   "pref": false } ],
  "urls":      [ { "id": "...", "type": "work", "label": "", "value": "https://bakkerbouw.example" } ],
  "ims":       [ { "id": "...", "service": "xmpp", "label": "", "value": "eva@chat.example" } ],
  "dates":     [ { "id": "...", "type": "birthday", "label": "", "value": "1984-03-09" } ],
  "note": "Lunch 12 mei.\nBel na 17:00.",
  "photo": { "mime": "image/jpeg", "data": "<base64>", "w": 192, "h": 192 },   // or null
  "labels": ["Werk", "Bouw"],
  "favorite": false,
  "extra": { },                          // section 2.4
  "created_at": "2026-11-19T10:00:00.000Z",
  "updated_at": "2026-11-19T10:00:00.000Z",
  "fc": { "name": "2026-11-19T10:00:00.000Z" }   // per-field edit clocks, section 3.3
}
```

Rules per field, each with the reason:

| Field | Rule | Why |
| --- | --- | --- |
| `name.*` | Five structured parts as in vCard `N`, plus `formatted` (vCard `FN`). Each part at most 200 characters. | The names the owner asked for. Structure is needed to sort by family name and to write `N` back correctly. |
| `nickname` | One string. Several vCard nicknames (`NICKNAME:a,b`) become one string joined with `, `. | One nickname is what every UI offers; joining loses nothing. |
| `org` | `name` and one `unit`. Further org units (`ORG:Acme;Sales;EMEA`) are joined into `unit` with ` / `; the exact original is also kept in `extra` when it had more than one unit. | Two levels cover Outlook "Company"/"Department", Google "Organization Name"/"Department", LDAP `o`/`ou`. |
| `title` | String. vCard `ROLE` is kept in `extra`. | `TITLE` is what Outlook, Google and LDAP call "Job Title". |
| `phones`, `emails`, `addresses`, `urls`, `ims` | Arrays, each at most 50 entries. Entry `type` is one of `home`, `work`, `mobile`, `main`, `fax`, `pager`, `other`, `custom`. `custom` uses `label` (at most 60 characters) as free text. `pref` is `true` on at most one entry per list (the vCard `PREF`/`TYPE=pref` entry). Phone `value` is kept as typed (spaces, brackets), because `tel:` normalises it on use and an import must not reformat a number. | Multiple values with a type label, as asked. Apple, Google and Outlook allow custom labels. |
| `addresses.*` | Seven vCard `ADR` components (`po_box`, `extended`, `street`, `city`, `region`, `postal`, `country`). A free-form formatted address (Google "Address 1 - Formatted", vCard 4.0 `LABEL` parameter) with no parts is put in `street`. | Lossless for vCard; structured for sorting and display. |
| `ims` | `service` is a lower-case slug (`xmpp`, `skype`, `signal`, `whatsapp`, `matrix`, `telegram`, `aim`, `icq`, `jabber`, `twitter`, `other`). | Imports carry the service as `X-AIM`, `IMPP:xmpp:`, `X-SOCIALPROFILE`, Thunderbird "Screen Name". |
| `dates` | `type` is `birthday`, `anniversary` or `other` (with `label`). `value` is `YYYY-MM-DD`, `--MM-DD` (no year) or `YYYY`. Time and zone parts of a vCard date-time are dropped and not kept. At most one `birthday`. | The two dates every program has, plus Apple/Google "other" dates. A year-less birthday is common (Apple uses year 1604 or `X-APPLE-OMIT-YEAR`, section 6.1.5). |
| `note` | At most 20,000 characters. Plain text only. | Notes are text; HTML in it is shown as text (section 9). |
| `photo` | One image, re-encoded in the browser (section 3.4). `null` when absent. A `PHOTO` given as a URL is **not fetched** (section 9); the URL is kept in `extra` and written back unchanged on export. | Offline and no-network rules. |
| `labels` | Group names, at most 20 per contact, each at most 40 characters, de-duplicated case-insensitively. Stored as names inside the contact, not as separate items. | Same as 2FA tags (`renameTotpTag`, `store.js:5215`): no group item to conflict, orphan or leak into a shared index. Cost: renaming a group rewrites its members (section 4.6). Considered: separate `contact_group` items holding ids, as notes do with `tag` items. Rejected for v1 because a deleted or concurrently renamed group item creates orphan ids, and the import of 10,000 contacts would also have to create and de-duplicate group items first. |
| `favorite` | Boolean. | Favourites as asked; a filter and a pinned section. |
| `uid` | See 3.5. | vCard `UID` is how other programs recognise a contact on re-import. |
| `created_at`, `updated_at` | ISO strings as every other item (`upsert` sets `updated_at`, `store.js:5792`). `REV` from a file is kept in `extra` and is not used as `updated_at`. | A file's `REV` is another program's clock. |
| `fc` | Map from top-level field name to the ISO time of its last local edit. | Field-level merge (3.3). |

Total plaintext of one contact is capped at **128 KiB** (the photo and `extra`
included). A contact over the cap on import is refused with a reason; in the
edit form the photo is dropped last, `extra` first, and the user is told.

### 2.3 Display name

The name shown in the list is, in this order: `formatted` when non-empty and
the structured parts are all empty; otherwise the parts joined by the
"display order" preference (`given family`, default, or `family, given`); then
`org.name`; then the first email; then the first phone; then "No name". The
sort key uses the same order. `formatted` is kept untouched so that export
writes back what was imported; if the user edits any structured part,
`formatted` is cleared and regenerated on export.

### 2.4 Unknown imported fields: `extra`

Goal: import then export loses nothing a program put in the file, even what
Deeperguard has no field for.

```jsonc
"extra": {
  "source": { "format": "vcard", "version": "3.0", "flavour": "apple", "imported_at": "...", "batch": "b-20261119-1" },
  "vcard": [
    { "g": "item5", "n": "X-ABRELATEDNAMES", "p": { }, "v": "Jan Visser" },
    { "g": "item5", "n": "X-ABLabel", "p": { }, "v": "_$!<Spouse>!$_" },
    { "g": "",      "n": "X-SOCIALPROFILE", "p": { "type": ["twitter"], "x-user": ["sannev"] }, "v": "http://twitter.com/sannev" }
  ],
  "csv":  { "Custom 1": "Gold member", "Hobby": "sailing" },
  "ldif": { "mozillaCustom2": "x", "xmozillausehtmlmail": "FALSE" }
}
```

Rules:

- `vcard` is an ordered array of `{g, n, p, v}` (group, property name, parameter
  map with array values, raw value string). It holds every property that was
  not mapped to a field, and also parts of mapped properties that have no
  place (for example the `LABEL` parameter of an `ADR`, a second org unit).
  Names are upper-cased on read and written back upper-case; the original
  value text is kept, including backslash escapes.
- `csv` maps the original column header to the cell text, for every column that
  was not mapped and is non-empty. `ldif` likewise by attribute name (with a
  list of values when the attribute repeats).
- Caps: `extra` is at most 32 KiB serialised, at most 200 `vcard` entries, a
  value at most 4,096 characters. Over the cap, the surplus is counted in the
  import result as "kept N, dropped M fields" so the loss is visible and never
  silent.
- `extra.source` records where the contact came from, for the result summary and
  the undo (7.6). It is informational and not used for matching.
- `extra` is shown in the edit form only as a read-only "Other imported fields
  (N)" disclosure, as text, never as HTML. It is written back by the vCard
  export (8.1). The CSV export writes it only when the export is
  "Deeperguard-complete" (8.3).
- Keys of `extra.csv` and `extra.ldif` and every `p` map are set on objects
  created with `Object.create(null)` or via `Map` during parse, and keys named
  `__proto__`, `constructor` and `prototype` are dropped (section 9.4).

### 2.5 What the model deliberately does not have

`KIND:group` cards with `MEMBER` (vCard 4.0 groups), `RELATED`, `GENDER`,
`LANG`, `TZ`, `GEO`, `KEY`, `SOUND`, `LOGO`, `CALURI`, `FBURL`, `CATEGORIES`
beyond group names, and Apple's `X-ABRELATEDNAMES` have no first-class field.
They are kept in `extra` and exported again; the UI shows them only in the
read-only disclosure. `CATEGORIES` becomes `labels` (that is what Apple,
Google and Thunderbird mean by it). A `KIND:group` card is not a person: it is
turned into a label on its members when it has `MEMBER:urn:uuid:` entries that
match an imported `UID` in the same file, otherwise it is skipped and listed as
"group card, not a contact" in the summary. `KIND:org` and `KIND:location` are
imported as a contact with only `org.name` / `name.formatted`.

## 3. Storage, encryption and sync

### 3.1 Write path

A contact is written with `NotesStore.upsert(uuid, content)` like every other
item (`store.js:5792`), through new store functions that mirror the 2FA ones
(`addTotpAccount`, `updateTotpAccount`, `removeTotpAccount`,
`store.js:5166-5228`): `listContacts`, `addContact`, `updateContact`,
`removeContact`, `importContacts`, `restoreContacts` (undo). They live in
`store.js` next to the 2FA functions and are exported in the same object
(`store.js:7896`). Nothing new is needed in the server, in `wrapItem`, in the
sync log or in the backup.

On the wire a contact is `{item_uuid, content_version:1, ciphertext:
'{"v":1,"iv":..,"data":..}', content_hash, deleted, updated_at, base_rev}`.
The server sees the uuid, the ciphertext size (about 1.5x the JSON, plus 24 for
framing), the hash of the ciphertext, the deleted flag and the time. It does
not see that the item is a contact (section 9.5).

### 3.2 Offline and locked vault

- Offline: `persistLocal` (`store.js:1367`) saves the encrypted row to
  IndexedDB on every write, so create, edit, delete and import all work without
  a connection; the dirty set is pushed when the connection returns
  (`pushDirty`). The Contacts tab shows the same offline banner as the other
  tabs and adds no network dependency of its own. The new JS files are added to
  the client manifest and the service-worker precache like `totp-import.js`
  (`app/static/sw.js` `PRECACHE`, `scripts/build-client-manifest.py`), so the
  tab opens offline.
- Locked vault: the list is empty and Add/Import/Export are disabled, as for
  2FA (`refreshTotpVault` clears its entries when `!NotesStore.isUnlocked()`,
  `app.js:4776`). `importContacts` throws `'Unlock the vault first'` like
  `importMarkdownNotes` (`store.js:7585`). Typing into the search box while
  locked does nothing. After unlock the list renders from `state.items`.
- Search text, the open contact, the active group filter and the scroll
  position live in memory only, as 2FA's (`totpActiveTag` comment, `app.js:4544`). Not in `localStorage`, not in the URL, not in IndexedDB.
  `sessionStorage['notes_app_tab']` stores only the tab name `contacts`.

### 3.3 Conflicts between devices

Today a contact would fall into the last branch of `resolvePushConflict`
(`store.js:3860-3862`): the newer `updated_at` wins and the other device's
edit is silently dropped. For an address book that is not acceptable (phone
edits the number, laptop edits the address at the same time: one change lost).

Decision: add a `contact` branch to `resolvePushConflict`, next to the
`agenda_pack` branch, with a **field-level merge** and a conflict copy only
when two devices changed the same field differently.

1. Every edit sets `fc[field] = now` for each top-level field it changed
   (`name`, `nickname`, `org`, `title`, `phones`, `emails`, `addresses`,
   `urls`, `ims`, `dates`, `note`, `photo`, `labels`, `favorite`). `fc` is
   inside the ciphertext, so the server cannot see which field changed.
2. On `conflict` the client has `local` and the server's decrypted `remote`
   (`unwrapItem`, as the existing branches). For each field: when only one side
   has a newer `fc[field]` than the other's `fc` entry or when the values are
   equal, take the newer; this is the case in the common "phone edits the
   number, laptop edits the address" conflict and needs no user action.
3. A **list field** (`phones`, `emails`, ...) is merged by entry `id`: entries
   present on one side only are kept (an addition is never lost), entries on
   both sides take the side with the newer entry content only if that side's
   `fc[field]` is newer; an entry removed on one side and untouched on the
   other is removed (the removing side is the one whose `fc[field]` is
   newer and which lacks the id, and the other side's copy of that entry is
   byte-equal to the common earlier version it can still see in `remote`/
   `local`; when that cannot be shown, the entry is kept: **a conflict never
   deletes data**).
4. If both sides changed the **same scalar field** to different values after
   the same earlier state (equal `fc` bucket cannot be told apart; the
   merge uses "both `fc` newer than the other side's last seen `fc`" which the
   push knows because the pulled copy is the base), the newer wins and the
   contact of the other side is saved as a new contact named
   `<display name> (conflict copy)` with `conflict_of`, `conflict_source`,
   `conflict_at`, exactly the fields `keepConflictCopy` sets on notes
   (`store.js:1555-1557`). The copy is a normal contact the user can merge or
   delete; it is found by the tab's own search and in the list next to the
   original. This reuses the suffix constant `NotesConflictCopy.SUFFIX`
   (`CONFLICT_SUFFIX`, `store.js:1505-1507`).
5. A deletion on one device and an edit on the other: the edit wins (the
   existing rule, `conflict-edit-beats-delete`, `store.js:3808`).
6. After the merge the result is re-pushed on top of the server revision with
   the same `winLocal` path the other branches use, so `__fv` is bumped above
   the server copy and the cached ciphertext is dropped.

The merge function is pure (`NotesContacts.mergeContacts(local, remote)`) and
unit-tested without a browser (test 3-3).

**As built (data layer task), deviations from the text above:**

- Step 4 needs to know whether both devices edited a field from the same
  earlier state. The model therefore also keeps `fb[field]`: the value `fc[field]`
  had before the edit. A scalar conflict (and a conflict copy) exists only when
  both sides changed the field and both `fb` values are equal; if one side's
  `fb` equals the other side's `fc`, that side edited after seeing the other and
  simply wins. `fb` is inside the ciphertext like `fc`.
- `favorite` never produces a conflict copy (the newer value wins).
- The copy is the merged contact with the losing values put back; its structured
  name parts are folded into `formatted` plus the ` (conflict copy)` suffix.
- Removing a list entry on one device is not carried over when the other device
  also changed that list in the same conflict: the entry is kept (a conflict
  never deletes data), as the text allows when the removal cannot be proved.
- Not built yet in this task: importers, import/export dialogs and the tab.
  `contacts.js` has `encodePhoto` (3.4, 9.3) but nothing calls it yet.

### 3.4 The photo

- **Source**: a file picker or camera (`<input type="file" accept="image/*">`,
  not `capture`), or the `PHOTO` of an imported card.
- **Re-encode in the browser, always**, also when the imported photo is already
  small: decode with `createImageBitmap(blob, {imageOrientation:
  'from-image'})`, centre-crop to a square, scale to **192 x 192 px**, draw on
  a canvas and write `canvas.toBlob('image/jpeg', q)`. Starting at q = 0.78,
  lower to 0.65 and then 0.5 until the JPEG is at most **12 KiB** (12,288
  bytes); if q = 0.5 is still too big the side is lowered to 144 px once; if
  that is still too big the photo is dropped and the import summary says
  "photo too complex" for that contact. Output is always JPEG (a canvas with a
  white background first, so transparency becomes white). Metadata (EXIF, GPS,
  ICC, embedded thumbnails) is gone because it is never copied: only pixels are
  drawn. This also removes any non-image payload hidden in the original.
- **Size derived from measurement** (section 1.5): worst-case content at 128 px
  is 3.7-4.9 KB and at 256 px 12.5-17.2 KB; 192 px lies between (about
  8-11 KB). The 12 KiB cap leaves a margin over the measured worst case.
  Stored in the contact the photo costs 12,288 x 4/3 (JSON base64) x 4/3
  (ciphertext base64) = **at most 21.9 KB** on the server. A real face
  photograph is smaller than the test content; the build task re-measures with
  at least five real portrait fixtures and may lower the cap, not raise it.
- **Where it is stored**: inline in the contact (`photo.data`), not as an
  attachment item and not in the blob column. One ciphertext means the photo is
  written, synced, merged, backed up and deleted atomically with its contact,
  and the list can show avatars with no second lookup. Rejected: an
  `attachment` item per photo (a second item and a second conflict per
  contact; attachments are for user documents with their own OCR and
  preview pipeline, `store.js:5935`).
- **Memory**: the list shows initials; avatars are decoded lazily for rows that
  are on screen, through `blob:` URLs created from the base64 and revoked when
  the row leaves the screen (`img-src ... blob:` is allowed, `auth.py:1145`).
- **Expansion limits before decoding**: see 9.3.

### 3.5 Identity and re-import

`uid` is the vCard `UID` of the file or a new `urn:uuid:` (generated with the
same random source as `newUuid`, `store.js:1044`). It is kept on edit and
written back on export. Duplicate detection (7.4) can use it as a strong
signal when the same file is imported twice (same `UID` and same source
`PRODID`), but a `UID` alone never causes a silent overwrite: it only selects
the default choice in the duplicate step.

### 3.6 Backup and export interplay

- **Encrypted backup** (`.dgbackup`) and its restore take every live item
  regardless of type (`buildLocalBackup`, `app.js:26284`), so contacts are
  included with no change. Test 3-6 restores a backup that contains
  contacts and compares them field by field.
- **pCloud / WebDAV / Dropbox backups** use the same `buildLocalBackup` output
  (`docs/MANAGED_PCLOUD_BACKUP.md`, `docs/WEBDAV_BACKUP_DESIGN.md`); nothing to
  add. Settings text that lists "what is in a backup" must add "contacts".
- **Readable export (ZIP)**: contacts are **not** added to it in v1. That ZIP
  is notes, attachments, agenda and optionally 2FA, with its own layout
  (`docs/IMPORT_EXPORT_SPEC.md` section 2) and its own password step. Contacts
  have their own export (section 8) with the same password step. One
  password-protected action per kind of data keeps each warning specific.
  Adding a `contacts/contacts.vcf` file to the ZIP later is a one-function
  change (the vCard writer of 8.1 is reused); it is listed as follow-up, not
  built.
- Deleting a contact marks the item deleted (`remove`, `store.js:6647`), the
  server keeps the tombstone as for notes (`docs/DELETE_SPEC.md`).

## 4. UI

New files: `app/static/js/contacts.js` (pure model, name/sort/search helpers,
merge), `contacts-import.js` (parsers), `contacts-export.js` (writers),
`contacts-ui.js` is **not** a new file: UI code goes into `app.js` beside the
2FA UI like the other tabs, with markup in `app.html` and styles in `app.css`.
Parsers and writers are pure modules with no DOM, so they can be tested in
node, as `totp.js` and `md-import.js` are.

### 4.1 Navigation

- New tab button between Agenda and 2FA: `<button class="app-tab"
  id="app-tab-contacts" data-app-tab="contacts" role="tab" aria-selected="false"
  aria-controls="contacts-pane">Contacts</button>`, and the new
  `<section id="contacts-pane" class="contacts-pane" hidden>`. Final order:
  Notes, Agenda, **Contacts**, 2FA (`app.html:766-770`).
- `normalizeAppTab` (`app.js:4552`) accepts `'contacts'`; `setAppTab`
  (`app.js:4573`) hides the shell and the other panes when the tab is
  Contacts, calls `refreshContacts()` and `stopTotpClock()`; `restoreAppTab`
  keeps working through `normalizeAppTab`.
- **Plan**: Contacts is available on all plans (no `FEATURE_CATALOG` entry, no
  `planHas` check). Reason: it is local data with the same storage cost as
  notes, there is no server-side cost, and the quota already bounds it. (2FA is
  Pro by an explicit product decision, `plans.py:137`; contacts are not.)
- **Phone width**: four tabs share the row (88.5 px each at 390 px, 81 px at
  360 px, 71 px at 320 px, section 1.5). At `max-width: 480px` the tab
  padding becomes `10px 6px` (needs 76.2 px for "Contacts": fits 390 and 360);
  below 340 px the tab font becomes 14 px and the padding `10px 4px`
  (about 68 px: fits 320). `overflow: hidden; text-overflow: ellipsis` is
  **not** used (a clipped tab name is a bug). The 44 px minimum tap height
  stays (`app.css:9033`). Test 4-2 checks 390, 360 and 320 px.
- Keyboard and screen reader: tab buttons stay real buttons with
  `role="tab"`, `aria-selected`, `aria-controls` that point at an existing
  element (`contacts-pane`). Exactly one tab has `aria-selected="true"`.

### 4.2 Pane skeleton

Copies the 2FA pane (`app.html:1664-1714`): header with title "Contacts" and a
count line ("128 contacts"), buttons **+** (`aria-label="Add contact"`),
**Import**, **Export**, the same three side icons (lock, settings, nav toggle),
a search field, the list, an empty state. Search field:
`<input id="contacts-search" type="search" aria-label="Search contacts (press
/ to focus, label:name to filter)" aria-keyshortcuts="/"
aria-controls="contacts-list">`.

### 4.3 List

- One row per contact: avatar (photo, else a circle with initials on a colour
  derived from a hash of `uid`, never from network), display name, second line
  = organisation or first phone/email, a star button for favourite.
- **Sorted** by family name then given name (collator
  `Intl.Collator(undefined, {sensitivity:'base', numeric:true})`), or by given
  name, per the display-order preference (2.3).
- **Alphabet grouping**: a sticky section header per initial. The initial is the
  first letter of the sort key with accents removed (`NFD` and strip `\p{M}`),
  upper-cased; anything that is not a letter goes to `#`. A "Favourites"
  section is first when there are favourites and no search text.
- **Jump by letter**: on screens at least 768 px wide a vertical letter rail
  at the right edge (buttons, `aria-label="Jump to B"`, visible focus). Below
  768 px a rail of 20 px wide letters is not a usable tap target, so there is
  a "Jump to letter" button beside the search field that opens a small dialog
  with a grid of 44 px buttons for the letters that exist (this is also the
  screen-reader and keyboard route). Type-ahead: typing a letter while the list
  has focus moves to the first contact of that letter.
- **Size**: the list is windowed (fixed row height 56 px, render the visible rows
  plus 10 above and below) so 10,000 contacts scroll smoothly; section
  headers are laid out from a precomputed offset table. The windowed list
  keeps `role="list"` with `aria-setsize`/`aria-posinset` on rows so a screen
  reader still announces "12 of 3,000".
- Row activation: Enter or click opens the detail. The star toggles
  `favorite` with `aria-pressed` and `aria-label="Favourite: Eva Bakker"`.
- Empty states (each a `role="status"` paragraph in a dashed box like 2FA's):
  no contacts ("No contacts yet. Add one with + or import a file from another
  program."), no result for the search ("No contacts match 'xyz'"), a label with
  no members, locked vault ("Unlock the vault to see your contacts").
- Selection mode (long-press on phone, checkbox column on desktop) for bulk
  delete, bulk label, bulk export. A bulk delete is a `confirmAction` and has
  the toast undo (`toastWithUndo`, `app.js:4436`).

### 4.4 Detail

- **Desktop at 900 px and wider**: two panes, list 340 px and detail beside it.
  The selected row has `aria-current="true"`.
- **Phone**: the detail replaces the list (full screen) with a Back button at
  the top left (`aria-label="Back to contacts"`), the same pattern as
  `.shell.editor-open` in the notes (`app.css:8520`). The browser Back key
  and Escape also go back.
- Content in this order: large avatar, display name, nickname, "title at
  organisation"; a row of action buttons (Call, Message email, Copy) for the
  primary number and address; then groups: Phone, Email, Address, Website,
  Messaging, Dates (birthday with age or "turns 40 on ..."), Labels, Notes,
  Other imported fields (collapsed).
- **Actions on a value** (a button on each row, 44 px tall):
  - phone: **Call** = `<a href="tel:+31612345678">`. The href is built from the
    value with everything except `+`, digits, `*` and `#` removed (extensions
    like `ext. 12` are not dialled; the shown text is unchanged). If nothing
    is left, no link is offered. The click is handled by the operating system.
  - email: **Write** = `<a href="mailto:...">`, only if the value matches a
    conservative `local@domain` pattern, with the address percent-encoded.
  - address, phone, email, URL: **Copy**: `navigator.clipboard.writeText`,
    through the existing helper in `app/static/js/clipboard-sensitive.js:62`
    where it applies; a toast "Copied". The clipboard is the user's own.
  - URL: shown as an `<a href rel="noopener noreferrer" target="_blank">` only
    when the scheme is `http` or `https` (the same whitelist the app uses for
    links in notes, `app.js:1849`); any other scheme is shown as plain text. A
    tap leaves the app on the user's explicit action; the app itself calls
    nothing.
  - **Not offered**: maps, directions, "search the web", "find on LinkedIn",
    avatar look-up, reverse phone look-up, WhatsApp/Signal deep links. Every one
    of those would send contact data to a third party.
- All values are inserted with `textContent` / attribute setters, never
  `innerHTML` (section 9.2).

### 4.5 Edit form

- Opens from "+" (new) and from an Edit button on the detail. On desktop the
  form takes the detail pane; on phone it is a full screen with Cancel and
  Save in a sticky bar. Not a modal dialog, so the generic dialog trap does not
  apply; focus moves to the first field on open and back to the opener on close.
- Sections: Photo (Choose, Remove), Name (given, family always visible; prefix,
  additional, suffix, nickname, phonetic behind "More name fields"), Organisation and
  title, then repeatable rows for phone/email/address/website/messaging/date:
  each row has a type `<select>` (with "Custom..." that reveals a label input),
  the value input and a Remove button (`aria-label="Remove phone 2"`), and an
  "Add phone" button after the last row. Then Labels (chips with an input and
  suggestions from existing labels, as the 2FA tag chips), Notes, Favourite
  checkbox.
- Input types: `type="tel"`, `type="email"`, `type="url"`, `inputmode`,
  `autocomplete="off"`, `autocapitalize` appropriate. The browser's autofill is
  switched off because these are other people's data.
- Every input has a visible `<label>` or `aria-label`. Errors are in a
  `role="alert"` paragraph and the invalid field gets `aria-invalid="true"` and
  `aria-describedby`. A contact needs at least one of: a name part, an
  organisation, an email, a phone; otherwise Save is refused with that sentence.
- Unsaved changes: Back, Escape or tab switch with changes asks with
  `confirmAction` ("Discard changes?"). Save writes with `updateContact` and
  closes; the same Save pressed twice quickly writes once (the button is
  disabled while saving).
- Delete: button at the bottom of the detail, `confirmAction`, then a toast
  with Undo (`toastWithUndo`).

### 4.6 Groups (labels) and favourites

- A label chip bar above the list (`role="group" aria-label="Filter by
  label"`) shows All, Favourites and each label with its count; one active at
  a time; the active label combines with the search text (AND). `label:Werk`
  typed in the search box does the same, as `tag:name` does in 2FA.
- Rename and delete a label from a menu on the chip: rename rewrites each
  member contact (`renameContactLabel`, modelled on `renameTotpTag`,
  `store.js:5215`); delete removes the name from members and never deletes a
  contact (the confirm says how many contacts lose the label).
- Favourites: the star. "Favourites" filter and the first list section.

### 4.7 Themes, motion, focus

Light and dark use the existing CSS variables (`--bg`, `--text`, `--muted`,
`--accent`, `--accent-soft`, `--border`); no colour literal is added for text.
Avatars colours are checked for 4.5:1 contrast of the initials in both themes
(test 4-11). Every interactive element has the app's visible `:focus-visible`
ring. Animations respect `prefers-reduced-motion`.

### 4.8 Screen reader behaviour

- The list is `role="list"` of `role="listitem"` rows; section headers are
  `<h3>`. The result count of a search or filter is announced through the
  existing live-region pattern (`role="status" aria-live="polite"`), e.g.
  "3 contacts found".
- Detail: the contact name is the pane's `<h2>`; each group is a `<section>`
  with a heading; action buttons have names that include the value type and the
  person ("Call Eva Bakker, mobile").
- Photo `<img>` has `alt=""` (decorative, the name is next to it). The initial
  avatar is `aria-hidden`.
- Letter rail: `aria-hidden="true"` is **not** used (it must be reachable);
  it is a `<nav aria-label="Jump to letter">`.

## 5. Search

### 5.1 The tab's own search

`NotesContacts.filterContacts(list, text, activeLabel, favouritesOnly)` is a
pure function in `contacts.js`, called by the pane as `filteredTotpEntries`
is for 2FA (`app.js:4969`). It runs on the in-memory decrypted list on every
input event (10,000 contacts is a few ms of substring work, measured in the
build task's benchmark 5-4).

- Text is lower-cased, NFD-normalised with combining marks removed, so
  `jose` finds `José` and `muller` finds `Müller`.
- Split by whitespace; **every** word must match (AND), in any field, so
  `eva bakker` and `bakker eva` both work.
- Fields searched: all name parts, `formatted`, nickname, organisation name and
  unit, title, every phone, every email, every address part, every URL, every
  IM value, every date value, the note, the labels, and the values of
  `extra.vcard` entries named `X-ABRELATEDNAMES` only (other unknown fields are
  not searched).
- Phones also match on digits: the query `0612` finds `+31 6 12 34 56 78`
  because both sides are reduced to digits for a digit-only query of 3 or more
  digits. A leading `00` or `+` is ignored.
- `label:name` restricts to a label (case-insensitive); `is:favorite` to
  favourites.
- No fuzzy matching, no ranking beyond: contacts whose display name starts with
  the query first, then the rest in sort order.
- The query is never stored, logged, sent or put in a URL.

### 5.2 Global search: contacts are **not** included

The global search box (`#search`) is `aria-label="Search notes and scanned
documents"` (`app.html:1071`) and is part of the Notes shell, which is hidden
on every other tab (`setAppTab`: `ui.shell.hidden = on2fa || onAgenda`,
`app.js:4584`). It runs `NotesSearch` over notes (`app.js:11640`) and a
synced OCR `search_index` item. Decision: contacts stay out of it, because

1. a contact is not a note and results from two kinds of item in one list
   would need a second row layout and a way to open a contact from the Notes
   shell;
2. the OCR index is a **synced** item (`type: 'search_index'`, merged in
   `resolvePushConflict`, `store.js:3845`); contacts must never be added to it
   (it would put names into a second long-lived item and grow every push);
3. agenda and 2FA are not in it either, so "search within the tab you are in"
   is the rule the app already follows.

A user who wants a contact looks in the Contacts tab. The Notes search
placeholder is not changed. If the owner later wants cross-tab search, it is a
separate in-memory index that is never synced (listed as follow-up).

## 6. Import formats

All parsers are pure functions of bytes (or text) to a plain result
`{contacts: [...], skipped: [{index, reason}], warnings: [...], stats}` and never touch the DOM, the
network or the store. The store step is section 7.

**About the samples.** Every sample below was constructed for this document
from the documented format of each program; none was captured from a live
account (this environment has no accounts and no network). They follow the
patterns those programs are known to write, and the notes next to each say
which parts are the awkward ones. Where I am less sure that a program really
writes a given detail, the table in 6.7 says "unverified". The build task adds
the samples as test fixtures **and** must replace or supplement them with a
real export from each program as soon as the owner can supply one. The three
checks that were run on the samples here: the PNG in the vCard samples is a
valid 1x1 PNG (signature and all three chunk CRCs verified), the quoted-
printable and base64 values decode to the text the notes claim, and each CSV
row has as many fields as its header (done with a throw-away script outside
the repo).

### 6.0 Reading the bytes (all text formats)

1. **Size first.** `file.size` is checked against the limit (7.8) before
   `file.arrayBuffer()`.
2. **Encoding of the whole file**, in this order: BOM `EF BB BF` (UTF-8),
   `FF FE` (UTF-16 LE), `FE FF` (UTF-16 BE), strip it; otherwise, if the bytes
   contain NUL in every second position, UTF-16 without BOM; otherwise decode
   with `new TextDecoder('utf-8', {fatal: true})`; if that throws, decode as
   `windows-1252` (a superset of ISO-8859-1 for the printable range, which is
   what Outlook, old Thunderbird and Excel write). The preview shows the
   detected encoding and a "Wrong characters?" select with `windows-1252`,
   `iso-8859-15`, `iso-8859-2`, `utf-8`, `utf-16le`, `shift_jis`, `gbk`,
   `big5`, `euc-kr`, `koi8-r`; choosing one re-parses (every label is a
   `TextDecoder` label the browser supports; an unsupported one is not
   offered).
3. **Per-property charsets in vCard** (`CHARSET=ISO-8859-1` on a property)
   override the file encoding for that value after quoted-printable
   decoding (6.1.2).
4. NUL bytes, other C0 control characters (except tab, CR, LF) and lone
   surrogates are removed from every value after decoding.

### 6.1 vCard (`.vcf`, `.vcard`): 2.1, 3.0 and 4.0

One reader handles all three versions; the `VERSION` line only selects
defaults. A file with no `VERSION` is read as 3.0. A file may hold many cards.

#### 6.1.1 The reader, in order

1. **Line splitting** on CRLF, LF or lone CR.
2. **Quoted-printable soft breaks first.** A property line whose parameters
   contain `ENCODING=QUOTED-PRINTABLE` (or the bare `QUOTED-PRINTABLE`) and
   which ends in `=` continues on the next physical line **even when that line
   does not start with a space** (Outlook and old Android write 2.1 like this).
   The `=` and line break are removed.
3. **Unfolding**: a physical line that starts with a space or a tab continues
   the previous line (the single leading whitespace character is removed).
   This is the folding of 2.1 (tab or space), 3.0 and 4.0 (single space).
   A base64 `PHOTO` of 2.1 ends at the first empty line; 3.0/4.0 end it at the
   first line that is not folded.
4. **Property**: `[group.]NAME[;param[=value[,value]]...]:value`. Names and
   parameter names are case-insensitive. A parameter without `=` is a 2.1 bare
   type (`TEL;CELL;PREF`, `PHOTO;JPEG`) and means `TYPE=...`. Parameter values may
   be quoted (`TYPE="cell,voice"`). The first `:` outside a quoted parameter
   value starts the value.
5. **Value decoding**: `ENCODING=QUOTED-PRINTABLE`: bytes from `=XX`, then decoded
   with `CHARSET` (default: file encoding); `ENCODING=b`, `BASE64` or `B`:
   base64 (whitespace ignored). Otherwise text; in 3.0/4.0 the escapes `\n`, `\N`
   `\,` `\;` `\\` are undone, in 2.1 `\;` and `\\` are undone and a literal `\n`
   is left.
6. **Structured values** (`N`, `ADR`, `ORG`, `CATEGORIES`, `NICKNAME`) are
   split on unescaped `;` (and `,` for lists) *before* unescaping.
7. **Cards**: `BEGIN:VCARD` ... `END:VCARD`, case-insensitive. A nested
   `BEGIN:VCARD` inside a card (2.1 `AGENT`) is skipped. A card that never
   ends before the next `BEGIN:VCARD` or the end of the file is salvaged and
   counted as a warning "card N was not closed".
8. **Mapping** to the model (table 6.1.2). Everything not mapped goes to
   `extra.vcard` as `{g, n, p, v}` with the *decoded* value (section 2.4).
9. **Group prefixes** (`item1.TEL`): the group name only links properties.
   `item1.X-ABLabel` (Apple, Google) gives the label of every property in group
   `item1`; the label `_$!<Mobile>!$_` is the Apple built-in `Mobile`; any
   other text is a custom label. The group name itself is not kept except in
   `extra.vcard` for unmapped properties.

#### 6.1.2 Mapping table

| vCard | Model | Details |
| --- | --- | --- |
| `N` | `name.family; given; additional; prefix; suffix` | Five components in that order. Missing components are empty. Commas in a component (several given names) are joined with a space. |
| `FN` | `name.formatted` | If there is no `N`, the parts are guessed from `FN` only when it has exactly two words ("Given Family"); otherwise `formatted` alone is kept and the display name uses it. With no `FN` at all, `formatted` is built the way the exporter builds `FN` (name parts, else organisation, first email, first phone), so that import, export, import is stable. |
| `NICKNAME` | `nickname` | |
| `ORG`, `TITLE` | `org.name`, `org.unit`, `title` | `ROLE` goes to `extra`. |
| `TEL` | `phones[]` | `TYPE` words: `cell`, `iphone`, `mobile`, `x-mobile` give `mobile`; `home`; `work`; `fax`, `homefax`, `workfax` give `fax`; `pager`; `main`; `voice`, `text`, `msg`, `video` are ignored; `pref` sets `pref`. In 4.0 the value `tel:+31-6-1234` has its `tel:` removed and `;ext=` kept as text. An unknown type word becomes `custom` with the word as `label`. |
| `EMAIL` | `emails[]` | `TYPE`: `home`, `work`, `internet` (ignored), `pref`. A 3.0 `TYPE=INTERNET;TYPE=HOME` is two `TYPE` parameters; they are merged. |
| `ADR` | `addresses[]` | Seven components: PO box, extended, street, city (locality), region, postal code, country, in that order. Outlook also writes a `LABEL` line with the same type: it is not a second address, it goes to `extra.vcard`. A 4.0 `LABEL=` parameter on `ADR` is used for `street` only if all components are empty, otherwise it is dropped. |
| `URL` | `urls[]` | `TYPE` as for phones. |
| `IMPP`, `X-AIM`, `X-ICQ`, `X-JABBER`, `X-SKYPE`, `X-MSN`, `X-YAHOO`, `X-GOOGLE-TALK`, `X-GADUGADU`, `X-SOCIALPROFILE` | `ims[]` | `IMPP:xmpp:a@b` gives service `xmpp`, value `a@b` (scheme stripped). `X-SOCIALPROFILE;type=twitter;x-user=sannev:http://twitter.com/sannev` gives service `twitter`, value `sannev`; the URL is kept in `extra`. |
| `BDAY` | `dates[]` birthday | Accepted: `1984-03-09`, `19840309`, `--0309`, `--03-09`, `1984-03-09T10:00:00Z` (time dropped; the dropped time is not kept), `1984`. Apple writes an unknown year as `1604` (`BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-09`): year 1604 or the parameter means "no year" and the value becomes `--03-09`. An impossible date (`1984-13-40`) is kept as text in `extra` and the contact gets a warning. |
| `ANNIVERSARY`, `item.X-ABDATE` + label | `dates[]` | `X-ABDATE` label `_$!<Anniversary>!$_` gives `anniversary`, other labels give `other` with that label. |
| `NOTE` | `note` | Several `NOTE` lines are joined with a blank line. |
| `PHOTO`, `LOGO` | `photo` (`PHOTO` only) | Inline data only: 2.1/3.0 `ENCODING=b` (or `BASE64`) with a bare or `TYPE=` image type, 4.0 `data:image/png;base64,...`. **Decided by the bytes, not by `TYPE`**: the first bytes are checked against PNG, JPEG, GIF, WebP, BMP signatures; a `TYPE=JPEG` over PNG bytes is read as PNG; no match: the photo is dropped with a warning. A `PHOTO;VALUE=uri:http...` is **not fetched**; the URL goes to `extra`. `LOGO` goes to `extra`. |
| `CATEGORIES` | `labels[]` | Split on `,`. Several lines add up. Proton writes `ITEMn.CATEGORIES`: the same rule. The Google label `myContacts` is dropped (it is Google's "all contacts"). |
| `UID`, `REV`, `PRODID`, `VERSION` | `uid`; `REV`, `PRODID` to `extra.source` | |
| `KIND`, `MEMBER` | see 2.5 | |
| `X-ANDROID-CUSTOM:vnd.android.cursor.item/nickname;N;...` | `nickname` if empty | The first `;` field after the mimetype is the value. |
| `X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;DATE;TYPE;LABEL;...` | `dates[]` | TYPE 1 `anniversary`, 2 `other`, 3 `birthday`, 0 `other` with `LABEL`. |
| `X-ANDROID-CUSTOM:...` other mimetypes, `X-MS-OL-DEFAULT-POSTAL-ADDRESS`, `X-ABRELATEDNAMES`, `X-ABUID`, `X-APPLE-*`, `X-GOOGLE-*`, any `X-*` | `extra.vcard` | |

Types are compared lower-case; a type that is `pref` only sets the flag.

#### 6.1.3 Sample: vCard 2.1 as written by Outlook and old Android (quoted-printable, ISO-8859-1, folded photo)

Awkward: `CHARSET=ISO-8859-1` with quoted-printable (`=FC` is a Latin-1 u-umlaut, not
UTF-8), quoted-printable soft line breaks (`Deutsch=` / `land`, and `=` at
the end of the `NOTE` line) with **no leading space** on the continuation, a
hard line break inside a value (`=0D=0A`), bare 2.1 types (`CELL;PREF`),
a base64 photo with a folded line and the mandatory empty line after it, and a
second card that is cut off (no `END:VCARD`) to test salvage.

```
BEGIN:VCARD
VERSION:2.1
N;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:M=FCller;J=FCrgen;;Dr.;
FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Dr. J=FCrgen M=FCller
ORG;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:M=FCller & S=F6hne GmbH;Einkauf
TITLE:Leiter
TEL;CELL;PREF:+49 170 1234567
TEL;HOME;VOICE:+49 30 123456
TEL;WORK;FAX:+49 30 123457
EMAIL;INTERNET;HOME:juergen@example.de
ADR;HOME;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:;;Stra=DFe des 17. Juni 1;Berlin;;10623;Deutsch=
land
NOTE;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Erste Zeile=0D=0AZweite Zeile, lang genug =
f=FCr einen weichen Umbruch
BDAY:19640512
PHOTO;ENCODING=BASE64;PNG:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChw
 GA60e6kgAAAABJRU5ErkJggg==

END:VCARD
BEGIN:VCARD
VERSION:2.1
N:Koch;Ute;;;
TEL;CELL:+49 171 7654321
```

Expected result (test case 6.1-3): two contacts. Contact 1: `name` =
{prefix `Dr.`, given `Jürgen`, family `Müller`}, `org` = {`Müller & Söhne GmbH`,
`Einkauf`}, three phones (mobile with `pref`, home, fax), one home email, a
home address with street `Straße des 17. Juni 1`, city `Berlin`, postal
`10623`, country `Deutschland` (the soft break joined `Deutsch` and `land`), note
`Erste Zeile` newline `Zweite Zeile, lang genug für einen weichen Umbruch`,
birthday `1964-05-12`, a 1x1 photo that decodes as PNG. Contact 2: Ute Koch with one
mobile phone and the warning "card 2 was not closed".

#### 6.1.4 Sample: vCard 3.0 from Apple Contacts / iCloud (grouped properties, X-ABLabel, folded line)

Awkward: `item1.EMAIL` + `item1.X-ABLabel:_$!<Work>!$_` pairs, a custom
label (`Bedrijfssite`), `X-ABDATE` with a label, year-less birthday through
1604, `X-ABRELATEDNAMES` (kept in `extra`), a `NOTE` folded in the middle of a
word and carrying escaped commas and `\n`, `PHOTO;ENCODING=b;TYPE=PNG`.

```
BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iOS 17.5//EN
N:Visser;Sanne;Marie;Mevr.;
FN:Sanne Marie Visser
NICKNAME:San
ORG:Visser Bouw B.V.;Inkoop
TITLE:Inkoper
item1.EMAIL;type=INTERNET;type=pref:sanne@visserbouw.example
item1.X-ABLabel:_$!<Work>!$_
EMAIL;type=INTERNET;type=HOME:sanne.visser@example.org
item2.TEL:+31 6 12 34 56 78
item2.X-ABLabel:_$!<Mobile>!$_
TEL;type=HOME;type=VOICE:+31 30 555 0199
item3.URL;type=pref:https://visserbouw.example
item3.X-ABLabel:Bedrijfssite
ADR;type=HOME;type=pref:;;Wilhelminastraat 5;Zwolle;;8011 AB;Nederland
BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-09
item4.X-ABDATE;type=pref:2016-06-01
item4.X-ABLabel:_$!<Anniversary>!$_
item5.X-ABRELATEDNAMES;type=pref:Jan Visser
item5.X-ABLabel:_$!<Spouse>!$_
X-SOCIALPROFILE;type=twitter;x-user=sannev:http://twitter.com/sannev
NOTE:Lunch op 12 mei\, vraag naar de offerte voor de nieuwbouw in Zwolle en 
 bel na 17:00 terug.\nTweede regel van de notitie.
CATEGORIES:Werk,Bouw
PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChw
 GA60e6kgAAAABJRU5ErkJggg==
UID:A1B2C3D4-0000-4000-8000-123456789ABC
REV:2026-11-01T10:00:00Z
END:VCARD
```

Expected (6.1-4): `emails`: work (pref) and home; `phones`: mobile (label from
`_$!<Mobile>!$_`) and home; `urls`: custom label `Bedrijfssite`; address home,
street `Wilhelminastraat 5`; birthday `--03-09`; `dates` has anniversary
`2016-06-01`; `ims` has twitter `sannev`; `labels` `Werk`, `Bouw`; `note` is
`Lunch op 12 mei, vraag naar de offerte voor de nieuwbouw in Zwolle en bel na 17:00
terug.` + newline + `Tweede regel van de notitie.` (the fold at "en " keeps the
space before the fold); `extra.vcard` holds `X-ABRELATEDNAMES` and its `X-ABLabel`
(group `item5`) so export writes them back.

#### 6.1.5 Sample: vCard 3.0 from Google Contacts (wrong photo `TYPE`, custom label)

Awkward: `TYPE=JPEG` on bytes that are PNG (decide by bytes), repeated `TYPE=`
parameters, the `myContacts` category, a custom-label phone in group
`item1`.

```
BEGIN:VCARD
VERSION:3.0
FN:Pieter van Dam
N:van Dam;Pieter;;;
NICKNAME:Piet
EMAIL;TYPE=INTERNET;TYPE=HOME:piet@example.net
EMAIL;TYPE=INTERNET;TYPE=WORK:pieter@damtransport.example
TEL;TYPE=CELL:+31 6 11112222
item1.TEL:+31 20 5551234
item1.X-ABLabel:Thuis kantoor
ADR;TYPE=HOME:;;Prinsengracht 263;Amsterdam;;1016 GV;Netherlands
ORG:Dam Transport;
TITLE:Planner
BDAY:1979-11-30
URL:https://damtransport.example
CATEGORIES:myContacts,Collega's
NOTE:Eerste contact via beurs.\nVoorkeur: e-mail
PHOTO;ENCODING=b;TYPE=JPEG:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChw
 GA60e6kgAAAABJRU5ErkJggg==
END:VCARD
```

Expected (6.1-5): `labels` = [`Collega's`] (no `myContacts`); the second phone is
`custom` with label `Thuis kantoor`; `org` = {`Dam Transport`, ``}; the photo is
stored as a re-encoded JPEG although the file said JPEG over PNG bytes.

#### 6.1.6 Sample: vCard 3.0 from an Android phone

Awkward: `X-ANDROID-CUSTOM` rows with 14 trailing `;` fields, a phone number
with no country code and no spaces.

```
BEGIN:VCARD
VERSION:3.0
N:Jansen;Kees;;;
FN:Kees Jansen
TEL;TYPE=CELL:0612345678
TEL;TYPE=WORK,VOICE:+31 10 5551212
EMAIL;TYPE=HOME:kees@example.org
X-ANDROID-CUSTOM:vnd.android.cursor.item/nickname;Keesie;1;;;;;;;;;;;;;
X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;1985-07-04;3;;;;;;;;;;;;;
X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2012-09-01;0;Eerste kus;;;;;;;;;;;;
END:VCARD
```

Expected (6.1-6): nickname `Keesie`; birthday `1985-07-04`; a `dates` entry
`other` with label `Eerste kus`, value `2012-09-01`; the first phone is
stored exactly as `0612345678` (never "fixed" to a country code).

#### 6.1.7 Sample: vCard 2.1 from Outlook (desktop)

Awkward: the `LABEL` twin of `ADR`, `X-MS-OL-DEFAULT-POSTAL-ADDRESS`,
`REV` in basic format, parentheses in a phone number.

```
BEGIN:VCARD
VERSION:2.1
N:Smith;Anna;;Ms.;
FN:Anna Smith
ORG:Contoso Ltd.;Sales
TITLE:Account Manager
TEL;WORK;VOICE:+1 (425) 555-0100
TEL;CELL;VOICE:+1 (425) 555-0111
ADR;WORK;PREF:;;1 Main Street;Redmond;WA;98052;United States of America
LABEL;WORK;PREF;ENCODING=QUOTED-PRINTABLE:1 Main Street=0D=0ARedmond, WA 98052=0D=0AUnited States of America
EMAIL;PREF;INTERNET:anna@contoso.example
X-MS-OL-DEFAULT-POSTAL-ADDRESS:2
REV:20261101T100000Z
END:VCARD
```

Expected (6.1-7): exactly **one** address (the `LABEL` line is in `extra`,
not a second address); phones keep `(425)` and the space.

#### 6.1.8 Sample: vCard 4.0 from Nextcloud / Radicale (SabreDAV)

Awkward: `TEL;VALUE=uri;TYPE="cell,voice";PREF=1:tel:...` (quoted multi-valued
type, `tel:` URI), year-less birthday `--0214`, a compact date `ANNIVERSARY`,
`IMPP` with `X-SERVICE-TYPE`, `PHOTO:data:image/png;base64,...`, `GENDER` (kept in
`extra`).

```
BEGIN:VCARD
VERSION:4.0
PRODID:-//Sabre//Sabre VObject 4.5.4//EN
UID:b6d1e8a0-4e02-4e5e-9b8a-6a1c5c0b7f11
FN:Lotte de Boer
N:de Boer;Lotte;;;
NICKNAME:Lot
BDAY:--0214
ANNIVERSARY:20100605
TEL;VALUE=uri;TYPE="cell,voice";PREF=1:tel:+31-6-22334455
EMAIL;TYPE=work;PREF=1:lotte@deboer.example
ADR;TYPE=home:;;Oudegracht 12;Utrecht;;3511 AB;Nederland
IMPP;X-SERVICE-TYPE=Matrix:matrix:u/lotte:matrix.example
URL:https://deboer.example
CATEGORIES:Familie,Vrienden
PHOTO:data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==
GENDER:F
KIND:individual
REV:20261015T091500Z
END:VCARD
```

Expected (6.1-8): phone mobile `+31-6-22334455` with `pref`, birthday `--02-14`,
anniversary `2010-06-05`, IM service `matrix` value `u/lotte:matrix.example`, `GENDER`
and `KIND` in `extra`.

#### 6.1.9 Sample: vCard 4.0 from Proton Mail (unverified)

Proton exports vCard 4.0 with grouped `ITEMn` properties; one `CATEGORIES`
per email group. **I could not check a real Proton export here**; this follows
Proton's documented use of `ITEMn.EMAIL` and `ITEMn.CATEGORIES` and must be
verified against a real file by the build task.

```
BEGIN:VCARD
VERSION:4.0
PRODID:-//ProtonMail//ProtonMail vCard 1.0.0//EN
FN;PREF=1:Noor Hendriks
UID:proton-web-0d0f1c2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f
ITEM1.EMAIL;PREF=1:noor@proton.example
ITEM1.CATEGORIES:Friends
ITEM2.EMAIL;PREF=2:noor.work@example.com
TEL;PREF=1:+31 6 99887766
END:VCARD
```

Expected (6.1-9): two emails (the `PREF=1` one has `pref`), label `Friends`,
`name.formatted` `Noor Hendriks`; with no `N`, the two-word `FN` is split to given `Noor`,
family `Hendriks` (6.1.2, `FN` row).

### 6.2 CSV from named programs

The CSV reader is RFC 4180 plus the habits of real exporters (6.3.1). A file is
recognised as a named dialect by its **header row** (case-insensitive,
trimmed). The header lists below are the columns each program is known to
write; samples are abridged to the columns that matter, which is stated each
time. A recognised file skips the mapping step (and can still be sent to it by
"Map columns myself"); an unrecognised file goes to the generic mapping (6.3).

| Dialect | Recognised when the header has | Dates | Multi-value cells | Encoding seen |
| --- | --- | --- | --- | --- |
| Google Contacts, current | `First Name` and `Organization Name` and `E-mail 1 - Value` | `YYYY-MM-DD` | separator ` ::: ` inside one cell (labels, emails, phones) | UTF-8 |
| Google Contacts, older ("Google CSV") | `Given Name` and `Family Name` and `Group Membership` | `YYYY-MM-DD` | ` ::: ` in `Group Membership` (`* myContacts ::: Friends`) | UTF-8 |
| Outlook desktop | `First Name` and `E-mail Address` and `Business Phone` (or its translation) | locale, often `d/m/yyyy`; empty is `0/0/00` | `Categories` separated by `;` | Windows-1252, or UTF-8 with BOM from newer builds |
| outlook.com / Microsoft 365 people | the same column set as Outlook desktop | as above | as above | UTF-8, with or without BOM |
| Thunderbird | `Primary Email` and `Display Name` | three columns `Birth Year`, `Birth Month`, `Birth Day` | none | UTF-8 (older: system code page) |
| Yahoo | `First`, `Last`, `Email`, `Messenger ID` | `Birthday` text | `Category` | UTF-8 |
| Proton | **no recognised CSV**: Proton Contacts exports vCard 4.0 (6.1.9). A CSV made for Proton's import uses Outlook or Google column names and is read as one of those. Unverified. | | | |

Column maps (header text to model). Anything not listed goes to `extra.csv`
(2.4). "Labelled" means the dialect has pairs `X n - Label` / `X n - Value`.

- **Google current**: `First Name`, `Middle Name`, `Last Name`, `Name Prefix`,
  `Name Suffix`, `Nickname`, `Phonetic *` to `phonetic_*`, `Organization Name`,
  `Organization Title`, `Organization Department`, `Birthday`, `Notes`,
  `Labels` (split on ` ::: `; `* myContacts` dropped), `Photo` (a URL: **not
  fetched**, kept in `extra.csv`); labelled `E-mail n`, `Phone n`, `Address n -
  Formatted/Street/City/PO Box/Region/Postal Code/Country/Extended Address`,
  `Website n`, `Relation n`, `Event n - Label/Value` (label `Anniversary`
  gives anniversary, others `other`), `Custom Field n`; any `n` up to what the
  header has (Google writes as many as the busiest contact needs).
- **Google older**: `Name` (to `formatted`), `Given Name`, `Additional Name`,
  `Family Name`, `Name Prefix`, `Name Suffix`, `Nickname`, `Birthday`, `Notes`,
  `Group Membership` (to `labels`), `E-mail n - Type/Value`, `Phone n -
  Type/Value`, `Address n - Type/Formatted/Street/City/PO Box/Region/Postal
  Code/Country/Extended Address`, `Organization 1 - Name/Title/Department`,
  `Website n - Type/Value`. `Type` words `* Mobile`, `Home`, `Work` (a leading
  `* ` marks the preferred one, as `pref`).
- **Outlook**: `Title` (name prefix), `First Name`, `Middle Name`, `Last Name`,
  `Suffix`, `Nickname`, `E-mail Address`, `E-mail 2 Address`, `E-mail 3
  Address`, `Home Phone` (+`2`) home, `Business Phone` (+`2`) work, `Mobile
  Phone` mobile, `Primary Phone` main, `Business Fax`, `Home Fax`, `Other Fax`
  fax, `Pager`, `Car Phone`, `Other Phone`, `Company Main Phone`, `Company`
  to `org.name`, `Department` to `org.unit`, `Job Title`, `Business Street`,
  `Business City`, `Business State`, `Business Postal Code`, `Business
  Country/Region` (work address; `Home *` and `Other *` likewise, `Street 2`
  and `Street 3` appended to `street` with newlines), `Birthday`, `Anniversary`,
  `Notes`, `Web Page`, `Categories` (split on `;`), `IMAddress`; the rest
  (`Manager's Name`, `Assistant's Name`, `Spouse`, `Children`, `Priority`,
  `Sensitivity`, `Billing Information`, `Mileage`, `Gender`, ...) to
  `extra.csv`. **Outlook writes translated headers** in other languages (for
  example `Voornaam`, `Achternaam`, `E-mailadres`); a translation table for
  nl, de, fr, es, it, pt, sv, da, nb, pl is part of the build task and an
  unrecognised language falls through to the mapping step.
- **Thunderbird**: `First Name`, `Last Name`, `Display Name` (to `formatted`),
  `Nickname`, `Primary Email`, `Secondary Email`, `Screen Name` (IM, service
  `aim`), `Work Phone`, `Home Phone`, `Fax Number`, `Pager Number`, `Mobile
  Number`, `Home Address`, `Home Address 2`, `Home City`, `Home State`, `Home
  ZipCode`, `Home Country`, `Work *` likewise, `Job Title`, `Department`,
  `Organization`, `Web Page 1`, `Web Page 2`, `Birth Year`, `Birth Month`,
  `Birth Day`, `Custom 1` to `Custom 4` (to `extra.csv`), `Notes`.
- **Yahoo**: `First`, `Middle`, `Last`, `Nickname`, `Email`, `Alternate Email 1`,
  `Alternate Email 2`, `Home`, `Work`, `Pager`, `Fax`, `Mobile`, `Other` (phones),
  `Messenger ID`, `Yahoo ID` (IMs), `Personal Website`, `Business Website`,
  `Title`, `Company`, `Work Address`/`City`/`State`/`ZIP`/`Country`, `Home *`,
  `Birthday`, `Anniversary`, `Category` (to `labels`), `Comments` (to `note`),
  `Custom 1` to `Custom 4`.

#### 6.2.1 Sample: Google Contacts CSV (abridged; quoted newlines, ` ::: ` in cells)

Awkward: a `Notes` cell and an `Address 1 - Formatted` cell that contain a
**newline inside quotes**, two e-mail addresses in one cell separated by
` ::: `, a label list with `myContacts`.

```
First Name,Middle Name,Last Name,Name Prefix,Name Suffix,Nickname,Organization Name,Organization Title,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,Address 1 - Label,Address 1 - Formatted,Address 1 - Street,Address 1 - City,Address 1 - Postal Code,Address 1 - Country,Website 1 - Label,Website 1 - Value
Marieke,,Smit,,,Mies,Smit & Zn,Eigenaar,1990-04-21,"Eerste regel
Tweede regel",myContacts ::: Klanten,Work,marieke@smit.example ::: m.smit@smit.example,Mobile,+31 6 55512345,Home,+31 20 5550000,Home,"Damrak 1
1012 LG Amsterdam",Damrak 1,Amsterdam,1012 LG,Netherlands,Homepage,https://smit.example
```

Expected (6.2-1): one contact; `note` = `Eerste regel` newline `Tweede regel`; two emails
(both type `work`); phones mobile and home; address street `Damrak 1`, city, postal,
country (the formatted cell is used only when the parts are empty); label
`Klanten` only; a `homepage`-labelled URL (type `custom`, label `Homepage`).

#### 6.2.2 Sample: older Google CSV (abridged)

```
Name,Given Name,Additional Name,Family Name,Birthday,Notes,Group Membership,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value,Organization 1 - Name,Organization 1 - Title
Bram Kok,Bram,,Kok,1975-12-24,,* myContacts ::: Voetbal,* Home,bram@example.nl,Mobile,0687654321,FC Utrecht,Trainer
```

Expected (6.2-2): label `Voetbal`; the `* Home` email has `pref`; organisation and title.

#### 6.2.3 Sample: Outlook desktop CSV (abridged; Windows-1252, locale dates, `0/0/00`)

Awkward: the file is **Windows-1252** (the `u`-umlaut of `Müller` is the single
byte `FC`, not UTF-8; the test fixture is written with `encoding='cp1252'`),
the birthday is `d/m/yyyy` and ambiguous in the first row (`2/3/1970`) but the
second row (`13/4/1981`) shows that the day comes first; an empty anniversary is
`0/0/00`; `Categories` use `;`; the `Notes` cell contains a newline.

```
First Name,Middle Name,Last Name,Title,Suffix,Nickname,E-mail Address,E-mail 2 Address,Home Phone,Business Phone,Mobile Phone,Company,Job Title,Department,Business Street,Business City,Business State,Business Postal Code,Business Country/Region,Home Street,Home City,Home Postal Code,Home Country/Region,Birthday,Anniversary,Notes,Web Page,Categories
Jos,,Müller,Dhr.,,,jos@example.de,,+49 30 111,+49 30 222,+49 170 333,Müller GmbH,Leiter,Einkauf,Hauptstr. 5,Berlin,,10115,Germany,,,,,2/3/1970,0/0/00,"Zeile 1
Zeile 2",http://mueller.example,Business; VIP
Eva,,Peters,Mevr.,,,eva@example.nl,,,,06 55 44 33 22,,,,,,,,,Dorpsstraat 3,Utrecht,3511 AB,Netherlands,13/4/1981,0/0/00,,,
```

Expected (6.2-3): the date order is decided **per file**: any value whose first
number is above 12 means day-first, any whose second is above 12 means
month-first; here `13/4/1981` makes the file day-first, so Jos is `1970-03-02`;
if no row decides, the preview asks "Dates look like 2/3/1970: day first or
month first?" with the browser locale preselected. `0/0/00` is empty.
Two categories `Business`, `VIP`. Both a work address and, for Eva, a home
address. Decoding as UTF-8 fails (invalid byte `FC`), so the file is read as
Windows-1252 and the preview shows "Encoding: Windows-1252 (detected)".

#### 6.2.4 Sample: outlook.com / Microsoft 365 CSV (abridged; UTF-8 with BOM)

The file starts with the three bytes `EF BB BF` before `First Name` (the test
writes them explicitly); the BOM must not end up in the first header (a header
of `﻿First Name` would not be recognised).

```
First Name,Last Name,E-mail Address,Mobile Phone,Home Street,Home City,Home State,Home Postal Code,Home Country/Region,Company,Job Title,Birthday
Hanna,Öztürk,hanna@example.com,+90 532 555 0100,İnönü Cd. 4,İstanbul,,34437,Türkiye,Öztürk Ltd.,Müdür,1992-08-17
```

Expected (6.2-4): detected UTF-8 (BOM), header recognised, `Öztürk` and `İstanbul`
intact (non-Latin-1 letters would be lost by a wrong Windows-1252 guess).

#### 6.2.5 Sample: Thunderbird CSV (abridged; separate birth columns, custom fields)

```
First Name,Last Name,Display Name,Nickname,Primary Email,Secondary Email,Work Phone,Home Phone,Mobile Number,Home Address,Home City,Home ZipCode,Home Country,Organization,Job Title,Web Page 1,Birth Year,Birth Month,Birth Day,Custom 1,Custom 2,Notes
Anne,Veldhuis,Anne Veldhuis,Annie,anne@example.nl,anne.v@work.example,+31 30 5550101,+31 30 5550102,+31 6 44556677,Lange Nieuwstraat 7,Utrecht,3512 PA,Nederland,Veldhuis Advies,Adviseur,https://veldhuis.example,1988,09,23,VIP,,Regel een
```

Expected (6.2-5): birthday `1988-09-23`; `Custom 1` = `VIP` in `extra.csv`
(`Custom 2` empty: not stored); work phone and home phone typed.

#### 6.2.6 Sample: Yahoo CSV (abridged)

```
First,Middle,Last,Nickname,Email,Category,Messenger ID,Home,Work,Mobile,Personal Website,Title,Company,Home Address,Home City,Home ZIP,Home Country,Birthday,Comments
Cor,,de Wit,Cootje,cor@example.com,Friends,cor_dewit,+31 20 5550123,,+31 6 99001122,https://dewit.example,Dr.,De Wit BV,Kalverstraat 9,Amsterdam,1012 NX,Netherlands,03/28/1969,"Zegt: ""bel me"""
```

Expected (6.2-6): the cell `"Zegt: ""bel me"""` becomes `Zegt: "bel me"`; `Messenger ID`
becomes an IM entry with service `other`; the birthday `03/28/1969` is month-first
(28 > 12, the date-order rule of 6.2-3); `Dr.` in the `Title` column goes to
`title`, as in the column map above (whether Yahoo means a job title or a
name title there is unverified, 6.7).

### 6.3 Generic CSV with a column mapping step

Used for any CSV that is not a named dialect (a spreadsheet saved by hand, a
CRM export, a phone-maker's tool, a localised Outlook).

#### 6.3.1 Reader

- **Delimiter**: tries `,` `;` tab and `|`; for each, parse the first 20
  records and score: the delimiter with the largest number of columns whose
  records all have the same column count wins; ties go to the one that gives
  more columns; an Excel first line `sep=;` (case-insensitive) is honoured and
  removed. The preview has a "Delimiter" select to override.
- **Encoding**: 6.0 (BOM, UTF-16, strict UTF-8, else Windows-1252). Excel's
  "Unicode Text" export is UTF-16 LE with tab separators and a BOM and works
  through the same path.
- **Quoting**: RFC 4180: a field starting with `"` ends at the next `"` not
  followed by another `"`; `""` is one `"`; CR, LF or CRLF inside quotes are
  kept (normalised to LF in the value); a quote in the middle of an unquoted
  field is kept as a character. A missing closing quote at the end of the file
  closes the field there and adds the warning "unterminated quote in record N".
- Records longer or shorter than the header are padded or have the surplus
  columns joined into `extra.csv['(extra column n)']` and counted as a warning.
- Completely empty lines are skipped. Header names are trimmed and compared
  case-insensitively; duplicate header names get a ` (2)` suffix.
- Leading `=`, `+`, `-`, `@` in a cell are **kept as typed** on import (it is
  data); the only special case is a leading `'` that our own export wrote
  before such a character (8.4), which is removed.

#### 6.3.2 The mapping step

A dialog step shown for an unrecognised file (and on demand for a recognised
one). It lists every column with: the header text, the first three non-empty
sample values (as text), and a `<select>` of targets. The suggestion comes from a
synonym table (English, nl, de, fr, es, it, pt: "voornaam", "vorname",
"prénom", "mobiel", "handy", "tel", "e-mail", "email", "straat", "postcode",
"plaats", "firma", "bedrijf", "geburtstag", "notitie", "bemerkung" ...). Targets: Ignore;
Name: prefix, given, additional, family, suffix, formatted (full name: split
"Given Family" when it has two words, "Family, Given" when it has a comma),
nickname; Organisation, Department, Job title; Phone (with a type: mobile,
home, work, main, fax, pager, other, or "custom label..."); Email (same);
Address: street, extended, city, region, postal code, country (with a type,
grouped by choosing "Address 1/2"); Website; Messenger; Date (birthday,
anniversary, other) with a date-order choice; Note; Labels (split on `;`, `,`
or ` ::: `, chosen by a select); Favourite (`1`, `true`, `yes`, `x`, `star`);
Keep as other field (to `extra.csv`).

Rules: a column mapped to a target that can repeat (phone, email, ...) may be
used several times; a column mapped twice to a single target (two
"given name") is refused with an inline error and the Import button stays
disabled; at least one of name, organisation, email or phone must be mapped
(a contact needs one, 4.5). A "first row is a header" checkbox (default on)
is respected. The chosen mapping is kept in memory for the dialog only, not
stored. The preview table shows the first 5 resulting contacts live.

#### 6.3.3 Sample: semicolon, Windows-1252, quoted newline and doubled quotes

Awkward: delimiter `;` (Dutch Excel), **Windows-1252** bytes (`DC` for the
capital U-umlaut, `C7` for the capital C-cedilla; the fixture is written with
`encoding='cp1252'`), a quoted field with a newline, a quoted field with `""`,
a localised header, and a cell starting with `=` that must stay text.

```
Voornaam;Achternaam;Mobiel;E-mail;Adres;Opmerking
Ünal;Çelik;06-12345678;unal@example.nl;"Kerkstraat 1
3511 AB Utrecht";"zei: ""bel mij"""
Fieke;Bos;=+31 6 11;fieke@example.nl;;
```

Expected (6.3-3): delimiter `;` detected (3 records, all with 6 columns, versus 1
column for `,`); Windows-1252 detected; suggested mapping Voornaam to given name,
Achternaam to family, Mobiel to phone (mobile), E-mail to email, Adres to address
(street), Opmerking to note; Ünal's address is `Kerkstraat 1` newline `3511 AB
Utrecht`; his note is `zei: "bel mij"`; Fieke's phone is the text `=+31 6 11`
(kept; it is data), and the later export prefixes it (8.4).

### 6.4 LDIF (Thunderbird address book export, also OpenLDAP, Apple Address Book LDIF)

Reader (RFC 2849):

- Records separated by one or more blank lines; the first line of a record is
  `dn:`. A leading `version: 1` line is accepted. Lines starting with `#` are
  comments. A line that starts with one space continues the previous line (the
  space is removed). `attr:: base64` is decoded as **UTF-8**; if that is not valid
  UTF-8 it is decoded as Windows-1252. `attr:< file:///...` (value from a URL)
  is **never followed**: the attribute is skipped and counted as a warning.
  Attribute names are case-insensitive; repeated attributes keep all values.
- Only records with an object class containing `person`, `inetOrgPerson`,
  `mozillaAbPersonAlpha` or `organizationalPerson`, or at least one mail,
  phone or name attribute, are contacts. Records of other kinds (an
  `addressbook` or `groupOfNames` entry) are skipped with a reason, except
  that a `groupOfNames` / `mozillaAbList` with `member` or `mozillaAbListMember`
  entries becomes labels on the members whose `mail` matches.
- Thunderbird's `.ldif` is written in UTF-8; a Latin-1 file (older systems)
  is handled by the encoding rule of 6.0.

| LDIF attribute | Model |
| --- | --- |
| `givenName`, `sn`, `cn`, `displayName`, `mozillaNickname` (also `nickname`, `xmozillanickname`) | `name.given`, `name.family`, `name.formatted`, `nickname` |
| `mail`, `mozillaSecondEmail` | `emails[]` (first is `pref`) |
| `telephoneNumber` work, `homePhone` home, `mobile` or `cellPhone` mobile, `fax` or `facsimileTelephoneNumber` fax, `pager` | `phones[]` |
| `mozillaHomeStreet`, `mozillaHomeStreet2`, `mozillaHomeLocalityName`, `mozillaHomeState`, `mozillaHomePostalCode`, `mozillaHomeCountryName` | home address |
| `street` (or `postalAddress`), `l`, `st`, `postalCode`, `c` or `co` | work address (`postalAddress` is split on `$` into lines) |
| `o`, `ou`, `title` | `org.name`, `org.unit`, `title` |
| `mozillaHomeUrl`, `mozillaWorkUrl`, `labeledURI` | `urls[]` |
| `birthyear`, `birthmonth`, `birthday` | birthday |
| `description`, `notes` | `note` |
| `jpegPhoto`, `photo` (as `::` base64) | `photo` (decided by bytes, 6.1.2) |
| `mozillaCustom1` to `4`, `xmozillausehtmlmail`, `modifytimestamp`, `objectclass`, `dn`, everything else | `extra.ldif` |

#### 6.4.1 Sample: Thunderbird LDIF (folded line, base64 non-ASCII, a record to skip)

Awkward: `description` folded across two lines, `dn::` and `cn::` in base64
because the name has non-ASCII characters, a second record with a photo-less
sparse set of attributes, and a `groupOfNames` record that is not a contact.

```
dn:cn=Anne Veldhuis,mail=anne@example.nl
objectclass:top
objectclass:person
objectclass:organizationalPerson
objectclass:inetOrgPerson
objectclass:mozillaAbPersonAlpha
givenName:Anne
sn:Veldhuis
cn:Anne Veldhuis
mozillaNickname:Annie
mail:anne@example.nl
mozillaSecondEmail:anne.v@work.example
telephoneNumber:+31 30 5550101
homePhone:+31 30 5550102
mobile:+31 6 44556677
mozillaHomeStreet:Lange Nieuwstraat 7
mozillaHomeLocalityName:Utrecht
mozillaHomePostalCode:3512 PA
mozillaHomeCountryName:Nederland
o:Veldhuis Advies
title:Adviseur
birthyear:1988
birthmonth:09
birthday:23
description:Regel een van de notitie, die zo lang is dat Thunderbird hem op
 een nieuwe regel voortzet.
mozillaCustom1:VIP
modifytimestamp:0

dn:: Y249Wm/DqyDDhWtlcnN0csO2bSxtYWlsPXpvZUBleGFtcGxlLnNl
objectclass:top
objectclass:person
cn:: Wm/DqyDDhWtlcnN0csO2bQ==
sn:: w4VrZXJzdHLDtm0=
givenName:: Wm/Dqw==
mail:zoe@example.se

dn:cn=Familie,mail=familie@example.nl
objectclass:top
objectclass:groupOfNames
cn:Familie
```

Expected (6.4-1): two contacts and one skipped record ("not a contact:
groupOfNames"). Anne: emails 2, phones 3 (work, home, mobile), home address
Utrecht, birthday `1988-09-23`, note `Regel een van de notitie, die zo lang is dat
Thunderbird hem op een nieuwe regel voortzet.` (single space where the fold
was; the continuation's leading space is removed, the trailing text keeps its
own), `extra.ldif.mozillaCustom1` = `VIP`. Zoë: `cn::` decodes to `Zoë Åkerström`,
given `Zoë`, family `Åkerström`.

### 6.5 jCard (RFC 7095, `.json`, `.jcf`)

Input is JSON text: one jCard `["vcard", [ ...properties... ]]` or an array of
jCards (the form servers and tools use for many; the RFC defines only one). A
property is `[name, params, type, value...]`.

- Parsed with `JSON.parse` and a **reviver that drops the keys `__proto__`,
  `constructor` and `prototype`**; the result is only ever read through own-
  property checks and copied into fresh objects built with `Object.create(null)`
  or `Map` (9.4). Depth is checked (at most 32 levels) and size is limited
  (7.8) before parsing, because `JSON.parse` has no depth limit of its own.
- Property names are lower-case and map exactly as the vCard names of 6.1.2
  (`n`, `fn`, `tel`, `email`, `adr`, `bday`, `org`, `note`, `photo`, `categories`, ...).
  `n` and `adr` have an array value; `org` an array; `tel` a `uri` (`tel:...`) or
  `text`; `bday`/`anniversary` use `date`, `date-and-or-time` or `text`.
  Parameters are an object whose values are strings or arrays of strings.
  Group is the `group` parameter. Unknown properties, including every `x-*`,
  go to `extra.vcard` with `v` the JSON-encoded value.
- Anything that is not `["vcard", [...]]` is refused with "not a jCard".

#### 6.5.1 Sample: jCard with an unknown property and a hostile key

Awkward: a `__proto__` key in a parameter object and a `constructor` key at the
top of a parameter, an `x-` property of type `unknown`, a year-less `date`, a
tel as `uri` with an `ext`.

```json
["vcard", [
  ["version", {}, "text", "4.0"],
  ["fn", {}, "text", "Dr. Eva Bakker"],
  ["n", {}, "text", ["Bakker", "Eva", "", "Dr.", ""]],
  ["tel", {"type": ["cell"], "pref": "1"}, "uri", "tel:+31-6-1234-5678;ext=12"],
  ["tel", {"type": "work", "__proto__": {"polluted": true}}, "text", "+31 20 5550000"],
  ["email", {"type": "work", "constructor": {"prototype": {"x": 1}}}, "text", "eva@bakker.example"],
  ["adr", {"type": "home"}, "text", ["", "", "Keizersgracht 1", "Amsterdam", "", "1015 AA", "Netherlands"]],
  ["bday", {}, "date", "--03-09"],
  ["x-hobby", {}, "unknown", "zeilen"]
]]
```

Expected (6.5-1): one contact; after the import `({}).polluted` and `({}).x` are
`undefined` in the page; the cell phone value is `+31-6-1234-5678;ext=12`
(`tel:` stripped) with `pref`; birthday `--03-09`; `extra.vcard` holds
`x-hobby` with the value `zeilen`; the work phone is imported and the hostile
parameter key is simply not there.

### 6.6 Formats considered and left in or out

| Format | Decision | Reason |
| --- | --- | --- |
| vCard 2.1, 3.0, 4.0 | in | The universal export: Apple, Google, Android, Outlook, Nextcloud, Proton, Samsung, Thunderbird (newer). |
| CSV: Google, Outlook (desktop and outlook.com), Thunderbird, Yahoo | in | Named in the request; the second most common export. |
| Generic CSV with mapping | in | Covers spreadsheets, CRMs and every localised or unknown CSV. |
| LDIF | in | Thunderbird's native export; enterprise address books. |
| jCard (RFC 7095) | in | The JSON form of vCard; cheap once the vCard mapper exists (same mapping). |
| xCard (RFC 6351, XML) | out in v1 | Almost no program exports it; XML adds a parser surface (entities). If asked later, it is the same mapper behind the same threat rules as `docs/IMPORT_EXPORT_SPEC.md` 4.3. |
| Apple Contacts "Archive" (`.abbu`) and iCloud export | the iCloud export is vCard (in); `.abbu` is a macOS package of SQLite files | out; the user exports vCard from Contacts. |
| Windows Contacts (`.contact`, XML) and Outlook `.pst` / `.olm` | out | Proprietary, XML or binary; Outlook can export CSV and vCard. |
| Samsung `.spb`, Huawei backup, WhatsApp, iPhone backups | out | Proprietary or encrypted; the phone exports vCard. |
| Excel `.xlsx` / `.ods` | out | Zip-with-XML parser surface and zip-bomb risk (9.3); "Save as CSV" is the supported route. The error message for an `.xlsx` file says exactly that. |
| Pasted text (a list of names and numbers) | out | The generic CSV step covers delimited text; no free-text guessing. |
| LinkedIn "Connections" CSV, Facebook JSON | out | Not an address book format. LinkedIn's CSV has a three-line note before the header; if a user presents it the generic CSV step can map it after the first lines are skipped ("Skip first N lines" input, default 0). |
| Mac/iOS "Contacts" `.vcf` from a share sheet (one card) | in | Same vCard reader. |
| Bluetooth/NFC contact exchange | out | Not a file. |
| Standard Notes / Keep / Evernote | unrelated | The notes importers. |

### 6.7 Confidence and what to verify against real exports

| Item | Status |
| --- | --- |
| vCard 2.1, 3.0, 4.0 grammar, folding, quoted-printable, base64 | Standard (RFC 2426, 6350, vCard 2.1 spec). Sure. |
| Apple `item1.X-ABLabel`, `_$!<Mobile>!$_`, `X-ABDATE`, `X-APPLE-OMIT-YEAR=1604` | Widely documented behaviour. Sample is constructed. Sure of the pattern, not of every field order. |
| Google vCard 3.0 shape, `myContacts` | Pattern known. Constructed. |
| Android `X-ANDROID-CUSTOM` event types (1 anniversary, 2 other, 3 birthday, 0 custom) | From Android's `ContactsContract.CommonDataKinds.Event`. Medium: verify with a real phone export. |
| Outlook vCard `LABEL` twin and `X-MS-OL-*` | Pattern known. Medium. |
| Nextcloud/Sabre 4.0 | Constructed. Nextcloud's own UI often writes 3.0. Medium. |
| Proton vCard (`ITEMn`, `CATEGORIES`) | **Unverified**. |
| Google, Outlook, Thunderbird, Yahoo CSV headers | From memory of the programs' exports; the lists in 6.2 are the ones to maintain. Medium for Google and Outlook, lower for Thunderbird and Yahoo (Yahoo has changed its export; `Title` meaning is uncertain). The mapping step is the safety net for all of them. |
| Outlook localised headers | Known to exist; the translation table must be built from real localised exports. |
| LDIF Thunderbird attribute names | `mozilla*` attribute names are Thunderbird's own schema; sample constructed. Medium. |
| jCard | Standard (RFC 7095). Sure. |

The build task for each format **starts** with its table row: it asks for or
makes a real export and adds it next to the constructed sample before the
parser is called done.

## 7. Import flow

Entry point: the **Import** button of the Contacts pane (and the same entry
in Settings next to the other imports). One dialog, `role="dialog"
aria-modal="true" aria-labelledby`, built like the 2FA import dialog
(`app.html:2815-2867`), so the generic focus trap, focus return and Escape
handling apply (`dialog-a11y.js`). It needs an unlocked vault.

### 7.1 Step 1: choose files

- A hidden `<input type="file" multiple accept=".vcf,.vcard,.csv,.tsv,.txt,.ldif,.json,.jcf,text/vcard,text/x-vcard,text/csv,application/json">`
  (class `sr-file`, like `totp-import-file`, `app.html:2867`), opened by a
  visible **Choose files** button. Drag and drop onto the dialog also works.
  Several files at once are one import (one preview, one undo).
- The format is decided by **content, not by the file name**: a leading
  `BEGIN:VCARD` (after BOM and blank lines) is vCard; a first non-comment line
  `dn:` or `version: 1` is LDIF; first non-space character `[` or `{` is jCard
  JSON; everything else is CSV. A `.xlsx`, `.ods`, `.zip`, `.pdf`, an image or
  any file with a NUL byte in its first 4 KiB is refused with "This is not a
  contact file. Export your contacts as vCard (.vcf) or CSV and choose that
  file."
- A refused file is listed in the preview with its reason; other files in
  the same selection continue.

### 7.2 Step 2: parse and (for CSV) map

The parsers of section 6 run with progress ("Reading file 2 of 3: 1,200
contacts") and yield to the event loop every 200 contacts (the same pattern
`buildLocalBackup` uses, progress reports at `app.js:26321`), so the page stays responsive and a
**Cancel** button works at any point (it discards everything; nothing has
been written yet). The mapping step (6.3.2) appears here for an unknown CSV.
`Wrong characters?` and `Delimiter` selects re-run the parse.

### 7.3 Step 3: preview with counts

A `role="status" aria-live="polite"` summary and a table:

> "Found **248** contacts in 2 files: **231** new, **12** look like contacts
> you already have, **3** were skipped (see reasons). **41** have a photo, **17**
> have more than one email address. 9 fields could not be kept."

- Counts: total found, valid, skipped (with reason list: "no name, phone or
  email", "card 7 was not closed", "too many entries", "not a contact:
  groupOfNames", "photo too complex (contact kept without photo)"), contacts
  with photos, contacts that would lose fields over the `extra` cap (2.4),
  labels that will be created, the encoding and dialect detected per file
  ("vCard 3.0, Apple", "CSV, Google Contacts, UTF-8").
- A list of the first 50 resulting contacts (name, first phone or email),
  each with a checkbox (default on) to leave single contacts out, and a
  "Select all / none". Text is inserted with `textContent` only.
- The estimated storage added (7.8) and the account's remaining quota
  (`db.user_storage_quota_bytes` via the account info the client already has,
  `plan_features` / `storage_quota_mb`, `app.js:726`); more than the remaining
  quota disables Import with "This import needs about X MB and you have Y MB
  left."
- Nothing has been written to the vault at this point.

### 7.4 Duplicate detection

> The matching of the Contacts tab's "Find duplicates" (7.10) is implemented in `contacts.js` and is the matcher the
> import step is to reuse; where its phone and name rules differ from the text below, 7.10 is what the code does.

Run in the browser against the contacts already in the vault **and** among
the contacts of this import. A pair is a duplicate when, after normalisation
(NFKC, lower-case, accents removed, whitespace collapsed):

1. **same email**: any email address of one equals any of the other (compared
   lower-cased, no `mailto:`, a Gmail dot or `+tag` is **not** folded: two
   addresses that differ only so are different); or
2. **same phone**: digits-only equality of any two phone numbers of at least 6
   digits, after removing a leading `00` or `+` and, if one has a country code
   and the other starts with one `0`, comparing the last 9 digits (this
   matches `0612345678` with `+31612345678`; a pair that matches only under
   this rule is marked "probably"); or
3. **same name**: equal given + family (any order), both non-empty, and not
   already matched by 1 or 2 (marked "possibly: same name, different number
   or email").
4. **same `uid`** (3.5) in a file imported before: "same contact as imported on
   <date>".

Rules to avoid wrong merges: a phone or email shared by two different named
people in the same file is **not** treated as duplicate inside that file
(family landlines are common); within-file duplicates are detected only
when also the name matches. A contact with no name is matched only by 1 and 2.
Name-only matches default to **Keep both**.

The preview lists every duplicate pair: the incoming contact, the existing one
and the reason, with a per-pair choice, default taken from a global radio:

| Choice | Effect |
| --- | --- |
| **Skip** (default for email/phone/uid matches) | The incoming contact is not imported; the existing one is untouched. |
| **Merge** | Into the existing contact: empty single fields are filled from the incoming one; non-empty ones stay as they are; list fields (phones, emails, addresses, urls, ims, dates) get the incoming entries that are **not** already there (same normalised value); labels are unioned; the incoming `note` is appended after a blank line when it differs; the photo is taken only if there is none; `extra` entries are added when no entry of the same name exists. Nothing is overwritten and nothing is deleted. |
| **Keep both** (default for name-only matches) | The incoming contact is added as a new one. |

The global choice applies to all pairs not set individually. The preview
states what each choice did in the result.

### 7.5 Step 4: import and result summary

On **Import**: contacts are written through `NotesStore.importContacts(parsed,
{ choices })`, which for each contact builds the content (2.2), runs the
photo re-encode (3.4), and calls `upsert` with `skipDirty` unset so the
normal push logic applies; the dirty set is pushed in batches by the existing
`pushDirty` (which batches by size, `syncRequestTimeoutMs`, `store.js:968`). The
button shows "Importing 120 of 248" and the dialog cannot be closed by
Escape while it runs (`aria-busy="true"`, the pattern `DialogA11y.confirm` already
honours, `dialog-a11y.js:17-19`).

The result summary (in the dialog and as a toast through the existing toast
function):

> "Imported **231** new contacts, **9** merged into existing contacts, **3**
> skipped as duplicates, **3** not imported (reasons below). **41** photos
> stored. **Undo import** is available until you close the dialog or leave the
> Contacts tab."

and a list of the not-imported entries with their reason. It also states
"These files were read on this device. They were not uploaded." Importing the
same file twice is safe: the second run finds every contact as a duplicate
(by email, phone or `uid`) and defaults to Skip, so it reports "0 new, 231
skipped as duplicates".

### 7.6 Undo of the last import

- `importContacts` returns an **undo record** kept **in memory only**: the list
  of uuids it created, and for each merged contact the complete content as it was
  before the merge. It is not stored (not in IndexedDB, not synced), because
  it holds the pre-merge copy of other contacts.
- **Undo import** (button in the result and in the toast, `toastWithUndo`,
  `app.js:4436`) calls `restoreContacts(record)`: created contacts are
  deleted (`remove`, `store.js:6647`, which pushes a tombstone), merged
  contacts get their old content back through `upsert`. It is one
  confirm-less action (it undoes only what the import did) that then says
  "Import undone: 231 contacts removed, 9 restored."
- Edits made to an imported contact after the import are respected: undo
  **keeps** a created contact whose `updated_at` is later than the import's end
  time and says so ("2 contacts were edited since and were kept"), and skips
  restoring a merged contact edited since.
- The record is dropped when the dialog is closed, the tab is left, the vault
  is locked or the page reloads. After that the user deletes the imported
  contacts by hand; to make that possible every imported contact carries
  `extra.source.batch` and the contact list has a filter "Imported on
  19 Nov 2026 (231)" shown in the label bar for the most recent three batches
  (derived from `extra.source`, no extra storage), with a "Delete these"
  action and `confirmAction`.
- Two imports in a row: only the last has an undo record; the earlier batch is
  reachable by its filter.
- Undo and a conflict from another device: the tombstones sync like any
  delete; the edit-beats-delete rule (`store.js:3808`) keeps a contact that
  another device changed meanwhile.

### 7.7 Locked vault, offline, twice

- Locked vault: Import is disabled (section 7, first paragraph). If the vault locks while a
  preview is open, the dialog closes, parsed data is discarded and the
  user is told "Vault locked. Nothing was imported." If it locks during
  writing, `upsert` throws `'Unlock the vault first'` style errors; the
  importer stops, reports "Stopped after N contacts (vault locked)" and
  keeps the undo record for the N written.
- Offline: the whole import works; the result says "Saved on this device;
  sync will upload them when you are online." (the same text pattern the app
  uses for offline saves).
- The same action twice: pressing Import twice is blocked (button disabled
  and a guard flag); choosing the same file again is a second, separate import
  (7.5).
- A file chosen but never imported leaves nothing behind: parsed contacts
  exist only in the dialog's closure and are dropped on close.

### 7.8 Limits and where they come from

Measured values (section 1.5): a typical contact is **0.4 KB** of JSON and
**0.62 KB** of ciphertext; a worst-case 192 px photo is at most **12 KiB** raw
(3.4), **21.9 KB** stored.

| Limit | Value | Derivation |
| --- | --- | --- |
| File size, vCard / CSV / LDIF / JSON | **64 MiB** (67,108,864 bytes) each, and **128 MiB** per import in total. Larger: refused before reading. | An iCloud or Google export of 5,000 contacts with original photos (up to a few hundred KB each) is in the hundreds of MB; 64 MiB is above any realistic contacts file with photos at typical phone size, and the string created is 2 bytes per char in memory (128 MB for 64 MiB), which a mid-range phone can hold. Notes importers use 10 MiB (JSON, Markdown) and 256 MiB (ENEX with attachments), `md-import.js:16`, `enex-import.js:13`. A file with more than 64 MiB is almost always photos; the message suggests exporting without photos. |
| Contacts per import | **10,000** | Same as `MAX_NOTES` in the Markdown, ENEX and Keep importers (`md-import.js:17`, `enex-import.js:16`, `keep-import.js:15`). Text-only that is 10,000 x 0.62 KB = 6.2 MB of ciphertext, well inside the Free plan's 50 MB quota (`plans.py:34`). |
| Contacts in the vault | no fixed cap; the quota decides | With all photos at the 12 KiB cap each contact is at most about 22.5 KB, so 50 MB holds about 2,300 contacts with maximal photos, or about 80,000 without photos. The preview checks the estimate against the remaining quota (7.3). |
| One contact (plaintext after import) | **128 KiB** | Photo 12 KiB + `extra` 32 KiB + text 20 KB note + lists is about 90 KiB at its caps; 128 KiB leaves headroom and stays far below the 75 MiB item limit (`SYNC_MAX_ITEM_BYTES`). |
| One vCard card, raw | **4 MiB** (before the photo is decoded) | A card with a 3 MB original photo is legal. More is refused for that card. |
| Original photo, decoded | **3 MiB** and **16 megapixels** (header read before decoding) | 9.3. |
| Entries per list per contact | 50 | A contact with more is truncated and the surplus counted ("kept 50 of 213 phone numbers"); in `extra` they are not kept. |
| Characters: name part 200, nickname 200, org 200, title 200, label 60, value (phone, email, url, im) 500, address part 500, note 20,000 | as listed | Fits every real value; bounds the work and the rendering. |
| Labels per contact | 20, each 40 characters | 2.2. |
| CSV: columns | 500 per row; record 1 MiB | A real file has under 150 columns; a record of 1 MiB is a broken file. |
| LDIF / vCard: lines | 1,000,000 lines per file | Bounds parse time. |
| jCard depth | 32 | 6.5. |
| Parse time | a watchdog stops a parse that runs longer than 60 s of wall time and reports "This file took too long to read" | A regex or loop surprise cannot freeze the page for ever; with 200-contact yields the page stays usable and Cancel works. |

The first limit hit is shown in the preview before anything is written
(the same convention as `docs/IMPORT_EXPORT_SPEC.md` section 5, last bullet).

### 7.9 What the first implementation does and does not do

The vCard import (6.1) with preview, result summary and undo is built; the dialog takes other formats through
`NotesContactsImport.registerFormat` (sniff, parse, describe), so CSV, LDIF and jCard only add a parser. Not built yet,
and therefore not claimed by the app: the CSV, LDIF and jCard readers and the column mapping step; the Merge and
Keep both choices of 7.4 (a contact that matches one in the vault by email, phone or UID is left out by default, and
the owner can untick that); duplicates inside one file and name-only matches; the quota estimate of 7.3; the progress
and 60 s watchdog of 7.2 (the parse is synchronous; only writing reports "Importing N of M"); the "Imported on"
filter and "Delete these" of 7.6. The undo record is kept until the vault locks; the dialog's Undo button and the
toast's Undo both use it. Export (8) writes vCard 3.0 or 4.0, always with photos: the ticked contacts when the
selection mode has any, else the contacts shown in the list (all of them when no search or label is active); "Share
as vCard" in a contact's detail writes that one contact to `<display name>.vcf` after the same password step. The
selection mode of 4.3 is a **Select** toggle button in the pane header (on phone and desktop alike, instead of a
long-press, which has no keyboard or screen-reader route) that adds a checkbox (`aria-label="Select <name>"`) to every
row; the Export button then reads "Export N selected". The ticks are kept in memory only and are cleared by "Done",
lock and sign-out. Bulk delete and bulk label on that selection, the CSV format and the photo checkbox are not built:
they are outside the import/export task.

### 7.10 Find duplicates in the Contacts tab (built; the import step must reuse it)

Independent of the import. The **Find duplicates** button in the pane header opens a dialog (`contacts-duplicates.js`);
the matching and the merge result are pure functions in `contacts.js` (`findDuplicateGroups`, `mergeChoices`,
`planMerge`, `restorePatch`), so the import-time step of 7.4 calls the same code instead of its own.

**Matching** (everything is hashed, so 2000 contacts take tens of milliseconds). Where this differs from 7.4, this
section is what the code does, and the import step should adopt it:

| Match | Rule | Group kind |
| --- | --- | --- |
| Email | NFKC, trimmed, `mailto:` removed, lower-cased; equal. No Gmail dot or `+tag` folding. | exact |
| Phone, same form | Spaces, dashes, dots, brackets and every other non-digit are ignored; at least 6 digits; a leading `00` counts as `+`. `+31 6 1234 5678` = `0031(6)12345678`. A number without `+`, `00` or a leading `0` (no country information) matches only the same digits. | exact |
| Phone, national against international | `0612345678` matches `+31612345678` only when it is unambiguous: the national number without its single leading `0` must be what an international number has behind a country code of 1 to 3 digits, **and exactly one** such international number exists among the contacts. With two candidates (`+31612345678` and `+32612345678`) the national number matches neither. This is stricter than the "last 9 digits" rule of 7.4, which would link both. | exact |
| Name | Given, additional and family name (or the formatted name when there are no parts), NFKC, case and accents removed, whitespace collapsed, words sorted so `Jan Visser` = `Visser, Jan`. A contact without a name of its own has none. | possible |

Groups are connected components: A and B sharing an email and B and C sharing a phone make one group of three. A
contact that is in an exact group is not offered again in a name-only group (after merging, run Find duplicates
again). Unlike 7.4 inside one file, contacts in the vault that share only a family landline are grouped (as exact) and
the owner decides in the review.

**Review.** Per group: heading with the names, the reason ("Matched on same email address: ...", or "Possible
duplicate, same name only"; name-only groups have a dashed border), the contacts side by side as cards (picture or
initials, name, organisation, phones, emails, number of filled fields), a radio per card "Keep this one" (default: most
filled fields, then oldest), and the buttons **Merge**, **Remove duplicates**, **Not duplicates**, **Skip**. At most 20
groups are drawn at once; the next appear as these are dealt with. A name-only group is never pre-selected for
anything: it is not part of **Merge all exact matches**, and no choice is made for it before the owner presses a button.

| Action | Effect |
| --- | --- |
| Merge | The kept contact is updated with the merge result and the others are deleted through `NotesStore.removeContact` (the normal delete path, so sync and other devices follow). |
| Remove duplicates | The selected contact is not touched; the others are deleted. |
| Not duplicates | The group key (the sorted uuids) is remembered in memory until lock or sign-out; the group is not shown again, also after closing and reopening the dialog. A group with a new member is a new group. |
| Skip | Hidden until the dialog is closed. |
| Merge all exact matches | Only email and phone groups, each with its default keeper and default choices, behind a confirmation that states the number of groups and contacts ("4 contacts ... become 2"). A group whose result would not fit in one contact is left alone and counted. |

**Merge result** (`planMerge`; nothing is lost, or the merge is refused). Every distinct phone, email, address, URL, IM
handle, date, group label and unknown imported field (2.4) of all contacts is kept. "Distinct" means: phones by the
normalised number above (so a number written two ways is kept once, as the kept contact wrote it), emails
case-insensitively, URLs by scheme, host (case-insensitive), path without trailing slash, query and hash, addresses by
their folded parts, IM handles by service and value, dates by type and value, labels case-insensitively. Notes of all
contacts are joined with a blank line, an identical note once. `favorite` is true when any contact was a favourite.
Single-value fields (name, organisation, job title, nickname, birthday, picture): when the contacts hold different
non-empty values, the screen shows a select per field (each option says which contact it comes from) and the kept
contact's value is the default; an empty value is filled from another contact. A birthday that lost stays as a date of
type "other". `extra`: `vcard` lines are appended, identical lines once, and a property group (`item5`) that clashes with
another contact's gets a new name so label pairs stay together; `csv` and `ldif` keys are added, a key with a different
value is kept as `key (2)`; other keys: the kept contact's wins. If the result would exceed a limit (more than 50 entries
in a list, more than 20 labels, `extra` or the contact over its size, the photo) the merge is refused with a message
and nothing is saved or deleted.

**Undo.** One level: the last merge, remove or merge-all. It restores the kept contact's fields and recreates the
deleted contacts with the same content (they get new vault ids, as with Undo of a delete). It is kept in memory only,
and dropped when the dialog is closed, on lock and on sign-out; the Undo button is in the dialog footer. Edit clocks
(`fc`) of restored fields are new, so on other devices the restored state wins over the merge.

**"Merge with..."** on a contact's detail opens the same dialog with a search field for the second contact, then shows
that pair as one group with the same choices (no detection involved).

**Accessibility and layout.** A modal dialog like the others (focus moves to the first group heading, Escape and the
backdrop close it, focus returns to the opener); every group is a `section` labelled by its heading; the radios are
native radios in a `radiogroup`; each button's accessible name includes the group's names; results are announced in a
`role="status"` line. The cards wrap, so the layout holds at 390 px and at 1280 px. All contact text is set with
`textContent`.

## 8. Export

Entry point: **Export** in the Contacts pane (all contacts, or the selected
contacts, or one contact from its detail "Share as vCard"). Exports are made in
the browser from decrypted in-memory contacts and saved as a download
(`URL.createObjectURL`, `a.download`, the same as the readable export,
`app.js:25350-25356`); no request is made.

### 8.1 Password step

Contacts are plaintext in the file, so the flow is that of the readable
export (`docs/IMPORT_EXPORT_SPEC.md` section 5; implemented with
`confirmAction(message, {title, confirmLabel, danger:true, verifyPassword,
wrongPasswordMessage})`, `app.js:25318-25333`):

1. Warning text: "This file is not encrypted. Anyone who gets it can read
   your contacts. Your vault password does not protect it. Everything is built
   on this device; nothing is sent to the server. Type your vault password to
   continue." with the count ("248 contacts will be exported").
2. The password is typed again and checked in the browser by
   `NotesStore.verifyVaultPassword` (`store.js:6285`); a wrong password shows
   "Wrong password. Nothing was exported." and nothing is built; after three
   wrong attempts the dialog closes; the field is cleared whatever the
   outcome. No request to the server.
3. The format is chosen **before** the password step in the same dialog
   (radio: vCard 4.0, vCard 3.0 (default, widest compatibility), CSV) and,
   for vCard, a checkbox "Include photos" (default on).
4. After the download starts one toast: "Unencrypted export saved. Delete it
   when you are done." Cancelling at any step creates no file. An empty
   address book produces no file and says so. The same action twice builds two
   files and asks for the password twice.

(An imported **single** contact "Share as vCard" uses the same dialog: sharing
is still plaintext leaving the vault.)

### 8.2 vCard writer (4.0 and 3.0)

- Line ending CRLF; every line folded at **75 octets** (UTF-8 bytes) with CRLF
  plus one space, **never inside a multi-byte character**; values escaped (`\\`,
  `\;`, `\,`, newline as `\n`; in 3.0 and 4.0 `;` and `,` are escaped in text
  values and the component separators of `N`, `ADR`, `ORG` are not).
- One `BEGIN:VCARD` ... `END:VCARD` per contact, all in one `.vcf` named
  `deeperguard-contacts-YYYY-MM-DD.vcf` (one contact: the display name,
  sanitised as the readable export names its files, `readable-export.js`).
- Order: `VERSION`, `PRODID:-//Deeperguard//Contacts 1//EN`, `UID`, `FN`, `N`,
  `NICKNAME`, `ORG`, `TITLE`, `PHOTO`, `TEL`, `EMAIL`, `ADR`, `URL`, `IMPP`,
  `BDAY`, `ANNIVERSARY`, `NOTE`, `CATEGORIES`, then the `extra.vcard` entries in
  their original order and groups, then `REV` (from `updated_at`).
- `FN` is `name.formatted`, or built from the parts (prefix given additional
  family suffix) if cleared; `N` always has five components. A contact with
  only an organisation gets `FN` = organisation and `N:;;;;`  (4.0 allows an
  empty `N`; 3.0 requires one, so `N` is written empty there too).
- Types: 3.0 `TEL;TYPE=CELL,PREF:`; 4.0 `TEL;TYPE=cell;PREF=1;VALUE=uri:tel:+...`
  (a phone that cannot be made a valid `tel:` URI is written with
  `VALUE=text`). `custom` labels are written the Apple/Google way for both:
  `item1.TEL:...` + `item1.X-ABLabel:Thuis kantoor` (group numbers start at 1 per
  card). Built-in types are written as `TYPE=` words.
- `ADR` has seven components; the formatted `LABEL` is not written.
- Photo: 3.0 `PHOTO;ENCODING=b;TYPE=JPEG:<base64>` (folded); 4.0
  `PHOTO:data:image/jpeg;base64,<base64>`.
- Birthday: `1984-03-09`, or `--0309` in 3.0 / `--03-09` in 4.0 for no-year;
  Apple's `1604` trick is **not** written, because every current reader reads
  `--MMDD` (4.0 reader; the 3.0 `--MMDD` form is the common extension).
  Unknown-year in 3.0 is therefore the one place where compatibility is not
  perfect and this is stated in the export dialog's help text.
- Round trip (tests 8-4 to 8-6): importing the file written by the exporter
  gives contacts equal to the originals (all model fields, `extra.vcard`, labels,
  `uid`) except `updated_at`, `created_at` and the re-encoded photo bytes.

### 8.3 CSV writer

- **Dialect: Google Contacts CSV (current)** (6.2): the most widely accepted
  column set (Google, Outlook import wizards and Thunderbird map it, Proton
  imports it). The header carries the maximum number of `E-mail n`, `Phone n`,
  `Address n`, `Website n` groups present among the exported contacts (at least 1).
  Labels in the cell joined by ` ::: `. UTF-8 **with BOM** (so Excel opens it
  as UTF-8), CRLF line ends, every field quoted when it contains `,`, `"`, CR
  or LF.
- **Lossy by design**: `extra` (unknown fields) and IM handles beyond the
  Google columns are not in the CSV; the export dialog says "CSV loses some
  fields; use vCard for a complete export". The vCard export is the lossless
  one.

### 8.4 CSV formula injection

A spreadsheet treats a cell that starts with `=`, `+`, `-`, `@`, TAB or CR as
a formula (OWASP "CSV injection"). A contact name or note of `=HYPERLINK(...)`
would run when the user opens the exported CSV in Excel or Sheets. Defence:
for every text cell whose first character is one of `= + - @` TAB CR, the writer
**prefixes a single quote `'`**; this includes phone numbers that begin with `+`
(`'+31 6 12345678`; a spreadsheet shows the quote only as a text marker).
The importer strips a leading `'` that is followed by one of those trigger
characters (6.3.1), so a CSV written by us and read by us is unchanged. The
vCard writer needs no such rule (no spreadsheet) but still escapes per 8.2.
Tests 8-7 to 8-9.

## 9. Threats

### 9.1 What the server learns, and what it cannot

**The server learns** (the same as for notes, and nothing more because contacts
are ordinary items):

- That the account stores N items, their uuids, the sizes of their
  ciphertext, their hashes, their `deleted` flag and `updated_at` times, from
  `items` (`app/db.py:90`) and the push log line (`api_sync_push`: user id,
  item counts, outcome counts, request bytes, duration).
- It **cannot tell a contact from a note**: the type is inside the ciphertext
  (1.2). But a bulk import is visible as a **burst of many small pushes**
  (a 3,000-contact import is about 3,000 items of 0.6 KB each, in some
  batches, within a minute or two), and a photo makes an item about 20 KB; a
  server operator could guess "an address book import". This is a metadata
  leak that cannot be removed without padding every item; it is not padded
  (the same as any other bulk import) and is written down here and in
  `PRIVACY.md` (build task).
- The sizes of individual contacts, roughly (a contact with a photo is much
  larger than one without).
- Which contact was edited when (a row's `updated_at`), and that it was
  deleted (tombstone), but not what changed.

**The server cannot see**: names, numbers, e-mails, addresses, birthdays,
notes, photos, labels, favourites, group membership, the import file, its
name, its format, the column mapping, the duplicate decisions, the search text,
what was tapped (`tel:`, `mailto:`, copy). None of those is ever put in a
request, a URL, a header or the sync log.

**Imported files never leave the browser.** The importer reads the `File` object
and holds the text in memory. It performs no `fetch`, no `XMLHttpRequest`, no
`navigator.sendBeacon`, no image `src` pointing off-origin, and does not open
the file's URLs (photo URLs, `LDIF :<` URLs, links in notes are all left alone).
Test 9-1 records every request during an import in Chromium and asserts that
the only requests are same-origin `/api/sync/*` pushes whose bodies contain
none of the plaintext of the file (a unique marker string in every field).
The export is built locally as well (test 8-10 asserts the same).

### 9.2 HTML and script in fields

Every value from a file is untrusted text. Rendering: `textContent`, `value`,
`setAttribute` for attributes; **never `innerHTML`** with file data (the
2FA import states the same rule, `docs/2FA_IMPORT_SPEC.md` intro). A name
like `<img src=x onerror=alert(1)>` is shown as that literal text. `href`
values are built only from the sanitised `tel:`/`mailto:` forms (4.4) or an
`http(s)` URL; `javascript:`, `data:` and `vbscript:` are shown as text. The
page's Content-Security-Policy has no `unsafe-inline` for scripts (a nonce is
used, `app/auth.py:1145` area), so an injection would also be blocked there;
that is the second layer, not the first.

### 9.3 Huge files and decompression-bomb style photos

- File size is checked before reading (7.8). There are no archives in v1, so no
  zip bomb: `.zip` and `.xlsx` are refused by content sniffing (7.1). If a ZIP
  import is ever added it must follow `docs/IMPORT_EXPORT_SPEC.md` 4.2.
- **Photos**: base64 text can expand 33% and a small file can decode to a huge
  bitmap ("pixel bomb", a PNG of 30,000 x 30,000 px compresses to a few KB).
  Defence: before decoding, the image header is read from the bytes
  (PNG IHDR, JPEG SOF, GIF logical screen, WebP VP8/VP8L/VP8X header, BMP
  header) and the width and height are checked: refused above 16 megapixels or
  above 8,192 px on a side, and above 3 MiB decoded bytes; only then
  `createImageBitmap` is called. The bitmap is scaled straight to 192 px
  (`createImageBitmap(blob, {resizeWidth, resizeHeight, resizeQuality})` where
  supported, so the full-size bitmap is not even materialised) and
  closed (`bitmap.close()`). Animated GIF/WebP use the first frame. SVG is
  **not** accepted as a photo (script and external references). At most 4
  photos are decoded at the same time.
- The decoded size total for one import is capped: 400 MiB of original photo
  bytes per import; beyond that the remaining photos are dropped with
  "photos skipped: too much photo data in one import".
- **Base64** values are decoded with a strict decoder over the allowed
  alphabet, in chunks, after the length is checked (`length x 3/4` against the
  3 MiB limit); a line of 60 MiB of `A` in a vCard is refused before any
  decode.

### 9.4 Prototype pollution and other hostile structure

- Every map built from file data (`extra.csv`, `extra.ldif`, vCard parameter
  maps, jCard objects) is a `Map` or an `Object.create(null)`; keys `__proto__`,
  `constructor` and `prototype` are dropped and counted as a warning; no
  recursive "merge" or "extend" helper is applied to file data (merging two
  contacts in 7.4 copies known fields by name). jCard uses a `JSON.parse`
  reviver that removes those keys (6.5.1), and the result is copied into
  fresh objects through a whitelist of property names.
- CSV headers are used as **values** in a `Map`, never as property names of an
  ordinary object: a header `__proto__` is just a column named that.
- Depth: jCard nesting at most 32 levels. A vCard has no nesting (6.1.1 step
  7). LDIF has none.
- Regular-expression safety: parsers use hand-written scanners and anchored
  patterns with no nested quantifiers; the 60 s watchdog (7.8) is the backstop.
- Duplicate or hostile headers (500+ columns, the same header 10,000 times)
  hit the column limit (7.8).

### 9.5 Formula injection (CSV export)

See 8.4. Also: the **import** never evaluates anything; a cell `=cmd|' /C calc'!A0`
is stored as text and shown as text.

### 9.6 Other

- **Clipboard**: copy puts one value on the clipboard on a user gesture, using
  the existing helper (`clipboard-sensitive.js:62`); contacts are not "sensitive
  codes", so no automatic clearing is added (stated here; the 2FA copy has that
  special treatment).
- **Telephone and mail links**: a `tel:` or `mailto:` link is a handoff to the
  operating system on a user tap; the app does not read what happens next.
- **Screenshots/exports left on disk**: the export warning (8.1) names this;
  the app cannot delete a downloaded file.
- **Shared devices**: contacts are in the same vault, locked by the same vault
  lock as notes (`docs/LOCK_SPEC.md`); the list is cleared on lock (3.2).
- **Third-party libraries**: none. The parsers, the CSV reader, the QP and
  base64 decoders and the vCard writer are written in the repo (no npm
  dependency), so there is nothing to vendor or pin for this feature.
- **Logs**: no console output of contact data, file names or counts (as
  `docs/IMPORT_EXPORT_SPEC.md` section 5 requires for exports); errors name the
  card or row number, never its content.

## 10. Build order (for the follow-up tasks)

1. `contacts.js`: model helpers, display name, sort key, search, merge, with
   node tests (11.1, 11.2 case 3-3, 11.4).
2. Store functions + tab shell (list, empty state, add/edit/detail), plus
   `resolvePushConflict` branch and offline/backup tests (11.2, 11.3).
3. vCard reader (6.1) + photo pipeline, with the samples of 6.1.3 to 6.1.9 as
   fixtures.
4. CSV reader + the named dialects + mapping step (6.2, 6.3).
5. LDIF and jCard (6.4, 6.5).
6. Import dialog, duplicates, result and undo (7).
7. Exports and the password step (8).
8. `PRIVACY.md`, help text, backup description updates (3.6).

Status of the tab shell (step 2): built are the tab between Agenda and 2FA, the
list with alphabet sections and a Favourites section, label chips, search (4.3,
4.6, 5.1), detail with `tel:`/`mailto:` links and copy (4.4), the edit form
with phone, email, address and website rows, photo, labels, favourite (4.5),
delete with confirmation and undo, and clearing on lock. Not built yet, and
deliberately left to the follow-up tasks: the Import and Export buttons and the
empty-state "Import" (steps 3 to 7: there are no parsers yet, so a button would
do nothing), the windowed list, the letter rail and "Jump to letter" dialog,
selection mode, label rename/delete, the browser Back key (the detail view
closes with the Back button and Escape; the other tabs do not use history
either), and the form rows for messaging addresses, dates and the extra name
fields (the form leaves those stored values untouched). The list refreshes when
the tab is shown, after unlock and after the user's own changes; changes pulled
from another device appear the next time the tab is shown.

Open decision for the owner, not blocking the build: whether Contacts should
be limited to a plan (this spec says no, 4.1).

## 11. Test cases

Every case below must become an automated test in the build tasks. "Node"
means a `tests/test_*.js` run with `node`; "Browser" means a Playwright script
in `tests/e2e_*.py` using the helpers of `tests/e2e_keep_import_button.py`
(register, `complete_recovery_key_step`, `set_input_files` on the hidden input),
at 1280x800 and 390x844 where it says so. A test must assert on results (parsed
values, stored items, DOM, requests), and must fail when the feature is
removed.

### 11.1 Data model (section 2)

- **2-1** (Node) A contact built from the 2.2 example has exactly the fields of
  that example; unknown top-level keys of a stored contact survive
  `updateContact` (read, edit one field, write, read: nothing else changes).
- **2-2** (Node) Display name rules of 2.3: `formatted` only; parts in both
  display orders; organisation only; email only; phone only; nothing ("No name").
- **2-3** (Node) Sort key and initials (4.3: first character, NFD, combining
  marks removed, upper-cased): `Éva` sorts under `E`; `Ørsted` under `Ø`
  (it has no decomposition, so it stays its own letter); `123 Taxi` and
  `+31...` under `#`.
- **2-4** (Node) Caps: 51 phones keep 50 and report 1 dropped; a 25,000-character
  note is cut to 20,000; 21 labels keep 20; a contact over 128 KiB is refused.
- **2-5** (Node) `extra` round trip: a contact with `X-ABRELATEDNAMES` and
  its `X-ABLabel` (group `item5`) stores both and the vCard writer emits both
  with group `item1` renumbered; unknown CSV column `Hobby` stored under
  `extra.csv.Hobby`.
- **2-6** (Node) Types: 3.0 `TEL;CELL;PREF` and `TEL;TYPE=iphone` both give `mobile`;
  unknown type word `satellite` gives `custom` with label `satellite`.
- **2-7** (Node) Dates: `1984-03-09`, `19840309`, `--0309`, `--03-09`,
  `1604-03-09` with `X-APPLE-OMIT-YEAR=1604`, `1984-13-40` (kept in `extra`,
  warning).
- **2-8** (Node) `PHOTO` as a URL is not fetched: with a stub `fetch` that
  throws, importing a `PHOTO;VALUE=uri:http://x/y.jpg` card never calls it and
  keeps the URL in `extra`.

### 11.2 Storage and sync (section 3)

- **3-1** (Node, in the style of `tests/sync_harness.js`) A contact item is pushed as a
  ciphertext row whose JSON contains none of the strings of the contact
  (name, phone, photo bytes in base64): scan the pushed body for every field
  value.
- **3-2** (Browser) Register, create a contact, reload, unlock: it is there;
  with the network blocked (`context.set_offline(True)`) create and edit
  another contact, go online and check the server stores 2 contact rows
  (decrypt in the page and count by `content.type === 'contact'`).
- **3-3** (Node) `NotesContacts.mergeContacts` with: only one side edited a
  field (take it); both edited different fields (both kept, no copy); both
  edited the same scalar differently (newer wins, copy requested with
  `conflict_of`); list additions on both sides (union by `id`); a deletion vs
  an edit (edit wins); identical contents (no change, no copy).
- **3-4** (Browser, two contexts) Two devices edit the same contact offline,
  one the phone number and one the address, both go online: the final contact
  has both changes and there is no "(conflict copy)" contact. Then both edit
  the note differently: the final contact has the newer note and one conflict
  copy exists with the other note.
- **3-5** (Browser) Photo pipeline in Chromium (Playwright `page.evaluate`):
  a 3000x2000 JPEG (generated on a canvas) becomes a 192x192 JPEG of at most
  12,288 bytes with no EXIF (no `Exif` marker in the bytes); an RGBA PNG with a
  transparent background becomes an opaque JPEG; a JPEG with orientation 6
  comes out upright (compare a pixel); an image that cannot get under the cap
  is dropped and reported.
- **3-6** (Node) Backup: `buildLocalBackup`-style rows (use the store's own
  functions) for a vault with 3 notes and 5 contacts contain 8 rows, and a
  restore through `importBackup` into an empty vault gives the same 5
  contacts field by field.
- **3-7** (Browser) Locked vault: lock, the Contacts list is empty and Add and
  Import are disabled; unlock: list back. `importContacts` called while locked
  rejects with the "Unlock the vault first" error and writes nothing.
- **3-8** (Browser) A vault with a `contact` item opens in the previous
  client build's code path unchanged: `listNotes()` does not contain the
  contact and the notes list renders the same number of rows as without it.
- **3-9** (Node) The server code path is unchanged: pushing a contact row to
  `/api/sync/items` returns `ok`, and a second push with a stale `base_rev`
  returns `conflict` (the existing server contract, `tests/` for sync).

### 11.3 UI (section 4)

- **4-1** (Browser, 1280 and 390) Tab order in `.app-tabs` is Notes, Agenda,
  Contacts, 2FA by reading the DOM text; clicking Contacts shows
  `#contacts-pane`, hides the notes shell and the other panes, sets
  `aria-selected="true"` on exactly that tab, `aria-controls` points to an
  element that exists; reload restores the Contacts tab.
- **4-2** (Browser, 390, 360, 320) Every tab label is fully visible: for each
  `.app-tab`, `scrollWidth <= clientWidth` and no two tabs overlap; tap height
  at least 44 px.
- **4-3** (Browser) Empty state text is shown with no contacts, the no-result
  text for a search with no match, and the locked text when locked.
- **4-4** (Browser) 300 contacts created through the store: the list is
  grouped under letter headers in order `A..Z`, `#`; the DOM holds far fewer rows
  than 300 (windowing: fewer than 60); scrolling to the end renders the last
  contact; `aria-setsize`/`aria-posinset` are set.
- **4-5** (Browser, 1280) Two-pane layout: selecting a row shows the detail
  beside the list, `aria-current="true"` on the row. (390) selecting a row
  replaces the list with the detail, the Back button and Escape return to the
  list with the same scroll position.
- **4-6** (Browser) Detail actions: the phone's link `href` is exactly
  `tel:+31612345678` for `+31 (6) 12 34 56 78 ext. 12`; no link for a value
  with no digits; the email link is `mailto:` with an encoded address; an
  address that is not a plausible email gets no link; a `javascript:alert(1)`
  website is rendered as text with no `href`; Copy puts the value on the
  clipboard (permission granted in the test).
- **4-7** (Browser) During all of 4-6 and the whole session no request leaves the
  origin and no request to a map, avatar or lookup host is made
  (`page.on('request')`).
- **4-8** (Browser) Edit form: required field rule (Save with nothing is
  refused, `aria-invalid`, `role="alert"` text); add and remove a phone row;
  custom type reveals the label input; Save twice quickly writes one change;
  Cancel with changes asks and keeps the data when declined.
- **4-9** (Browser) Keyboard only: Tab reaches the tabs, Add, Import, Export,
  search, the list rows (Enter opens), the star toggles with Space and exposes
  `aria-pressed`; focus is visible (computed outline or box-shadow is not
  `none`) on each; Escape closes the import dialog and returns focus to the Import
  button; the letter-jump dialog traps focus.
- **4-10** (Browser) Labels: filter chip shows counts; renaming a label changes
  it on every member; deleting it leaves the contacts; the confirm names the
  count. Favourites: star moves the contact into the Favourites section and
  the filter.
- **4-11** (Browser, light and dark) Contrast: initials on every avatar colour
  have at least 4.5:1 in both themes (computed from the actual colours), the
  muted second line has at least 4.5:1, and focus rings are visible in both.
- **4-12** (Browser) Screen reader names: `aria-label`s contain the contact name
  ("Favourite: Eva Bakker", "Call Eva Bakker, mobile"); the search result
  count is in a `role="status"` element; the photo `<img>` has `alt=""`.
- **4-13** (Browser, 390) No horizontal scroll in list, detail, edit form and
  import dialog (`document.documentElement.scrollWidth <= innerWidth`).

### 11.4 Search (section 5)

- **5-1** (Node) `filterContacts`: `jose` finds `José`; `muller` finds `Müller`;
  `eva bakker` and `bakker eva` find the same; digits `0612` find
  `+31 6 12 34 56 78`; `label:werk` and `is:favorite`; the note and a city are
  searched; a name starting with the query ranks first; an unknown
  `X-FOO` extra value is **not** found.
- **5-2** (Browser) Typing in the Contacts search filters live and announces the
  count; clearing restores the full list; the text is in none of
  `localStorage`, `sessionStorage` (except the tab name), the URL or IndexedDB
  plaintext.
- **5-3** (Browser) Global search: with contacts present, typing a contact's
  name into `#search` on the Notes tab shows no contact; the placeholder text is
  unchanged ("Search notes and scanned documents").
- **5-4** (Node) Benchmark (not a pass/fail on speed in CI; prints times): 10,000
  contacts filtered in under 100 ms on the CI machine, recorded in the test
  output; fails only above 500 ms.

### 11.5 Import formats (section 6)

Each of these is a node test with the sample of the section as a fixture,
asserting the "Expected" text of that section. Fixtures that are not UTF-8 are
written with the codec named (`cp1252`, `latin-1`) so the bytes are real.

- **6.0-1** BOM UTF-8, UTF-16 LE with BOM, UTF-16 BE with BOM, UTF-16 LE
  without BOM, strict UTF-8, Windows-1252 fallback each decode `Müller`
  correctly; the override select re-parses; a NUL byte in the first 4 KiB of
  a "text" file is refused.
- **6.1-1** Line endings CRLF, LF and CR all parse the same card.
- **6.1-2** A 70,000-character folded `NOTE` (folded at 75 octets, 1,000 folds)
  unfolds to the exact original; a fold in the middle of a UTF-8 multibyte
  character (fold between the two bytes) is joined before decoding.
- **6.1-3** The Outlook/Android 2.1 sample (6.1.3): both cards, soft breaks,
  `ISO-8859-1`, base64 photo with folded line and empty line, salvage warning.
- **6.1-4** The Apple sample (6.1.4) with every expected value.
- **6.1-5** The Google sample (6.1.5): PNG bytes labelled JPEG are accepted.
- **6.1-6** The Android sample (6.1.6).
- **6.1-7** The Outlook sample (6.1.7): one address, not two.
- **6.1-8** The Nextcloud 4.0 sample (6.1.8).
- **6.1-9** The Proton sample (6.1.9); marked as depending on a real export.
- **6.1-10** Many cards: a file with 2,000 cards, mixed 2.1 / 3.0 / 4.0, parses to
  2,000 contacts in order; a card in the middle with garbage lines does not
  stop the others and is reported by index.
- **6.1-11** A `PHOTO` of 20 MB of base64 `A` is refused before decoding; a
  photo with a wrong signature is dropped with a warning; a valid 1x1 PNG is
  stored (re-encoded JPEG 192x192 or the minimum).
- **6.1-12** Escapes: `\n`, `\N`, `\,`, `\;`, `\\` in 3.0; a literal `\n` in
  2.1 stays; `N:Smith\; Jones;Anna` keeps the semicolon in the family name.
- **6.1-13** `KIND:group` with `MEMBER:urn:uuid:` of two imported contacts
  creates one label on both; with no matching members it is skipped and
  listed.
- **6.2-1 to 6.2-6** The six CSV samples (Google, older Google, Outlook,
  outlook.com with BOM, Thunderbird, Yahoo), each with its expected values;
  6.2-3 also asserts the encoding label and the file-wide date order, plus the
  ambiguous-date prompt when no row decides (a variant fixture).
- **6.2-7** Header recognition ignores case and surrounding spaces and a BOM;
  a Google file with 6 phone groups maps all six.
- **6.2-8** An Outlook CSV with Dutch headers is recognised through the
  translation table.
- **6.3-1** Delimiter detection for `,` `;` tab `|` and `sep=;`; a one-column
  file; a file where a quoted field contains a delimiter.
- **6.3-2** Quoted newline (CR, LF and CRLF) kept as LF; `""` unescaped; an
  unterminated quote at the end of the file yields the warning; a record with
  too many fields reports the surplus.
- **6.3-3** The semicolon Windows-1252 sample (6.3.3) with its expected values.
- **6.3-4** Mapping step in the browser: unknown headers are suggested from the
  synonym table; mapping two columns to one single-value target is refused
  with the Import button disabled; the preview table updates live.
- **6.3-5** A cell starting with `=`, `+`, `-` or `@` is imported as typed;
  `'=1+1` (our export) loses its `'`.
- **6.4-1** The LDIF sample (6.4.1): two contacts, one skipped record with the
  reason, fold, base64 `cn::` and `dn::`.
- **6.4-2** `attr:< file:///etc/passwd` is skipped with a warning and nothing is
  read; a `jpegPhoto::` photo is accepted; a Latin-1 LDIF is decoded.
- **6.5-1** The jCard sample (6.5.1): `({}).polluted` and `({}).x` are
  `undefined` afterwards; a deeply nested array (40 levels) is refused;
  `["vcard"]` without a body and a non-jCard JSON file are refused with the
  messages.
- **6.6-1** An `.xlsx` and a `.zip` file (real bytes starting `PK`) are refused
  with the "export as vCard or CSV" message.

### 11.6 Import flow (section 7)

- **7-1** (Browser) Choose a 3-card vCard with one card matching an existing
  contact by email: the preview shows "3 found", the duplicate with its reason
  and "Skip" selected; Import gives the summary with the right counts; nothing
  is in the vault before Import (count of contact items is unchanged while the
  preview is open).
- **7-2** (Browser) Duplicate detection: same email; same phone in a different
  format (`0612345678` vs `+31 6 12345678`, marked "probably"); same name only
  (defaults to Keep both); two people sharing a landline in one file are not
  merged; a Gmail address with a dot is not folded.
- **7-3** (Browser) Merge: existing contact with a mobile only, incoming with the
  same email plus an address and a note: after Merge the contact has both, its
  existing fields are unchanged, a second Merge of the same file changes nothing.
- **7-4** (Browser) Keep both creates a second contact; Skip imports none.
- **7-5** (Browser) Undo: after an import with created and merged contacts,
  Undo import removes the created ones and restores the merged ones to the exact
  earlier content; a created contact edited after the import is kept and
  reported; after closing the dialog the Undo is gone but the "Imported on ..."
  filter exists.
- **7-6** (Browser) Same file twice: the second import reports 0 new and all
  skipped.
- **7-7** (Browser) Limits: a file one byte over 64 MiB is refused before it is
  read (assert `arrayBuffer` is not called by stubbing on the `File`); 10,001
  cards are refused with the count; a quota too small disables Import with the
  message.
- **7-8** (Browser) Cancel during parsing of a large file stops, writes
  nothing and closes cleanly; Escape is ignored while writing.
- **7-9** (Browser) Offline import writes locally and, once online, the rows reach
  the server (count them).
- **7-10** (Browser, 390 and 1280) Import dialog usable by keyboard, focus
  trapped and returned, the status line is announced (`role="status"`), no
  horizontal scroll, light and dark.
- **7-11** (Browser) Several files in one selection (one vCard, one CSV, one
  bad `.xlsx`) give one preview with the bad file listed and the others
  importable.
- **7-12** (Browser) Import with the 2 MB vCard of 500 contacts: the page stays
  responsive (a `requestAnimationFrame` counter keeps ticking during the parse).

### 11.7 Export (section 8)

- **8-1** (Browser) Export asks for the password; a wrong one shows the error
  and downloads nothing (`page.expect_download` times out); the right one
  downloads once; after three wrong attempts the dialog closes; the password
  field is empty after closing.
- **8-2** (Node) vCard 3.0 and 4.0 writers: CRLF, folding at 75 octets, no fold
  inside a multi-byte character, escapes, `N` with five components, photo form,
  custom label as `itemN.X-ABLabel`.
- **8-3** (Node) A contact with a `\n` note, a `;` in the name and an emoji
  produces a file that this spec's own reader (6.1) reads back equal.
- **8-4** (Node) Round trip vCard 3.0: import the 6.1.4 sample, export, import:
  equal on all model fields and `extra.vcard`.
- **8-5** (Node) Round trip vCard 4.0 of the 6.1.8 sample, likewise.
- **8-6** (Node) Round trip of 500 generated contacts with random Unicode in every
  field, types and labels: equal.
- **8-7** (Node) CSV writer: header has the max groups; quoting of `,`, `"`,
  CR and LF; UTF-8 BOM; CRLF.
- **8-8** (Node) Formula injection: names `=1+1`, `+cmd`, `-2`, `@SUM(A1)`, a TAB
  and a CR lead are all written with a leading `'`; a phone `+31 6 12345678` is
  written as `'+31 6 12345678`; a normal name is not prefixed.
- **8-9** (Node) CSV round trip through our reader gives equal text fields
  including the ones that were prefixed.
- **8-10** (Browser) Export makes no network request; the downloaded file's text
  contains the contacts and **no** content from `extra` in CSV, and all of it
  in vCard.
- **8-11** (Browser) Empty vault: Export says there is nothing to export and
  no file is made.

### 11.8 Threats (section 9)

- **9-1** (Browser) Request log during a complete import (the 6.1.4 sample
  with a unique marker in every field): every request is same-origin, none to
  a photo URL, and the push bodies do not contain any marker text, base64 of a
  marker, or the file name.
- **9-2** (Browser) A name `<img src=x onerror="window.__x=1">`, a note
  `<script>window.__x=1</script>` and a website `javascript:window.__x=1`
  render as text, `window.__x` stays undefined after clicking everything, and
  no element with `onerror` exists in the detail DOM.
- **9-3** (Node) A 16,000 x 16,000 px PNG header (tiny file) is refused before
  `createImageBitmap` is called (stub counts calls); a 40 MB base64 photo is
  refused before decoding; an SVG photo is refused; a 4-frame GIF uses one frame.
- **9-4** (Node) Prototype pollution: jCard `__proto__`/`constructor` keys,
  a CSV header `__proto__`, a vCard parameter `__proto__=x`, an LDIF attribute
  `__proto__:x`: afterwards `Object.prototype` has no new keys and the contact
  data contains none of them as own keys of ordinary objects.
- **9-5** (Node) A 1 GB-claimed file (a `File` stub with `size = 2**30`) is
  refused; a 1,000,000-line vCard of empty lines parses within the watchdog or
  is refused with the time message and the page stays responsive.
- **9-6** (Node) Regular-expression safety: a 5 MB single-line value with
  thousands of `;` and `=` and quotes parses in under 2 s.
- **9-7** (Browser) The server learns nothing readable: after an import and
  edit, fetch every row of `items` for the user from the server's database
  directory used by the e2e server and assert that no row contains the plaintext
  marker strings (`grep` over the SQLite file bytes).
- **9-8** (Node) The sync log line for a contact push (captured from
  `_sync_log_line`) contains only the counts and sizes of the existing format.

## 12. What this spec decides that a reviewer may want to change

- One item per contact (2.1), labels as names inside contacts (2.2), photo
  inline at 192 px and 12 KiB (3.4), no plan restriction (4.1).
- A new field-level merge branch instead of the default "newer wins" (3.3);
  the one place that touches existing sync code.
- Contacts are not in the global search and not in the readable ZIP in v1
  (5.2, 3.6).
- CSV export is Google-dialect and lossy; vCard is the lossless export (8.3).
- The list of CSV headers (6.2) is from memory of each program and must be
  re-checked against real exports before each parser is called done (6.7).
