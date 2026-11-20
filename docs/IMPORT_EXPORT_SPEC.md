# Import and export: inventory, readable ZIP format, format mapping, threat model and confirmation flow

Status: design. Section 1 describes what exists today. Sections 2 to 5 describe
what the next tasks (readable export, Markdown import, ENEX import, Google Keep
import) must build. Nothing in sections 2 to 5 is implemented yet. This
document is the contract: code, tests, SECURITY.md/PRIVACY.md and in-app texts
are checked against it.

Hard rules that run through every section:

- **Zero knowledge stays intact.** Plaintext exists only in browser memory
  while the vault is open. Export and import never send note, agenda or 2FA
  content to the server. No new endpoint is needed or allowed.
- **Everything in the browser.** Parsing, unzipping, converting and zipping run
  client side. No request is made for any import or export file, and nothing
  referenced inside an imported file is ever fetched.
- **Import files are untrusted input.** They are parsed against the hard
  limits of section 4 and are shown as text, never executed.
- **Only build what is missing.** The encrypted `.dgbackup`, the single-note
  export and the Standard Notes import stay as they are (section 1). A gap
  found in them is listed in 1.6 and fixed by the task that touches it.

## 1. Inventory: what exists today

Checked in the code and in the running app: a local server was started with an
empty data directory, a throwaway account was registered in Chromium, and a
plain note, a PDF attachment with scan text, an agenda event and a 2FA account
were created. The two exports were clicked and their downloads read. The
stored shapes below are the real values from that run (secrets and ciphertext
left out).

### 1.1 What is exported today

| Piece | File and function | What it does |
| --- | --- | --- |
| Encrypted backup (`.dgbackup`) | `buildLocalBackup` (`app/static/js/app.js:25520`), `prepareEncryptedBackupBlob` (`app.js:24598`), `saveEncryptedBackupFile` (`app.js:24609`, button `#btn-save-backup-file`), `backupFilename` and `backupBlobFromObject` (`app/static/js/cloud-backup.js:192`, `:199`) | Download name `deeperguard-backup-YYYY-MM-DD.dgbackup` (UTC date). The file is one JSON document, **not** a ZIP: `{format: "deeperguard-backup-v1", user_email, kdf_salt, exported_at, items: [{item_uuid, content_version: 1, ciphertext, content_hash, deleted: false, updated_at}]}`. Every vault item (notes, tags, folders, attachments, the agenda pack, agenda tasks, 2FA accounts) is one row. `ciphertext` is the item's existing AES-GCM envelope `{v, iv, data}` and is only readable with the vault password. Observed: 7 items for the throwaway vault. The same blob goes to Google Drive, Dropbox, pCloud and email backups. |
| Restore of a `.dgbackup` | `NotesStore.importBackup` (`app/static/js/store.js:7211`), UI handler on `#restore-backup-file` (`app.js:25354`) | Merge or "add missing only", then a freshness reset prompt. The same function also takes the Standard Notes file. |
| Export of one note | `downloadNoteMarkdown` (`app.js:14039`), button `#btn-export-note` in Settings (`app.js:23955`, `app/templates/app.html:2148`), and the toolbar button through `downloadOpenNote` (`app.js:14051`) | Saves `# <title>\n\n<content>` as `<title>.md` (type `text/markdown`). The file name replaces every run of characters outside `[A-Za-z0-9_-]` by `-`. Observed: note "Layout plain note" downloaded as `Layout-plain-note.md` with content `# Layout plain note\n\nSynthetic body text for the layout test.` There is no front-matter, no tags, no dates and no attachments. A locked note is refused until it is unlocked. |
| Export of one attachment | `downloadAttachment` (`app.js:14072`) | Decrypts one attachment and saves the original bytes under its stored `filename`. |
| Export of the agenda | `exportAgendaToIcs` (`app/static/js/agenda.js:1119`), `NotesAgendaIcs.flattenEventsForIcsExport` (`app/static/js/agenda-ics.js:434`), `NotesAgendaIcs.buildIcsCalendarFromEvents` (`agenda-ics.js:461`) | Saves `deeperguard-calendar[-<calendar>]-YYYY-MM-DD.ics`. Writes UID, SUMMARY, LOCATION, DESCRIPTION (notes plus an "Attendees:" line), URL (https only), RRULE, exceptions and time zones. It writes **no VALARM**: reminders are not exported. |
| Export of 2FA accounts | none | There is no export of 2FA secrets today. |

### 1.2 What is imported today

