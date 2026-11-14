# Nested folders and manual ordering — design spec

Status: design only, no code changes. Idea #62 (users want hierarchical
organisation and manual ordering, and do not understand tags vs. folders).

Line numbers refer to the tree at the time of writing (branch based on
`5984c67`). The task text quoted older line numbers (`store.js` ~4655, ~6730);
the same functions now sit at the lines cited below. Re-check before building.

**Zero-knowledge rule (applies to everything below):** `parent_id`,
`sort_order`, `note_order`, `name` and `schema` exist **only inside the
encrypted folder record** (the AES-GCM ciphertext of `content`). The server sees
the same columns and API as today (uuid, timestamps, `rev`, `deleted`,
ciphertext). **The server sees nothing new**: no new column, endpoint, header,
query parameter or plaintext metadata. Only the ciphertext length changes by a
few bytes.

---

## 1. Current state (with references)

### 1.1 Folders are flat

- A folder is an item with `content.type === 'folder'`, created by
  `defaultFolder(title)` which returns only `{type, title, created_at, updated_at}`
  (`app/static/js/store.js:1068-1076`).
- `NotesStore.createFolder(title)` (`store.js:4898-4903`) = `newUuid()` +
  `upsert(id, defaultFolder(name))`. No parent, no order. It does not check for
  duplicate names; `renameFolder` does (`store.js:4905-4917`, global, case-insensitive
  duplicate check at `4910-4914`).
- `listFolders()` (`store.js:4886-4890`) sorts by `title` with `localeCompare`.
  `notesInFolder()` (`4892-4896`) also sorts by title.
- `deleteFolder()` (`store.js:4919-4928`): every note with `folder_id === uuid` gets
  `folder_id: ''` (`touchSyncOnly`, so not an edit), then `remove(uuid)`.
  Notes are never deleted by a folder delete.
- Public API: `listFolders`, `createFolder`, `renameFolder`, `deleteFolder`
  (`store.js:7034-7038`), next to the tag API `listTags`, `createTag`, `moveTag`,
  `deleteTag` (`store.js:7039-7047`).
- A note points to its folder with `content.folder_id` (one folder per note).
  `assignCurrentNoteFolder(folderId)` (`app/static/js/app.js:14757-14773`) writes
  `{...note.content, folder_id}` with `touchUpdatedAt: false, touchSyncOnly: true`.
  The picker `syncNoteFolderControl` (`app.js:14740-14755`) is a flat `<select>`.
- Other users of `folder_id`: delete + undo (`app.js:9748-9772`, undo re-upserts
  `{...folder.content}`), list filter (`app.js:10562`), search filter
  (`search.js:921`), search field "Folder" (`search.js:259`, `313`, `459`),
  templates (`templates.js:79`, `102`), new-note-in-folder (`app.js:18766`),
  create-from-composer (`app.js:20146-20235`).
- Sidebar: `renderFolders()` (`app.js:9642-9690`) is a flat list of
  `folder-block`s with a toggle (notes inside, `aria-expanded` on the toggle button),
  **not** an ARIA tree. The count is the number of direct notes
  (`notesInFolder(...).length`, `app.js:9649`).

### 1.2 Hierarchy already exists — for labels (tags), not folders

This matters: we must not invent a second model.

- Labels are already nested through `content.parent_id`, `content.order`,
  `content.name` and the compat field `content.title_sync`
  (`app/static/js/labels.js`, spec `docs/NOTES_ORGANIZATION_SPEC.md` section 1).
  Max depth 8 (`labels.js:7`), max 2000 labels (`:8`), order step 1024 (`:10`),
  orphan -> root and cycle repair in `repair()` (`:143-183`), `validateParent`
  with cycle and depth checks (`:96-104`), `planUpdate` (`:187-211`),
  `planDelete` with `promote` / `delete` (`:216-234`), `nextOrder` (`:111-117`).
- Store: `createTag(name, parentId)`, `moveTag`, `migrateLabels`, `repairLabels`
  (`store.js:4961-4999`).
- UI: `NotesLabelTree.html` renders `role="tree"` / `role="treeitem"` with
  `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`
  (`app/static/js/labeltree.js:86-97`); drag-and-drop with a menu alternative
  (`app.js:9387-9412`); rolled-up counts through `NotesLabels.ancestors`
  (`labelCounts`, `app.js:9176-9188`).
- Tests: `tests/test_nested_labels.js`, `tests/test_label_tree.js`.
- Hierarchy through a `/` in a tag name is explicitly **rejected** by
  `validateName` (`labels.js:29`, `error: 'slash'`).

### 1.3 Can notes or folders be ordered by hand today? **No.**