| Piece | File and function | What it does |
| --- | --- | --- |
| Standard Notes import | `NotesSnImport.parse`, `convertSn`, `openBackupFile`, `unzip`, `zipStored` (`app/static/js/snimport.js:517`, `:317`, `:700`, `:648`, `:576`), `NotesStore.importBackup` (`store.js:7211`), `importSnFiles` (`store.js:7128`), `importLooseSnFiles` (`store.js:7166`); UI handler on `#import-file` (`app.js:25486`) | Accepts a **decrypted** Standard Notes backup (`.txt`/`.json`, `.zip` with attachment blobs, `.gz`). An encrypted one is refused with a message. Notes, tags (merged by title), file items, Super-note embedded files and pinned/starred/archived/trashed flags are converted. A `.dgbackup` goes through the same entry point. |
| ICS import | `NotesStore.importAgendaFromIcs` (`store.js:2334`), `NotesAgendaIcs.validateIcsFile` (`agenda-ics.js:527`) | Imports `.ics` into the agenda pack. |
| 2FA import (Aegis, 2FAS, Google Authenticator, otpauth links) | `app/static/js/totp-import.js`, specified in `docs/2FA_IMPORT_SPEC.md` | Separate spec. Not changed here. |
| Markdown (`.md` files and ZIP, including the section 2 export) | `NotesMdImport.parse` (`app/static/js/md-import.js`), `NotesStore.importMarkdownNotes` (`store.js`); UI handler on `#import-markdown-file` (`app.js`) | Implements 3.1 and the sanitising of 4.5 for Markdown. A summary is confirmed before saving and the result lists skipped files. |
| ENEX (`.enex`) | `NotesEnexImport.parse` (`app/static/js/enex-import.js`), stored through `NotesStore.importMarkdownNotes`; UI handler on `#import-enex-file` (`app.js`) | Implements 3.2 and 4.3. Output is Markdown only. A note whose ENML is not well-formed is skipped and listed; a DOCTYPE or entity declaration refuses the whole file. Each ENEX is parsed whole by `DOMParser`; the 80 MiB limit is checked per note after parsing. |
| Google Keep | `keep-import.js` | Takeout ZIP (`Keep/*.json`), built against sections 3.3 and 4. |

### 1.3 How a note is stored

A note is one vault item. Its plaintext is a JSON object that is encrypted
before it leaves the browser (`NotesCrypto.encryptObject`,
`app/static/js/crypto.js:114`). The default is `defaultNote`
(`store.js:1056`). Real value from the running app:

```json
{
  "type": "note",
  "title": "Layout plain note",
  "title_manual": false,
  "content": "Synthetic body text for the layout test.",
  "tags": [],
  "folder_id": "",
  "attachments": [],
  "revisions": [],
  "editor": "plain",
  "prevent_edit": false,
  "locked": false,
  "starred": false,
  "pinned": false,
  "archived": false,
  "trashed": false,
  "warn_at": "",
  "reminders": [],
  "created_at": "2026-11-18T14:32:32.782Z",
  "updated_at": "2026-11-18T14:32:32.783Z"
}
```

(`__fid` and `__fv` are freshness bookkeeping added by the store; importers do
not write them.)

- **The body is text, not HTML and not a custom block format.** `content` is a
  plain string. Its meaning depends on `editor`, which is one of `plain`,
  `markdown`, `checklist`, `super`, `superscript` and `code` (the values of
  `#editor-type` in `app.html`).
- `markdown`: CommonMark text. It is rendered at view time by
  `NotesMarkdown.render` (`app/static/js/markdown.js`), which runs markdown-it
  and then `NotesSanitize.sanitizeRichHtml` (`app/static/js/sanitize.js:185`),
  a DOMPurify allowlist. HTML is therefore never stored, only produced and
  cleaned when shown.
- `checklist` and `super`: one task per line as `- [ ] text` or `- [x] text`
  (`NotesChecklist`, `app/static/js/checklist.js:2`). `super` allows nesting by
  two spaces of indent per level (up to 6 levels).
- `plain`, `superscript`, `code`: the string is shown as typed.
- `tags` is a list of tag **item uuids**, not names. A tag is its own item
  (`defaultTag`, `store.js:1093`): `{type: "tag", title, color, created_at,
  updated_at}`. `folder_id` is the uuid of a `folder` item (`defaultFolder`,
  `store.js:1081`) or `""`.
- `attachments` is a list of attachment item uuids (1.4). `sn_pending_files`
  (set by the Standard Notes import) lists files the backup named but did not
  contain; it is removed when a file with the same name is attached.
- Item uuids are RFC 4122 v4 (`newUuid`, `store.js:1040`). Dates are ISO 8601
  UTC with milliseconds.

### 1.4 How attachments and scans are stored

An attachment is its own vault item, linked to its note by `note_id` and by
the note's `attachments` list (`defaultAttachment`, `store.js:1107`;
`NotesStore.addAttachment`, `store.js:5954`). Real value (file bytes left out):

```json
{
  "type": "attachment",
  "note_id": "<note uuid>",
  "filename": "layout-test.pdf",
  "original_filename": "layout-test.pdf",
  "mime": "application/pdf",
  "size": 629,
  "content_sha256": "b7856b02…c136d",
  "source_sha256": "",
  "file_enc": "<encrypted bytes, kept out of memory: file_enc_stored: true>",
  "ocr_text": "Synthetic layout test invoice 12345",
  "ocr_method": "client",
  "ocr_index": 60,
  "ocr_boxes": [],
  "created_at": "…",
  "updated_at": "…"
}
```

- The file bytes are encrypted in the browser with the vault key
  (`NotesCrypto.encryptBytes`, `crypto.js:138`) into `file_enc`. In memory the
  item carries `file_enc_stored: true` instead (`strippedAttachmentContent`,
  `store.js:1597`); `NotesStore.getAttachmentBytes` (`store.js:6268`) decrypts.
- The limit per file is `MAX_ATTACHMENT_BYTES` = 50 MiB (`store.js:3`).
- `addAttachment` throws when the same bytes (`content_sha256`) are already
  attached somewhere, unless `intentionalCopy` is set. Importers must catch
  this and link the existing attachment instead of failing the import.
- **A scan is an attachment.** The scan buttons (`#scan-camera`, `#scan-input`,
  handler `ingestPickedScanFiles`, `app.js:20499`) store the photo or PDF as an
  attachment and put the recognised text in `ocr_text` (`ocr_method`: `pending`,
  `client`, `index`, …; set by `NotesStore.setAttachmentOcr`, `store.js:6345`).
  There is no separate scan store.

### 1.5 Agenda items and 2FA items

**Agenda events** live inside one vault item, the *agenda pack* (fixed uuid
`a6da67da-67da-4000-8000-000000000001`, `AGENDA_PACK_UUID`, `store.js:1815`):
`{type: "agenda_pack", events: {<event id>: <event>}, deleted_events:
{<id>: iso}, calendars: {…}, updated_at}`. Written by `upsertAgendaEvent`
(`store.js:1909`), read by `listAgendaEvents` (`store.js:1895`). An event has
these fields (`agenda.js:2750`, `store.js:2301`):

| Field | Meaning |
| --- | --- |
| `type` = `agenda_event`, `version` = 1, `updated_at` | Bookkeeping. The event id is the map key and is added as `id` when listed. |
| `title`, `location`, `notes`, `color`, `webcall_url` | Text. `webcall_url` is https only. |
| `attendees` | List of strings. |
| `start`, `end` | ISO 8601 UTC. `all_day` (boolean). `source_tz` keeps the zone of an imported event. |
| `rrule`, `ics_exdates`, `ics_occurrence_overrides`, `ics_recurrence_id` | Recurrence as imported from or exported to iCalendar. |
| `ical_uid`, `imported_at` | Identity for re-import and de-duplication. |
| `reminders`, `scheduled_reminder_ids` | Reminder offsets and server reminder bookkeeping. Not part of the ICS export. |
| `calendarId` | Optional; empty means the default calendar (`DEFAULT_CALENDAR_ID`, `store.js:1958`). |

**Agenda tasks** are separate vault items (`type: "agenda_task"`,
`upsertAgendaTask`, `store.js:2101`; fields in `app/static/js/agenda-tasks.js`:
`title`, `due`, `due_time`, `done_at`, …). They are not in the ICS export.

**2FA accounts** are separate vault items (`addTotpAccount`,
`store.js:5152`; schema 2 through `NotesTotp.upgradeContent`,
`app/static/js/totp.js:693`). Real value from the run, secret hidden:

```json
{"type":"totp","issuer":"Ex","account":"a@b","secret":"<Base32>","host":"",
 "digits":6,"period":30,"algorithm":"SHA1","tags":[],"icon_id":null,
 "schema":2,"label":"a@b","created_at":"…","updated_at":"…"}
```

`secret` is normalised Base32. Adding a secret that already exists returns the
existing item. Full detail is in `docs/2FA_IMPORT_SPEC.md` section 1.

### 1.6 Gaps found while checking (not fixed by this document)