- Note sort modes are only `updated`, `created`, `title`
  (`NOTE_SORT_ORDER`, `app.js:344`; applied at `app.js:10566`, `10735`, `11105`;
  cycle button `app.js:19597`). Pinned/starred are filters/flags, not an order.
  The `sort` setting is an enum of those three (`docs/SETTINGS_SPEC.md:93`, `:132`).
- Folders are always alphabetical (`store.js:4889`); the folder record has no
  order field. Notes inside a folder are alphabetical (`store.js:4895`, and the
  sidebar list `app.js:9649-9656`).
- Only labels have a manual order (`order`, Alt+Up/Down in the label tree spec).
- There is no drag-and-drop for folders or notes. (`dragstart` exists only for
  the label list, `app.js:9389`.)

### 1.4 Storage, sync, cache

- Folder records are encrypted like every item and kept in IndexedDB as
  ciphertext (`docs/LOCAL_CACHE.md:31`, `:34` — "Folder: flat too ... out of
  scope"; `:134`: records are AES-GCM ciphertext under the vault key).
  No cache schema change is needed: a new field is just more JSON inside the
  ciphertext. IndexedDB schema (version 2, `docs/LOCAL_CACHE.md:23`) is untouched.
- Conflicts are last-writer-wins per **record** (`docs/DELETE_SPEC.md`, Other
  signed-in devices row). There is no field-level merge.
- No Joplin or Evernote importer exists in the client (search for
  `joplin|evernote|enex` finds nothing in `app/static/js`); the only importer is
  Standard Notes (`snimport.js`), which does not create folders. The only
  export is the encrypted backup (`buildLocalBackup`, `app.js:24480-24510`),
  which serialises every non-deleted item's ciphertext as is.

---

## 2. Data model

Add optional fields to the **folder** record only, mirroring the label model so
code and tests can be shared (`labels.js` helpers are generalised, not copied):

```
folder content (all inside the ciphertext)
  type:        'folder'
  title:       string   // existing. For nested folders = compat path "Work / Projects / Alpha" (see section 5)
  name:        string   // NEW, optional. Leaf name. Absent = legacy flat folder: name := title
  title_sync:  string   // NEW, optional. The path title we last wrote; detects a rename by an old client
  parent_id:   string   // NEW, optional. uuid of the parent folder. "" or absent = root
  sort_order:  number   // NEW, optional. Position among siblings (fractional index). Absent = legacy
  note_order:  string[] // NEW, optional. Manual order of note uuids in this folder (section 2.3)
  schema:      number   // NEW, optional. 2 for records written by a nested-folder client
  created_at, updated_at, ...unknown fields (kept)
```

### 2.1 Only in the encrypted record

- `parent_id`, `sort_order`, `note_order`, `name`, `title_sync`, `schema` are
  written only through `NotesStore.upsert(uuid, content)` and therefore only
  inside the encrypted payload. No code path may copy them into the push request
  envelope, a URL, a log line, the service worker cache, telemetry or a
  notification. A wire test (section 9) asserts that the plaintext push body
  for a nested move contains no new key and none of the folder names.
- Notes are not changed to represent the tree. `note.content.folder_id` stays
  a single uuid. Moving a folder never rewrites notes.

### 2.2 Sort key: fractional number, same as labels

`sort_order` is a JS number, step 1024 for appends, the midpoint when inserting
between two siblings (`nextOrder` pattern, `labels.js:111-117`). When the gap
between neighbours drops below `1e-6`, renumber all siblings of that parent in
one batch (step 1024). Ties (two devices picked the same key) are broken by
lower-cased `name`, then by `uuid` — the result is identical on every device.
A string key (LexoRank-style) was considered: it never runs out of space, but
it needs a new comparator and gives no benefit for lists of < 1000 siblings, and
labels already use numbers. Renumbering is rare and local.

Legacy folders without `sort_order` sort **after** ordered siblings,
alphabetically (today's behaviour, `store.js:4889`). On the first manual
reorder inside a parent, **all** siblings get a `sort_order` in the current
visible order in one batch (same proposal as `NOTES_ORGANIZATION_SPEC.md:517-519`),
so nothing jumps.

### 2.3 Manual order of notes inside a folder

Notes must not be edited just to be reordered (it would change the note record
and its sync/revision behaviour). So the order lives in the folder record:
`note_order` = array of note uuids, max 1000 entries.

- Applies only to a folder view, only while the preference `notesManualOrder` is
  on. It is a **new** boolean setting (device or synced as the settings spec
  decides); the existing `sort` enum is **not** extended, because older clients
  coerce an unknown `sort` value back to `updated` and write it
  (`syncSortControls`, `app.js:352-355`), which would silently wipe a synced
  `manual` value on every old device.
- Reading: listed ids that are not (or no longer) notes of this folder are
  ignored (stale entries, never an error). Notes of the folder that are not
  listed come **first**, newest `created_at` first (then uuid); then the listed
  notes in array order. So a new note shows on top and nothing is hidden.
- Writing a reorder rewrites the array with exactly the current visible notes
  of that folder, dropping stale ids.
- Notes with no folder have no folder record, so they cannot be hand-ordered;
  they keep the normal sort modes. (Explicitly accepted limitation.)
- Concurrent reorders on two devices: whole-record last-writer-wins on the folder
  record. The losing device's *order* is lost, never a note or a folder.
- Pinned/starred notes behave as in the current list (`pinned` first) unless
  the user turns manual order on, in which case the manual order is shown
  as is. Decide in the UI task; both are deterministic.

---

## 3. Invariants

Enforced on **write** (reject, return `{ok:false,error}` like `validateParent`,
`labels.js:96-104`) and **repaired on read** (section 4), because another
device or an old client can always produce a violating state.

| # | Invariant | On write | On read |
|---|---|---|---|
| I1 | Max depth **5** (root folder = depth 1) | `too_deep` when `depth(parent) + height(subtree) > 5` | Over-deep folder is shown under its depth-4 ancestor (section 4.3) |
| I2 | No cycles; a folder is not its own ancestor | `cycle` | Cycle broken deterministically (section 4.2) |
| I3 | `parent_id` must reference an existing, non-deleted **folder** (not a tag, not a note, not a tombstone) | `unknown_parent` | Orphan = root (section 3.2) |
| I4 | Sibling names unique, case-insensitive, trimmed | `duplicate` | Duplicates are tolerated and shown (never auto-renamed or merged) |
| I5 | Name 1-64 chars, no `/` (keeps paths and the "no hierarchy via /" decision in section 8 unambiguous) | `empty`, `too_long`, `slash` | Unchanged names are displayed as is |
| I6 | Max 1000 folders per vault | refuse create | Extra folders still shown |
| I7 | `note_order` max 1000 entries | truncate when writing | Extra entries ignored |

### 3.1 Why depth 5

- Labels allow 8 because a label is a lightweight filter. A folder is a place
  the user navigates, and deep trees are a known usability problem (every level
  costs indentation and a click). Joplin/Evernote-style notebooks are
  typically 2-3 levels; 5 gives headroom for Area / Project / Year / Client / Topic.
- A 320 px phone sidebar with 16 px indent per level spends 80 px on indentation
  at depth 5; at 8 it would be 128 px (40 % of the width) and the name would be
  truncated. WCAG reflow at 400 % zoom makes this worse.
- Cycle/ancestor walks stay trivially cheap; the limit also bounds the work of
  `title` path rewrites on a move (section 5).
- The constant lives in one place (`NotesFolders.MAX_DEPTH = 5`). Raising it later is
  safe (older, shallower data stays valid); lowering it later is not, so we start
  conservative.

### 3.2 Orphans

A folder is an orphan when its `parent_id` is non-empty and no live (non-deleted,
`type === 'folder'`) record has that uuid: parent deleted on another device,
tombstoned, not yet synced, or the id points to a non-folder. An orphan is
**treated as a root folder** by every reader: tree, picker, counts, search
scope, export. Its subtree comes with it. Nothing is deleted and its notes stay
in it. The stored `parent_id` is not required to be rewritten; if the parent
record arrives later (sync order), the folder snaps back under it with no
action. A repair write (`parent_id: ''`) is optional, idempotent and only done on
the next user edit of that folder, so devices do not fight over it.

Notes with a `folder_id` that does not exist stay as today: shown as "No folder"
(`app.js:14753` falls back to `''`), the stored value is untouched.

---

## 4. Concurrent moves on two devices

Each folder is one record, so two devices only collide on the same folder
(last-writer-wins by the existing record rules) — **or** they produce a
combination that is invalid even though each edit was valid alone. Example: A
moves X under Y while B moves Y under X: each device validated against its own
copy and both writes win on different records, so a cycle X->Y->X now exists.
Others: A moves X under Z while B deletes Z (orphan); A and B both move different
folders under a parent at depth 4 (over-deep); A and B create the same sibling
name.

Rule: **the tree shown is a pure function of the set of folder records**, computed
on load and after every sync. Two devices with the same records show the same tree,
without talking to each other. No data is ever deleted by this.

### 4.1 Effective-parent algorithm (deterministic)

Input: all live folder records. Output: `effectiveParent(id)` for each folder.

1. `p0(id)` = stored `parent_id`, or `''` when empty, self-referencing, or not a live folder (orphan, 3.2).
2. **Cycle breaking** (4.2).
3. **Depth clamp** (4.3).
4. Children of a parent are ordered by `sort_order` (absent last), then lower-cased
   `name`, then `uuid`.

### 4.2 Cycle breaking

1. Walk folders in ascending `uuid` order (plain string comparison of the id).
2. Follow `p0` until a root is reached or an id repeats. If an id repeats, the
   members of that loop form a cycle.
3. In each cycle, the member with the **lowest uuid** gets `effectiveParent = ''`
   (it becomes a root folder). All other links of the cycle stay.
4. Repeat until no cycle remains (a cycle is a simple loop in a functional graph,
   so one pass per loop is enough; the loop is bounded by 1000 folders).

Example: X (`aaa`) under Y (`bbb`), Y under X -> `aaa` becomes a root, `bbb`
stays under it. Every device picks `aaa`, because the rule only uses ids. The uuid
is used, not `updated_at`, because device clocks can differ and `updated_at`
equality is common after a batch write. (Labels currently break ties by oldest
`updated_at` then id, `labels.js:162`. That is also deterministic, but folders use
the simpler id rule requested here; unifying the two is optional follow-up work,
not required, as they are separate record types.)

No folder, note or `folder_id` is deleted, and the stored `parent_id` is not
rewritten by the algorithm. The user sees the folder at the top level; if they
want it elsewhere they move it (a normal write, which validates against the repaired
tree).

### 4.3 Depth clamp

Process folders breadth-first from the roots, ordered by (depth, uuid). A folder
whose depth would be > 5 gets `effectiveParent` = its ancestor at depth 4 (its
own depth becomes 5; its children are then re-evaluated, and any that would
be depth 6 are clamped to the same ancestor in turn). Flattening is deterministic
because the order is fixed; it shows siblings rather than losing them. Notes
inside remain in their folder.

### 4.4 Other collisions

- Same folder edited on both devices (rename vs. move): record-level LWW; one edit
  is lost, as for every other record type today. This spec does not add field merge.
- Move into a folder that another device just deleted: the move wins on the
  record, the parent is a tombstone -> orphan -> root (3.2). The user sees the
  folder at the top. (Alternative "promote on delete" in section 6.3 reduces the
  chance.)
- Duplicate sibling names after a merge: both shown, ordered by 4.1.4; the UI may
  show a badge, nothing is renamed automatically.
- `sort_order` ties: 2.2.

### 4.5 Persisting a repair

The view is correct without writing anything. When the user next edits one of the
affected folders (move, rename, reorder), the write contains the repaired
`parent_id` for that folder only. A background "write back repairs" job is **not**
proposed: every device would write the same value and spend a sync slot for a
cosmetic gain. (Labels do write back, `store.js:4995-4999`; if the folder task
wants it, it must be idempotent so two devices produce identical content and no
ping-pong.)

---

## 5. Backwards compatibility (old clients)

Old clients (today's code) have no concept of `parent_id`. Facts from the
current code:

- They show every folder as a flat list ordered by `title` (`store.js:4886-4890`,
  `renderFolders` `app.js:9642`).
- They preserve unknown fields on the paths that rewrite a folder:
  `renameFolder` uses `{...folder.content, title: name}` (`store.js:4915`) and the
  delete-undo uses `{...folder.content}` (`app.js:9768`... `NotesStore.upsert(snapshot.uuid, {...snapshot.content})`).
  `upsert` takes the full content object, so unknown keys survive a rename.
  Therefore `parent_id`, `sort_order`, `note_order`, `name`, `title_sync`
  and `schema` are **not wiped** by an old client's rename. This is the same
  mechanism the label spec relies on (`NOTES_ORGANIZATION_SPEC.md:170`).
- **Prerequisite task (ships first, on the old code path):** audit every place
  that rewrites a folder record and make sure it spreads the existing content
  (`store.js:4915`, `app.js:9768`, any import/restore/conflict-copy path). Add a test
  that a rename, delete-undo and sync round trip keep unknown folder fields.
  `NotesStore.upsert` / `persistLocal` must not whitelist folder keys.

### 5.1 What an old client shows

- Display: a flat list, no hierarchy. To keep that list readable and unambiguous,
  a nested client writes `title` = path with the same separator as labels
  (`Work / Projects / Alpha`, `labels.js:6`) and records the same value in
  `title_sync`. The old client then shows the path as a flat folder name.
  Notes with a `folder_id` in it still show up in it. Nothing is hidden.
- Folder picker for a note: flat list with the path names; assigning works and
  only writes `note.folder_id`.
- Rename by an old client: it writes the new `title` and leaves `title_sync`. A new
  client sees `title !== title_sync` and adopts the **last path segment** of
  `title` as `name` (same repair as labels, `labels.js:147-150`), keeps `parent_id`
  and re-derives paths. A rename of a parent by an old client only rewrites that
  parent's `title`; descendants' `title` strings are stale until a new client
  re-derives them (cosmetic, known limit, as for labels).
- Delete by an old client: it tombstones that one folder; children keep a dead
  `parent_id` -> orphans -> roots (3.2). Notes in the deleted folder have
  `folder_id` cleared by the old client (`store.js:4924`) — same as today; the
  new client's promote behaviour (6.3) applies only to its own deletes.
- Create by an old client: a legacy flat record (`name` absent): `name := title`,
  root, no `sort_order` (sorted last, alphabetical).
- An old client cannot create, move or reorder anything in the tree, so it cannot
  produce a cycle or a depth violation. It cannot corrupt `note_order`.

### 5.2 Version field

`schema: 2` on records written by a nested client is informational and defensive:
a *future* client with `schema: 3` fields can be recognised, and a nested client
that sees a higher `schema` than it knows **must preserve unknown fields and not
re-derive anything it does not understand** (read-only for the unknown parts). It is
not required for the old-client behaviour above, which relies only on field
spread. Absent `schema` = 1 (legacy).

### 5.3 Migration

No migration pass is required and none is run eagerly. A legacy folder (no
`name`) is read as `name := title`, root, order by title. The first time the user
creates a sub-folder, moves or reorders, the touched record(s) get `name`,
`parent_id`, `sort_order`, `title_sync`, `schema` added; existing fields are kept
via spread. The migration is lossless and idempotent (re-running on its own output
changes nothing), exactly like `NotesLabels.migrate` (`labels.js:123-138`).
Downgrade is safe: an old client still sees valid, flat folders.

---

## 6. Effects on other features

### 6.1 Search and filtering

- Selecting a folder filters to the folder **and all its descendants** (like
  labels: `NOTES_ORGANIZATION_SPEC.md:104`; search uses a `tagScope` array,
  `search.js:915-919`). `search.js:921` and `app.js:10562` currently compare
  `folder_id` for equality; both change to "id in `folderScope`", computed once
  from the effective tree (`NotesFolders.scope(id)`), passed as an option next
  to `tagScope`. The file-search path (`app.js:10562`) gets the same scope.
- The "Folder" search field (`search.js:459`) indexes the **path** (`Work / Projects /
  Alpha`), so searching `projects` finds notes in `Work / Projects`. The index
  signature (`search.js:313`) already includes folder id and title; it must include
  the path so a parent rename invalidates it.
- Search never runs on the server; nothing changes on the wire.

### 6.2 Counts

- Today: direct notes only (`app.js:9649`). New: each row shows the **rolled-up**
  count (notes in itself and descendants), the same rule as `labelCounts`
  (`app.js:9176-9188`); the accessible name also says the direct count. Trashed
  notes and templates are excluded as today (`store.js:4894`). A note is counted
  once per folder row it appears under (it has one `folder_id`, so no double
  counting inside a branch).

### 6.3 Deleting a folder

Modeled on `NotesLabels.planDelete` (`labels.js:216-234`) and on the existing
`deleteFolder` (`store.js:4919-4928`). The dialog offers two modes:

- **Promote (default):** sub-folders move up to the deleted folder's parent
  (or become roots); **notes of the deleted folder move to that same parent
  folder** (or "No folder" for a root folder, which is today's behaviour).
  No sub-folder and no note is removed. `title` paths of the promoted subtrees
  are rewritten.
- **Delete subtree:** the folder and all sub-folders are removed; **notes are
  never deleted** — all their `folder_id` values are cleared ("No folder"). A
  folder delete can never lose a note. The dialog says how many folders and notes
  are affected.
- All writes are one batch, with one undo (extending `toastWithUndo`,
  `app.js:9748-9772`): the snapshot holds every removed folder content and the
  `folder_id` of every moved note. Note rows are written with
  `touchUpdatedAt: false, touchSyncOnly: true` as today.

### 6.4 Backup, export, import

- Encrypted backups (`buildLocalBackup`, `app.js:24480`) store each item's
  ciphertext, so `parent_id`/`sort_order`/`note_order` round-trip **without any
  change**, and an old build restoring a new backup keeps the fields (opaque).
  Restore applies the read-time repair (section 4), so a backup containing a
  dangling parent or a cycle is shown safely.
- Cloud backups (`cloud-backup.js`) and the server backups (`db.iter_backup_items`) are
  ciphertext too. Already-written backups keep the old tree; that is an
  ordinary retention fact (see `DELETE_SPEC.md`).
- Plain exports (Markdown / HTML / ZIP of notes, if added or present): the folder
  path becomes a **directory path** in the archive (`Work/Projects/Alpha/note.md`),
  names sanitised, each segment truncated, collisions numbered. This is local to
  the device; the server is not involved.
- Importers: **there is no Joplin or Evernote importer today**, so none must be
  changed. For the future: Joplin notebooks carry `parent_id` and map 1:1 (depth
  beyond 5 is flattened under the depth-4 ancestor using the same clamp as 4.3,
  and the import report lists it); an Evernote *stack* maps to a root folder with
  its notebooks as children (depth 2). Tags stay tags (section 8). Imports go
  through `createFolder` with parent, so every invariant is checked.
- Standard Notes import (`snimport.js`) does not create folders; unchanged.

### 6.5 Secure Send

Secure Send sends a note (and its attachments) as an encrypted, expiring link
(`secure-send*.js`). It does not reference folders (search finds no `folder` in
those files). The nested model changes nothing: the folder path, `parent_id`,
`note_order` and sibling names are **not** added to the payload, so a recipient
learns nothing about the user's tree. A test asserts the sealed payload has no
folder field (section 9).

### 6.6 Delete spec (`docs/DELETE_SPEC.md`)

That spec covers note deletion and its truthful claims. Additions needed:

- A "Folder delete" subsection: a folder delete tombstones the folder item (server
  keeps `deleted = 1`, uuid, timestamps, small ciphertext; **the hierarchy of the deleted
  folder is not readable by the server** because it is inside the ciphertext), and
  only edits affected notes (`folder_id`), which is "an edit, not a delete" in the
  sense of the note paragraph. Existing backups keep the old tree until they age out.
- The dialog must not claim that notes were deleted, or that the folder is "gone
  everywhere"; the existing forbidden-claims list applies.
- Moving a note to Trash while its folder is deleted is independent: notes in
  Trash keep `folder_id`; if the folder is gone they restore to "No folder".

### 6.7 Other

- Templates copy `folder_id` (`templates.js:79`, `102`): unchanged; a missing
  folder -> "No folder".
- Settings sync (`docs/SETTINGS_SPEC.md`): per-device `foldersCollapsed`/open map
  (`:101`) now keyed by folder id (as today), stale ids ignored. The new
  `notesManualOrder` preference is added to the settings spec table when built.
  Open/collapsed state stays device-local, as for labels.
- Local cache: no change to the IndexedDB schema or cleartext keys
  (`docs/LOCAL_CACHE.md`). Update the "Folder: flat too" row (`:34`).
- Lock/privacy: locked notes already hide the folder control
  (`app.js:14744`); folder names are still vault data and are never written
  to `localStorage` in clear.

---

## 7. UI

### 7.1 Tree (WAI-ARIA tree pattern)

Reuse `NotesLabelTree` (`labeltree.js:86-97`), generalised with a `kind`
(`labels` / `folders`) rather than a second implementation. `renderFolders()`
(`app.js:9642`) changes from nested buttons to:

- Container `role="tree"`, `aria-label="Folders"`; folders are `role="treeitem"` with
  `aria-level`, `aria-posinset`, `aria-setsize` set explicitly, `aria-expanded`
  only for folders with children, `aria-selected` for the active filter. Children
  in `role="group"`. Notes shown under a folder (today's sidebar feature) are
  `role="treeitem"` leaves with no `aria-expanded`, so the widget stays one tree;
  if that makes the tree too heavy, notes move to the note list only (UI task decides).
- Accessible name includes the count: "Alpha, 12 notes, 3 sub-folders".
- Roving tabindex (one tab stop). Keys, matching `NOTES_ORGANIZATION_SPEC.md:467-476`:
  Up/Down, Right (expand / first child), Left (collapse / parent), Home/End,
  Enter/Space (select + filter), `*` expand siblings, type-ahead, `F2` rename,
  `Delete` delete (confirm), context key / Shift+F10 menu ("New sub-folder",
  "Rename", "Move to...", "Delete").
- **Alt+Up / Alt+Down** reorder among siblings (changes `sort_order`);
  **Alt+Left / Alt+Right** outdent / indent (move under the previous sibling,
  validated; if rejected for depth the live region says why).
- Focus is never lost: after a move/delete focus goes to the moved item, else the
  next sibling, else the parent. A polite live region announces "Moved Alpha under
  Work", "Moved Alpha to position 2 of 5", "Cannot move: folders can be at most 5
  levels deep".
- Visual: chevrons >= 24x24 CSS px, indentation guides, no colour-only cues, focus
  ring per theme, no expand animation under `prefers-reduced-motion`.
- The note's folder picker (`syncNoteFolderControl`, `app.js:14740`) becomes a
  grouped/indented list or the same "Move to..." dialog showing paths, still
  keyboard-first; folder names are escaped as now (`escapeHtml`).

### 7.2 Dragging, with a keyboard alternative

- Pointer drag: drag a folder onto another folder (becomes child), onto the gap
  between rows (reorder), drag a note onto a folder (sets `folder_id`, reusing
  `assignCurrentNoteFolder` logic for any note, not only the current one) and
  reorder notes inside a folder when manual order is on. Drop target shows a line
  or a highlight and a text hint, not colour alone.
- Every drag action has a non-drag equivalent (WCAG 2.5.7 Dragging Movements): the
  Alt+arrow keys above, "Move to..." dialog (folder tree + "Top level" + for notes
  also "Move up / Move down" menu items), and the context menu on long-press for
  touch (as for labels).
- Drag is an enhancement; the same `NotesFolders.planMove` / `planReorder` functions
  validate the result, so an invalid drop is refused with the same message as the
  keyboard path.
- Manual note order controls (menu items "Move up", "Move down", Alt+Up/Down in
  the folder note list) appear only when `notesManualOrder` is on and a folder is
  the active view.

---

## 8. Explicitly out of scope

- **Hierarchical tags via `/`** (`work/projects/alpha` in a tag name). Not done.
  Tags/labels keep their own parent model (section 1.2) and still **reject** `/` in
  names (`labels.js:29`). Folders reject `/` as well (I5). No splitting of names
  on `/`, no auto-creation of ancestors by typing a path, no conversion between
  folders and tags.
- Putting one note in several folders (a note keeps one `folder_id`; use labels for
  multi-membership). The UI text should explain the difference ("A folder is
  where a note lives; a label describes it") — copy to be settled in the UI task.
- Manual order of notes that are in no folder, and manual order inside Search
  results or smart views.
- Sharing folders between accounts (no per-folder sharing exists).
- Folder colours/icons, folder-level locks, folder templates.
- Server-side anything (search, sorting, counts, backup structure).
- A field-level merge of folder records.
- Joplin/Evernote importers themselves (only the mapping rules in 6.4).

---

## 9. Test plan

Pure-function tests (Node, like `tests/test_nested_labels.js`, which uses
`tests/sync_harness`) for a new `app/static/js/folders.js` (`NotesFolders`),
plus store/UI/wire tests. All must be deterministic: no clocks, no random uuid
in assertions.

**Cycle detection and breaking**
- Self parent (`a.parent_id = a`) -> root.
- 2-cycle (`aaa<->bbb`) -> `aaa` root, `bbb` under `aaa`; same result for any input order (shuffle 20x).
- 3-cycle with a tail (`ccc -> aaa -> bbb -> ccc`, plus `ddd -> bbb`) -> lowest id
  of the loop becomes root, the tail stays attached.
- Two independent cycles in one set -> each broken independently.
- Two "devices" with the same records in a different load order -> byte-identical
  effective tree (JSON of the tree).
- Write path: `planMove` rejects moving into own descendant (`cycle`) and into self.
- No record is removed or modified by the read-time repair; all notes still reachable.

**Orphans**
- Parent id unknown -> root, children travel with it, notes still counted.
- Parent is a tombstone (`deleted`) -> root.
- Parent is a tag/note uuid -> root.
- Parent arrives later (second pass) -> folder is under it again, no write happened.
- Note with a non-existent `folder_id` is "No folder" and the value is not rewritten.

**Depth limit**
- Create chain of 5 -> ok; the 6th is `too_deep`.
- Move a subtree of height 3 under a depth-3 parent -> `too_deep`; under depth-2 -> ok.
- Read-time: records forming depth 7 (from two devices) -> clamped to depth 5 under
  the depth-4 ancestor, deterministic across shuffles, descendants clamped too, no loss.
- Limit constant is read from one place; tests use it, not a literal.

**Ordering**
- `nextOrder`, midpoint insert, renumber when the gap is exhausted (insert 60 times
  between the same two); stable tie-break by name, then uuid.
- Legacy siblings without `sort_order` sort after ordered ones; the first reorder
  numbers all siblings and keeps the visible order.
- `note_order`: stale ids ignored, unlisted notes first (newest created first),
  duplicates in the array ignored, cap at 1000, a move of a note to another
  folder removes it from the visible order; concurrent LWW loses order only.

**Migration / compatibility**
- Legacy folder (`{type, title}`) reads as `name = title`, root; migration is lossless
  (all other fields and unknown fields kept) and idempotent (second run -> `[]`).
- Old-client simulation: a rename through today's `renameFolder` code path keeps
  `parent_id`, `sort_order`, `note_order`, `schema`, unknown fields; `title !== title_sync`
  is adopted as a new `name` (last segment) and `parent_id` is kept.
- Old-client delete of a parent -> children are roots, notes keep their `folder_id`
  in surviving folders.
- Unknown `schema: 3` record: round trip through upsert/persist/restore without loss.
- Duplicate sibling names from two devices: both displayed, no auto-rename.

**Back-up round trip**
- Build a vault with nested folders, orders and notes; `buildLocalBackup` ->
  restore into an empty vault -> identical effective tree, identical `sort_order`,
  `note_order`, `folder_id` (compare decrypted content). Same with a backup that
  contains a cycle and a dangling parent (restored data equals backup data; the
  view is repaired).
- Backup produced by new build, restored by a build that treats folders as flat
  (simulated): fields preserved.

**Features**
- Folder filter includes descendants; search scope and the "Folder" search field use the path;
  index signature changes on a parent rename.
- Rolled-up counts exclude trashed/templates; direct count still available.
- Delete: promote (children and notes go to the parent), delete subtree (notes
  unfiled, none deleted), undo restores all folders and every note's `folder_id`
  in one step; both modes are batched.
- Secure Send payload has no folder key or name.

**Zero-knowledge wire check** (as in `test_nested_labels.js`)
- Create, move, reorder and delete nested folders through the sync harness; assert
  every plaintext push/pull body contains only the existing keys and that the
  strings `parent_id`, `sort_order`, `note_order`, the folder names and the path
  separator appear nowhere in the plaintext request bodies, headers or URLs.

**UI (jsdom or the existing UI test style)**
- ARIA: `role=tree/treeitem/group`, `aria-level/posinset/setsize/expanded/selected`
  correct after expand, move and delete; one tabbable item.
- Keyboard: every key in 7.1 does its action; Alt+Arrows reorder/indent/outdent;
  rejected move announces the reason in the live region; focus after delete.
- Drag and drop produces the same data as the keyboard path (shared planner).
- Existing tests keep passing: `tests/test_round85_sidebar_folder_label.js`,
  `tests/test_label_tree.js`, `tests/test_nested_labels.js`.

---

## 10. Proposed implementation tasks

Small, independently shippable, each with its own tests. The first one must ship
before any nested data can exist.

1. **Compat prerequisite (old code path).** Audit/guard every folder rewrite
   (`store.js:4915`, `app.js:9768`, restore, conflict copy) to preserve unknown
   fields; tests for rename/undo/sync round trip with unknown fields. Update the
   `LOCAL_CACHE.md` folder row wording. No behaviour change.
2. **`folders.js` pure model.** `effectiveTree` (orphans, cycles, depth clamp,
   ordering), `validateParent`, `planMove`, `planReorder`, `planDelete`,
   `scope`, `pathOf`, rolled-up counts, migration. No UI, not wired. Tests from
   section 9 (cycles, orphans, depth, ordering, migration). Reuse `labels.js`
   helpers where they are generic.
3. **Store API.** `createFolder(name, parentId)`, `moveFolder`, `reorderFolder`,
   `deleteFolder(uuid, {children})`, `listFolders()` returning the effective
   order, `foldersTree()`; legacy callers keep working. Wire test for
   zero-knowledge and back-up round trip.
4. **Read path: filter, search, counts.** Descendant scope in `search.js:921` and
   `app.js:10562`, folder path in the "Folder" field and index signature, rolled-up
   counts. Still a flat list in the UI, so this is testable on its own.
5. **Tree UI (read-only + keyboard).** Generalise `labeltree.js`, replace
   `renderFolders`, ARIA tree, roving tabindex, expand/collapse, select, counts,
   "New sub-folder", rename, move via "Move to..." dialog, note picker with paths.
   Update the service worker/client manifest with `scripts/build-client-manifest.py`
   (changes `app/static`).
6. **Move/reorder UX.** Alt+arrow keys, live-region announcements, drag-and-drop
   with the keyboard/menu alternative, depth/cycle error messages.
7. **Delete folder (promote / subtree) + undo + copy.** Dialog text, batch undo,
   `DELETE_SPEC.md` "Folder delete" subsection.
8. **Manual note order.** `note_order`, `notesManualOrder` setting (+ add to
   `SETTINGS_SPEC.md`), list rendering and menu/keyboard controls inside a folder.
9. **Export/import mapping.** Directory paths in plain exports; document and test
   the Joplin/Evernote mapping rules once importers exist; restore with
   dangling/cyclic data.
10. **Docs and help.** Explain folders vs. labels in the help text, update
    `NOTES_ORGANIZATION_SPEC.md` (open question at `:523`), `LOCAL_CACHE.md`,
    `SETTINGS_SPEC.md`, `DELETE_SPEC.md`; optional unification of the label and
    folder cycle rule (4.2).

Open questions for review: (a) whether pinned notes stay on top in manual order
(2.3); (b) whether the sidebar keeps notes under folders inside the tree (7.1);
(c) whether to write back repairs (4.5); (d) whether `notesManualOrder` is
device-local or synced.