1. `downloadNoteMarkdown` strips every non-ASCII letter from the file name
   (`"Café"` becomes `Caf-`) and has no tags, dates or attachments. The
   readable export of section 2 replaces it for the full export; the
   single-note button may keep its current output until a task chooses to use
   the section 2 naming rules.
2. `NotesSnImport.unzip` (`snimport.js:648`) trusts the sizes in the ZIP
   headers and has none of the limits of section 4. The new importers must
   not reuse it as it is; section 4 defines the replacement.
3. The ICS export has no reminders and no agenda tasks.
4. Folders are not part of any readable export today.

## 2. Readable export: ZIP layout

Name: `deeperguard-export-YYYY-MM-DD.zip` (UTC date). Built in the browser with
the existing `NotesSnImport.zipStored` idea (stored or deflate, no server).
All text files are UTF-8 without BOM, line ends `\n`. All paths use `/`.

```
deeperguard-export-2026-11-18.zip
├── README.txt
├── notes/
│   ├── Meeting notes.md
│   ├── Meeting notes (2).md
│   └── Shopping list.md
├── attachments/
│   └── 030c46d3-layout-test.pdf
├── agenda/
│   └── agenda.ics
├── contacts/
│   └── contacts.vcf
└── 2fa/                     only when the user ticked the 2FA checkbox
    └── otpauth.txt
```

### 2.1 `notes/<safe-title>.md`

One file per note. Included: all notes that are not in the trash and not
locked. Archived notes are included. Locked (password-protected) notes are
skipped, and the confirmation dialog shows how many (section 5). Folders are
not exported in this version: the layout is flat.

```
---
title: "Meeting notes"
created: 2026-11-18T14:32:32.782Z
modified: 2026-11-18T14:35:01.120Z
tags: ["work", "2026"]
attachments: ["030c46d3-layout-test.pdf"]
---

Body exactly as stored in `content`.
```

Front-matter rules:

- Keys are `title`, `created`, `modified`, `tags`, in this order. `created` and
  `modified` are the note's `created_at` and `updated_at` unchanged (ISO 8601
  UTC). `tags` holds tag **titles** (resolved from the uuids in `tags`), not
  uuids.
- `attachments` is an optional fifth key, written only when the note has
  attachments. It lists the file names inside `attachments/` (2.2) so an
  importer can re-link them. This key is an addition to the four named in the
  task; importers must ignore keys they do not know.
- Strings are written as double-quoted YAML scalars: `\` becomes `\\`, `"`
  becomes `\"`, a newline becomes `\n`, other control characters are removed.
  The block is a strict subset of YAML (flat keys, one level of
  JSON-style lists), so a reader needs no YAML library.
- The body is `content` unchanged. For `checklist` and `super` notes this is
  already Markdown task syntax. `plain`, `superscript` and `code` notes are
  exported as they are; the editor type is not stored in the file.
- The body is not rewritten. When a note has readable attachments, a final
  `Attachments:` list is appended after it, one relative link per file
  (`[name](../attachments/<id>-<name>)`, `![name](…)` for images), with path
  segments percent-encoded.
- A note that is empty gets an empty body after the front-matter.

### 2.2 `attachments/<id>-<name>`

Every attachment of an exported note, original bytes (from
`getAttachmentBytes`), including scans. `<id>` is the first 8 hex characters of
the attachment uuid; if two attachments in one export would share it, **both**
use the full 36-character uuid. `<name>` is the stored `filename` after the
file-name rules below. The OCR text of a scan is not written as a file (it
lives in the app and is rebuilt by OCR). An attachment whose bytes cannot be
read is skipped and listed in `README.txt` under "Not exported".

### 2.3 `agenda/agenda.ics`

One iCalendar file from `buildIcsCalendarFromEvents(flattenEventsForIcsExport(…))`
for all calendars (the same functions `exportAgendaToIcs` uses; both live in
`agenda-ics.js`, so the export does not depend on the agenda view being
loaded). Edited occurrences of a series become extra VEVENTs with
RECURRENCE-ID. It contains no reminders and no agenda tasks (1.6). Omitted
when the agenda is empty. Events without a start or end are not written; their count is listed
under "Not exported" in `README.txt` (2.5). If the iCalendar module is missing the export fails
with an error and no ZIP is saved; it never silently leaves the agenda out.

### 2.3a `contacts/contacts.vcf`

All live contacts as one vCard 3.0 file with photos, written by `NotesContactsVcard.write`
(the writer of docs/CONTACTS_SPEC.md 8.2, also used by the Contacts tab's Export). Omitted when
there are no contacts; a vault with only contacts still exports. `README.txt` lists the count.
If the vCard module is missing the export fails with an error and no ZIP is saved. Test:
`tests/test_readable_export_contacts.js`, `tests/test_e2e_readable_export_contacts.py`.

### 2.4 `2fa/otpauth.txt` (opt-in only)

Written only when the user ticked the separate 2FA checkbox (section 5). One
line per account, the standard URI:
`otpauth://totp/<Issuer>:<account>?secret=<Base32>&issuer=<Issuer>&algorithm=SHA1&digits=6&period=30`.
`Issuer` and `account` are percent-encoded. The file contains live secrets.
Without the checkbox the `2fa/` folder does not exist and the export contains
no secret.

### 2.5 `README.txt`

First lines, in this order, English and unchanged by locale:

```
WARNING: THIS ARCHIVE IS NOT ENCRYPTED.
Everything in it is readable by anyone who has this file: notes, attachments,
your calendar and, if present, the 2fa/ folder with authenticator secrets.
Store it somewhere private and delete it when you no longer need it.
The encrypted .dgbackup file from Settings is the safe way to keep a backup.
```

Then: export date, app build, counts (notes, attachments, events, 2FA
accounts), "Not exported" list (locked notes, trashed notes, unreadable
attachments, folders), and one line that says whether `2fa/` was included.

### 2.6 File and title naming

Applies to `notes/<safe-title>.md` and to `<name>` in `attachments/`.

1. Normalise to Unicode NFC.
2. Replace each of `\ / : * ? " < > |` and every control character (U+0000 to
   U+001F, U+007F) by `_`. Non-ASCII letters are kept (`Café` stays `Café`).
3. Collapse runs of whitespace to one space; trim spaces and `.` from both
   ends.
4. If the result is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`,
   `COM1`-`COM9`, `LPT1`-`LPT9`, case-insensitive, with or without extension),
   prefix `_`.
5. Cut to 80 characters (by code point) and at most 200 bytes of UTF-8,
   without cutting a code point; for attachments the extension of the original
   name is kept and the base is cut instead.
6. If nothing is left, use `Untitled` (`unnamed` for attachments).
7. **Duplicates** are decided case-insensitively on the final path. Notes are
   ordered by `created_at` ascending, then by uuid. The first keeps its name;
   the next ones get ` (2)`, ` (3)`, … before the extension. The suffix is
   counted after cutting, so the name stays within the limits. The order makes
   the result stable between two exports of the same vault.
8. The front-matter `title` is always the **original** title; only the file
   name is converted. An importer must prefer the front-matter title.

Examples: `Plan: Q1/Q2?` → `Plan_ Q1_Q2_.md`; `con` → `_con.md`; two notes
called `Todo` → `Todo.md`, `Todo (2).md`; `todo` after those → `todo (3).md`;
`../../etc/passwd` → `.._.._etc_passwd` after step 2, `_.._etc_passwd` after
the dot trim of step 3, so `_.._etc_passwd.md`. A title never produces a `/`
or a path segment equal to `..` (section 4.2).

## 3. Mapping to the app's note format

Every importer produces notes in the shape of 1.3 and attachments in the shape
of 1.4. Importers write through the store (`NotesStore.upsert` with
`defaultNote()` as base, then `NotesStore.addAttachment`), never directly to
the server. New notes get new uuids (`newUuid`). Tags are matched by title with
`NotesSnImport.mergeTagsByTitle` (`snimport.js:138`) so a second import does
not create duplicate tags. A field not named below keeps its `defaultNote`
value. Titles are cut to 200 characters; a missing title becomes the first
non-empty body line (cut to 80), else `Untitled`, with `title_manual: false`.

Dates: a missing, unparsable or future (more than one day ahead) date becomes
the import time. `created_at` and `updated_at` are always ISO 8601 UTC.

### 3.1 Markdown (`.md`, and the notes of the section 2 ZIP)

| Source | App field |
| --- | --- |
| Front-matter `title` | `title`, `title_manual: true`. Else first `# ` heading (removed from the body), else file name without `.md`. |
| `created`, `modified` | `created_at`, `updated_at`. |
| `tags` (list of strings, or a comma-separated string) | tag items found or created by title; uuids go in `tags`. |
| `attachments` and relative links `[x](../attachments/f)` / `![x](…)` that point inside the archive | `addAttachment`; links to files that were imported are left as written. Links to anything outside the archive (absolute path, `http:`, `..` out of the root) are left as text and nothing is read or fetched. |
| Body | `content`, `editor: "markdown"`. If every non-empty line is a `- [ ]`/`- [x]` task, `editor: "checklist"`. |

A file without front-matter is imported as a whole body. Unknown front-matter
keys are dropped. HTML tags inside the body are left in the text; they are
cleaned when rendered (section 4.5).

### 3.2 Evernote (`.enex`)

ENEX is XML. One `<en-export>` holds many `<note>` elements.

| ENEX | App field |
| --- | --- |
| `<title>` | `title`. |
| `<content>` (CDATA with ENML, an XHTML subset) | converted to Markdown for `content`, `editor: "markdown"` (table below). |
| `<created>`, `<updated>` (`YYYYMMDDTHHMMSSZ`) | `created_at`, `updated_at`. |
| `<tag>` (repeated) | tag items by title. |
| `<note-attributes>` `<source-url>` | one last line `Source: <url>` in the body, as text. Other attributes (author, latitude, …) are dropped. |
| `<resource>` with `<data encoding="base64">`, `<mime>`, `<resource-attributes><file-name>` | one attachment each; `filename` from `file-name`, else `attachment-<n>` plus an extension from `mime`; `mime` from `<mime>`. `<recognition>` and `<alternate-data>` are ignored. |
| `<en-media hash="…" type="…"/>` inside ENML | The resource whose MD5 of the decoded `<data>` equals `hash`. Images (`image/*`) become `![name](name)`; others `[name](name)` and the attachment is linked to the note. No match: the text `[missing attachment]`. |

ENML to Markdown (anything not listed becomes its text content):

| ENML | Markdown |
| --- | --- |
| `div`, `p`, `br` | paragraphs and line breaks |
| `h1`-`h6`, `b`/`strong`, `i`/`em`, `u`, `strike`/`s`/`del`, `code`, `pre` | `#`…, `**`, `*`, plain text for `u`, `~~`, backticks, fenced block |
| `ul`, `ol`, `li` (nesting kept) | `- `, `1. ` |
| `<en-todo checked="true"/>` before text | `- [x] ` / `- [ ] `; a note whose lines are all tasks gets `editor: "checklist"` |
| `a href` | `[text](url)` only when the scheme is `http`, `https` or `mailto`; otherwise the text only |
| `table`, `tr`, `td` | Markdown table when it is rectangular; else rows as lines |
| `<en-crypt>` | text `[encrypted text not imported]`. Never decrypted. |
| `script`, `style`, `iframe`, `object`, `embed`, `svg` | dropped with their content |
| `font`, `span`, `class`, anything else | text content only |

### 3.3 Google Keep (Takeout)

Takeout gives `Takeout/Keep/*.json` next to `*.html` and attachment files.
Only the JSON files are read; the HTML copies are ignored.

| Keep JSON field | App field |
| --- | --- |
| `title` | `title`. |
| `textContent` | `content`, `editor: "plain"`. |
| `listContent` (`[{text, isChecked}]`) | `content` = one line per item, `- [x] text` / `- [ ] text`, `editor: "checklist"`. Nested items (`parentId`) are not nested: every item is one top-level line, in order. If `textContent` is also present it goes first, then a blank line. |
| `labels` (`[{name}]`) | tag items by title. |
| `attachments` (`[{filePath, mimetype}]`) | the file named `filePath` in the ZIP (matched by base name, case-insensitive) becomes an attachment with `mime` from `mimetype`. A missing file is counted and shown in the result. |
| `createdTimestampUsec`, `userEditedTimestampUsec` | `created_at`, `updated_at` (microseconds since 1970 divided by 1000). |
| `isPinned` | `pinned`. |
| `isArchived` | `archived`. |
| `isTrashed` | The note is skipped and listed in the result as "in the Keep trash". |
| `textContentHtml` | Used only when the note has neither `textContent` nor `listContent`; then it goes through the allowlist of 4.5. |
| `color`, `annotations` (`[{url, title}]`) | `color` is dropped. Each annotation becomes a final line `[title](url)` when the URL is `http` or `https`. |

## 4. Threat model and hard limits

Assets: the vault key and plaintext in browser memory, the existing vault
items, and the user's device (memory, disk, tab). Attacker: the author of a
file the user is tricked into importing (a crafted ZIP, ENEX, Keep JSON or
Markdown file). The attacker does not control the server. Goals to stop:
exhausting memory or CPU, writing outside the intended place, reading local or
network resources, running script in the app origin (which holds the vault
key), and filling the vault with junk that syncs everywhere. A second threat
is on the export side: a readable archive left on disk (section 5).

### 4.1 Limits (enforced before work is done, and while reading)

Limits are checked against the **bytes actually produced** while unpacking, not
against sizes written in the ZIP headers, which an attacker controls.

| Limit | Value |
| --- | --- |
| Import file size (ZIP, ENEX, JSON, Markdown) | ZIP: 512 MiB (536,870,912 bytes). Single `.enex`: 256 MiB (268,435,456). Single JSON or `.md`: 10 MiB (10,485,760). Larger: refused before reading. |
| Entries in a ZIP | 10,000 (directories count). More: refused. |
| Total unpacked size | 1 GiB (1,073,741,824 bytes). |
| Unpacked size per entry | Attachments: 50 MiB (52,428,800, same as `MAX_ATTACHMENT_BYTES`). Text entries (`.md`, `.json`, `.ics`, `.txt`): 10 MiB. |
| Compression ratio | Per entry: unpacked ÷ compressed at most 100:1 once an entry is larger than 1 MiB unpacked. Whole archive: unpacked ÷ ZIP size at most 50:1. Unpacking stops the moment a limit is crossed. |
| Notes per import | 10,000. Attachments per note: 100. Resources per ENEX note: 100. |
| Size of one ENEX `<note>` element | 80 MiB (a 50 MiB resource is about 67 MiB as base64). |
| Name length | 255 bytes of UTF-8 per path segment, 1,024 bytes per path, at most 8 segments. |
| Nesting depth of JSON / XML | 64 levels. |

Crossing any limit stops the whole import with an error that names the limit.
Nothing is written to the vault by a refused import: parse and convert first
into memory, write to the store only after the whole file passed.

### 4.2 ZIP rules

- Allowed methods: stored (0) and deflate (8). Any other method, an encrypted
  entry (general-purpose bit 0), ZIP64, multi-disk archives and archives with
  data before the first entry or inconsistent header sizes are refused.
- Entry names are decoded as UTF-8 and checked **before** any other use. An
  entry is refused (and the import stops) if its name: starts with `/` or `\`,
  has a drive prefix (`C:`), contains a `\`, a NUL or another control
  character, has a segment equal to `..` (or `.`), or exceeds the name limits
  of 4.1. Names are never used as file system paths: nothing is written to a
  disk path, so the check protects the names that later appear as attachment
  names and in links.
- Two entries whose names are equal after NFC and lower-casing: refused.
- Entries of the Mac resource folder (`__MACOSX/`) and directory entries are
  skipped, as `unzip` already does today (`snimport.js:666`).
- Symbolic links (Unix mode in the external attributes) are refused.
- Unpacking is sequential. Memory use is bounded by the largest entry plus the
  parsed notes, not by the sum; an entry is released when it has been consumed.

### 4.3 XML (ENEX and ENML)

- **No DOCTYPE and no entities.** Before parsing, the text is scanned. A
  `<!ENTITY`, an internal subset (`<!DOCTYPE … [`) or any DOCTYPE other than
  the two fixed Evernote forms below is refused. This applies to the ENEX file
  and to every ENML `<content>`.
- Deviation, stated plainly: genuine Evernote exports start with
  `<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">`
  (or `…export3.dtd`) and every ENML body with
  `<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">`. Refusing
  all DOCTYPEs would refuse every real export. So exactly those declarations
  (SYSTEM id on `xml.evernote.com`, no `[`) are cut out of the text before
  parsing; the DTD is never loaded and the URL is never requested. Everything
  else about DOCTYPE is refused.
- Parsing uses `DOMParser` with `application/xml` on the text that remains, on
  a detached document. The parsed tree is never inserted into the page.
  `parsererror` stops the import. Custom entity references other than the five
  built-in ones (`&lt; &gt; &amp; &quot; &apos;`) and numeric references are
  not expanded.
- Processing instructions and comments are ignored. Namespaces are ignored.

### 4.4 JSON and Markdown

- JSON (Keep) is read with `JSON.parse` after the size and depth limits.
  Prototype keys (`__proto__`, `constructor`) are never copied into objects;
  fields are read by name into fresh objects.
- Markdown front-matter is parsed by a small strict reader (2.1 syntax), not by
  a YAML library: no anchors, tags, merges or multi-line scalars. At most 64
  tags per note, each at most 100 characters.

### 4.5 HTML and Markdown output: sanitising

Imported content is stored as **Markdown or text**, never as HTML (1.3). Where
the source is HTML (ENML) it is converted node by node
by a fixed table (3.2); unknown elements contribute only their text. In
addition, everything that is later shown goes through the existing
`NotesSanitize.sanitizeRichHtml` allowlist, which is the second line of
defence:

- Allowed tags (`RICH_ALLOWED_TAGS`, `sanitize.js:106`): `h1`-`h6`, `p`, `br`,
  `hr`, `strong`, `em`, `del`, `s`, `code`, `pre`, `blockquote`, `ul`, `ol`,
  `li`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `a`, `img`, `span`, `div`,
  `button`.
- Allowed attributes (`RICH_ALLOWED_ATTR`): `href`, `src`, `title`, `alt`,
  `class`, `dir`, `colspan`, `rowspan`, `start`, `type`, `rel`, `target`,
  `aria-checked`, `data-checked`, `data-lang`, `scope`.
- **Never allowed:** `script`, `iframe`, `object`, `embed`, `style`, `form`,
  `svg`, `math`, `link`, `meta`, every `on*` attribute, `style` attribute,
  `srcset`, and any `javascript:`, `data:text/html`, `vbscript:` or `file:` URL.
  Links may be `http`, `https`, `mailto`; images may only use `src` that points
  to an attachment of the vault (`blob:` created by the app) or a `data:image/png|jpeg|gif|webp` URL; SVG is
  refused (`safeRichImageSrc`, `sanitize.js:98`). **No external `src`**: an `http(s)` image URL is
  shown as its link text, so opening a note never makes a request on its own.
- The importer must not use `innerHTML`, `insertAdjacentHTML` or `document.write`
  on imported text; conversion works on parsed nodes and strings.
- File names from imports are shown as text and used as the download name only
  after the rules of 2.6.
- The checks of 4.1 to 4.5 must have tests that run the real importer on
  hostile samples (a ZIP bomb, a `../` entry, an ENEX with `<!ENTITY>`, a note
  with `<script>`, `onerror` and `javascript:`) and assert that the import is
  refused or the output is clean.

### 4.6 Browser only

- No import or export path calls `fetch`, `XMLHttpRequest`, `sendBeacon` or the
  server API. The service worker is not asked to cache any of it.
- Files are read with `File.arrayBuffer()` or `.stream()`. The export file is
  created with a `Blob` and an object URL that is revoked right after the
  download starts, the same way as `downloadNoteMarkdown` today.
- Plaintext from an import or export is not written to `localStorage`,
  `sessionStorage` or the console, and errors name the limit or the file, not
  its content.
- Export and import are refused while the vault is locked (nothing to
  decrypt) and work offline.
- Imported items go through the normal store, so they are encrypted before
  they leave the browser, like any other item.

## 5. Confirmation flow for the readable export

The readable export is the one place where the app makes plaintext on purpose.
The flow has three steps in one dialog (existing dialog pattern,
`confirmAction`, `app.js:5815`; keyboard reachable, focus trapped, Escape
cancels, aria-labelled, correct in light and dark and at phone width).

1. **Warning.** Text: "This archive is not encrypted. Anyone who gets the file
   can read your notes, attachments and calendar. It is not protected by your
   vault password. For a safe backup use the encrypted backup instead." with a
   link to that button. The dialog also states the counts and what is skipped
   (locked notes: N; trashed notes are never exported).
2. **Password.** The user types the vault password again. It is checked in the
   browser with `NotesStore.verifyVaultPassword` (the check that
   `checkVaultPasswordOnline` already uses first, `app.js:8007`); nothing is
   sent to the server. A wrong password shows an inline error and exports
   nothing. After three wrong attempts the dialog closes. The password field is
   cleared when the dialog closes, whatever the outcome.
3. **2FA checkbox.** A separate, unchecked checkbox: "Also include my
   authenticator secrets (2fa/otpauth.txt). Anyone with this file can
   generate my codes." It is never checked by default, is not remembered
   between exports and is not implied by step 1 or 2. The button label says
   what will happen: "Export unencrypted ZIP" while the box is unchecked,
   "Export with 2FA secrets" once it is ticked.

Rules:

- Nothing is built until step 2 has passed. Cancelling at any step creates no
  file.
- The README warning of 2.5 is always written, with or without 2FA.
- After the download starts the app shows one toast, "Unencrypted export
  saved. Delete it when you are done.", and does not log the file name or
  counts to the console.
- The same action twice builds two separate archives; each needs the dialog.
- An empty vault (no notes, no events, no 2FA accounts) produces no archive and
  says so.
- Imports need no password prompt (they add data, they do not reveal any), but
  show the counts and the first refused limit before writing, and a result line
  after (`importResultToast`, `app.js:25446`).
