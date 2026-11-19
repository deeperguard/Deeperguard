# Folders and the label tree — verified spec

Status: documentation only, no code change. Idea #109 (folders and nested
labels that work logically, with manual order). Every statement below is either
tied to a `file:line` in this tree, or to evidence captured from the running app
(section 2). Where something does **not** exist yet, it says so ("Not built").
The longer design discussion lives in `docs/NESTED_FOLDERS_SPEC.md` and
`docs/NOTES_ORGANIZATION_SPEC.md`; this file is the checked summary.

## 0. Blocking point check

**Structure is encrypted. There is no blocking point.** Label name, parent and
order are inside the AES-GCM ciphertext of the item; the server stores and
returns only opaque ciphertext plus generic columns (evidence in section 2).

Gaps found that are *not* privacy blockers, but the task text assumes them:

| Task assumption | Reality in this tree |
| --- | --- |
| Labels in the tree *are* the folders (one concept) | **Two concepts today**: `type:'tag'` items (labels, many per note, `note.tags`) and `type:'folder'` items (one per note, `note.folder_id`). Both reuse the same tree helpers (section 1.3). Unifying them is not built. |
| Own order of notes inside a label | **Built** (section 4): sort choice "Own order", `note_keys` inside the encrypted label record. Notes in a folder are still sorted by title (`store.js:5233`). |
| Folder view with optional sub-labels and breadcrumb | **Built** (section 7): breadcrumb `app.js:9480` `renderLabelFolderBar`, toggle "Include sublabels" `app.js:9466`-`9476` (per device, default on). |
| Keyboard indent / outdent / move up / move down | **Built** (section 8): Alt+Up/Down/Right/Left on a label row, plus "Move to..." in the actions menu. |
| Last writer wins *per field* | Today it is **per record** (one label = one record). See section 6. |

## 1. Inventory: where name, parent and order live

### 1.1 Label record (`type: 'tag'`)

An item whose decrypted `content` is:

| Field | Meaning | Written by |
| --- | --- | --- |
| `type` | `'tag'` | `defaultTag` `store.js:1097` |
| `name` | leaf name (no `/`, max 64) | `createTag` `store.js:5371`, `labels.js:planUpdate` |
| `parent_id` | uuid of parent label, `''` = top level | same |
| `order` | number among siblings, step 1024 (`labels.js:112` `nextOrder`) | same |
| `title` | compat path `"Parent / Child"` for old clients | `labels.js:planUpdate` |
| `title_sync` | the path we last wrote; detects a rename by an old client | `labels.js:repair` |
| `color`, `created_at`, `updated_at` | as before | |
| `__fid`, `__fv` | item id and freshness version added by the sync layer | `freshness.js` |

Limits (`labels.js:5-9`): depth 8 (`MAX_DEPTH`), 2000 labels, name 64 chars.
Notes point to labels by uuid in `note.content.tags` (`app.js:9455`); the note
record is never changed to represent the tree.

### 1.2 Folder record (`type: 'folder'`)

`defaultFolder` (`store.js:1085`): `{type, title, parent_id, order, created_at,
updated_at}`. Name is `title` (the helpers read `name ?? title`,
`labels.js:14`). A note has one `folder_id` (`store.js:1068`).
Create/move/delete: `store.js:5246`, `5268`, `5281`. Deleting a folder moves its
notes to the root and its subfolders up one level.

### 1.3 Files

| File | Role |
| --- | --- |
| `app/static/js/labels.js` | Pure model: validate name/parent, ancestors, descendants, depth, sibling-name rule, `planUpdate`, `planDelete`, `repair`, `migrate`. Used for both labels and folders. |
| `app/static/js/labeltree.js` | Pure tree: `childMap` (sorted by `order`, then name, then uuid), `visibleRows`, WAI-ARIA `html`, `navigate` (keys), `scope`, `moveTargets`, expand state in `localStorage`. |
| `app/static/js/store.js` | `createTag`/`moveTag` (`5371`, `5390`), `repairLabels` (`5405`), folder functions (`5246-5290`), sync + conflict handling (`3772`). |
| `app/static/js/app.js` | Sidebar tree and menu (`bindLabelTree` `9603`, `openLabelMenu` `9535`, move dialog `9582`), counts (`9450`), filter scope (`9445`), folder tree (`10112`, `10208`), manage dialog (`9712`). |
| `app/static/js/tagsuggest.js` | Label suggestions for new notes (not part of the structure). |
| `app/db.py:90` | Server table `items` (generic, no label columns). |

Tests: `tests/test_nested_labels.js`, `test_label_tree_integrity.js`, `test_label_tree.js`, `test_folder_model.js`,
`test_backup_folders_labels_roundtrip.js`, `tests/e2e_folder_tree.py`.

### 1.4 Plaintext on the device

`localStorage['notes_label_open']` holds the uuids of expanded labels only
(`labeltree.js:5,142`). It never leaves the device and contains no names.

## 2. Evidence from the running app (encrypted or readable?)

Method: local server started with the e2e helper (`tests/e2e_signup_autounlock.py`
`start_server`, `NOTES_STRICT_ZK=1`, fresh data dir), a throw-away account
registered through the UI form (`tests/e2e_share_target.py` `register`),
then in the page `NotesStore.createTag('ZQparentLabel')`,
`createTag('ZQchildLabel', parent)`, `createFolder('ZQfolderName')` and
`createFolder('ZQsubFolder', folder)`. The page's `fetch` was wrapped to log
`/api/sync` calls, `/api/sync/pull` was called, and the SQLite file was read.
Run date 2026-11-19. Nothing was changed in the repo.

To repeat it: start a server and register as above, call the four `create*`
functions in the page (`page.evaluate`), wait for the sync to finish, then run
`sqlite3 <data dir>/notes.db "select item_uuid, length(ciphertext) from items"`
and `grep -rlaF ZQparentLabel <data dir>`. The rows show only uuid and
ciphertext length, and `grep` finds no file. This is a manual procedure; no
script in the repo automates it. The existing `tests/e2e_folder_tree.py` covers
the client side (tree behaviour) but does not read the server database.

1. **In the client (decrypted)** the child label was:
   `{"type":"tag","title":"ZQparentLabel / ZQchildLabel","name":"ZQchildLabel",
   "parent_id":"bf522e32-72d5-4b5d-a690-497c11f70220","order":1024,
   "title_sync":"ZQparentLabel / ZQchildLabel", ...}` (order 1024 for the first
   child; the parent had `order: 1024`, `parent_id: ""`).
2. **On the wire** `POST /api/sync/items` carried, per item, only:
   `item_uuid, content_version, ciphertext, blob_ciphertext, content_hash,
   deleted, updated_at, sync_retry_key, sync_request_hash`, with
   `ciphertext` = `{"v":1,"iv":"c0HDen/UcW906xZ1","data":"lQMJ3QEf24bD..."}`
   (AES-GCM iv + base64 data). No `name`, `parent_id`, `order`, `title` or
   `type` key, and none of the marker strings.
3. **The server's reply** (`POST /api/sync/pull`, HTTP 200) returned the same
   shape plus `rev` and `synced_at`, with `deleted` as a number. Still only
   ciphertext.
4. **Server storage** (`data/notes.db`, table `items`): columns
   `id, user_id, item_uuid, content_version, ciphertext, content_hash, deleted,
   updated_at, blob_ciphertext, synced_at, rev`. Five rows (two labels, two
   folders, one system item), each `ciphertext` 337-513 bytes of
   `{"v":1,"iv":...,"data":...}`. `grep -rlaF` over the whole data directory
   (including the WAL file) for `ZQparentLabel`, `ZQchildLabel`, `ZQfolderName`,
   `ZQsubFolder` and `parent_id` found **no match**.

Conclusion: name, parent and order are encrypted. What the server can still see
is generic: that an item exists, its uuid, size, timestamps, the deleted flag,
and the number of items (so roughly how many labels and folders there are, but
not which item is which, since there is no type column). Parent/child links are
not visible. Ciphertext length grows with name length, as for any note.

## 3. One concept: label tree = folders

Decision recorded for the roadmap, with the current state:

- The **label tree is the folder tree**. A folder is a label you browse as a
  place. Target: one record type (`tag`), a note may carry several labels, and
  the folder view of a label lists the notes that carry it.
- Today the two types are separate (section 0). The tree code is already shared
  (`NotesLabels`, `NotesLabelTree`), so unification is a data migration
  (folder -> tag, `folder_id` -> an entry in `tags`), not a new tree. Not built.
- Nothing in this spec adds a plaintext field to the server; see section 2.

## 4. Own order of notes inside a label (built)

Storage, inside the encrypted label record only (`labels.js` `orderNotes`,
`moveNote`, `mergeNoteKeys`; `store.js` `moveNoteInLabel`):

```
note_keys: { "<note uuid>": { k: <number>, t: <epoch ms> }, ... }   // max 1000 entries
```

- `k` is a fractional index: append = last + 1024; prepend = first - 1024; insert
  between two notes = midpoint. When a neighbour has no key yet, or the gap falls
  below `1e-6`, the shown notes are renumbered in one write (step 1024).
- The note record is not touched: reordering never changes the note's
  `updated_at`, revisions or sync state. On the wire the keys only exist inside the
  label's ciphertext (`tests/test_note_manual_order.js`).
- Reading: sort listed notes by `k`, ties by note uuid. Notes of the label that
  have no entry (old notes, new notes) come **after** the keyed ones, newest
  `created_at` first, then uuid, so they never jump around. Entries for notes that
  are gone are dropped on the next write.
- Why a map and not an array of uuids (the earlier design in
  `NESTED_FOLDERS_SPEC.md` 2.3): each reorder touches one key, so two devices
  can be merged per note (section 6) instead of one whole list winning.
- It is the sort choice "Own order" next to Recent / Date created / Title. The
  choice is stored as the boolean setting `notesManualOrder`; the existing `sort`
  enum is not extended, so older clients keep their own value. Own order applies
  only while one label is selected (not "No label", not Files, not while searching);
  elsewhere the list uses `sort`. Pinned notes follow the manual order there.
- Moving: Alt+Up / Alt+Down on a note row, or the move-up / move-down buttons of
  the row; focus stays on the moved row and a toast reports the new position.
  Notes of sub-labels shown in the same view are ordered by the selected label's keys.
- Folders (the separate `folder` type) have no own order; they stay sorted by title.
- Sibling labels have the plain number `order` (`labels.js` `nextOrder`), same step
  1024; it is only changed by append on create/move, there is no reorder action.

## 5. Rules against cycles (built)

- Setting a parent is refused when the parent is the label itself or one of its
  descendants (`labels.js:97-105`, error `cycle`), when the parent is unknown, or
  when `parent depth + subtree height > 8` (`too_deep`). The move dialog only
  offers valid targets (`labeltree.js:moveTargets`, `app.js:9582`). A refused
  move (dropping a label on one of its own sub-labels, or a target that changed
  meanwhile) shows the reason as an error toast: `NotesStore.moveTagResult`
  returns the error code and `labels.js` `moveErrorText` gives the sentence, for
  `cycle`: "A label cannot be moved into itself or one of its own sub-labels."
- A sibling may not have the same name (case-insensitive, trimmed;
  `labels.js:siblingNameTaken`); same name in different branches is fine.
- Concurrent edits can still produce a cycle that each device found valid. Two
  repairs handle it, both without deleting data:
  - **On read, in memory:** `labeltree.js:25` `childMap` shows orphans (unknown
    parent), self-parents and cycle members at the top level.
  - **On unlock, persisted:** `repairLabels` (`store.js:5405`, called at
    `app.js:7085`) runs `labels.js:144` `repair`: unknown parent -> top level; in a
    cycle, the link of the member with the oldest `updated_at` (tie: lower uuid)
    is set to top level. Idempotent.
- Deleting a label never deletes notes. Default: sub-labels move to the deleted
  label's parent (`labels.js:217` `planDelete`); "Delete with sub-labels"
  removes the subtree. Notes keep their (now dangling) label ids, which the
  counts and tree ignore (`app.js:9456`).

## 6. Sync and concurrent changes

What happens today (`store.js:3772` `resolvePushConflict`):

- Granularity is the **record**: a label (or folder) is one item. When a push
  collides with a newer server revision, for `tag`/`folder` the copy with the
  later `updated_at` wins whole (`store.js:3852`); the loser's edit to that
  label is dropped. Different labels never collide with each other.
- Edit beats delete: if the server copy is deleted and the local one is edited,
  the edit wins (`store.js:3808`).
- **Notes are never lost** by tree changes: notes are separate records, the tree
  only stores references to them, and note conflicts keep a "(conflict copy)"
  (`store.js:3827`).
- Invalid combinations from two valid edits are repaired by section 5.
- Offline edits are queued and pushed later through the same path.

Built for `note_keys` only (`store.js` `resolvePushConflict`, log `conflict-note-keys-merge`): two devices that reorder the same label are merged per note uuid using
`t`, so a reorder on one device does not discard a reorder of other notes on
another and no note disappears; the label's own `name`, `parent_id` and `order` stay
whole-record last-writer-wins.

Target (not built): *last writer wins per field* for `name`, `parent_id` and `order`
too, so two devices that rename and move the same label both keep their change,
and a reorder on one device does not discard a reorder of other notes on
another. Order/move losing is the worst case; a note or label is never deleted
by a merge.

## 7. Folder view

Built:

- Selecting a label (`app.js:9519` `selectLabel`) filters the note list. With
  "Include sublabels" on (default) it matches the label **or any sub-label**
  (`app.js:9474` `currentTagScope`, `labeltree.js` `scope`); with it off, only
  notes that carry the label itself.
- The header of the view (`#label-folder-bar`, `app.js:9480` `renderLabelFolderBar`)
  shows the breadcrumb "All notes / A / B": each ancestor is a button that
  navigates there (`app.js:21033`), the current label is `aria-current="page"`.
  The sublabel checkbox is hidden when the label has no sublabels, and "New note"
  creates a note with the current label.
- The sublabel choice is stored per device in `localStorage` under
  `notes_label_include_subs` as `1` or `0` (`app.js:9466`-`9476`). If storage
  refuses the key, the toggle shows its default (on) and the choice is not kept:
  the code reads storage on every check, so an unchecked box has no effect there.
- Selecting a folder shows `notesInFolder(id)` (`store.js:5233`), direct notes
  only, sorted by title. "All notes" clears it.
- The manage dialog and move dialog show the full path
  (`labels.js:pathOf`, `"A / B / C"`).

Not built: a breadcrumb or toggle for folders (`type:'folder'` items); the
folder view only covers labels.

## 8. Keyboard actions

Label and folder trees use roving tabindex and the WAI-ARIA tree pattern
(`labeltree.js:101` `navigate`; handlers `app.js:9622`, `10179`).

Built (focus is on a tree row):

| Key | Action |
| --- | --- |
| Down / Up | next / previous visible row |
| Home / End | first / last row |
| Right | collapse -> expand; expanded -> first child |
| Left | expanded -> collapse; else go to parent |
| Enter / Space | select (filter on this label/folder; again = clear for labels) |
| F2 | rename |
| Shift+F10 / Menu key | actions menu (New sub-label, Rename, Move to..., Delete) |
| Delete | delete folder (confirmation); labels via the menu |
| Arrow keys, Esc, Tab in the menu | move through items, close (focus returns) |

Move chords (`app.js` label tree `keydown`, `labeltree.js` `siblingStep` / `levelStep`).
"Move to..." in the menu offers any valid parent (appended at the end). The chords
do not collide with the browser or with existing shortcuts (`/`, Ctrl/Cmd+K,
Ctrl/Cmd+N, Ctrl/Cmd+Alt+N), and match `NESTED_FOLDERS_SPEC.md` 7.1:

| Chord | Action | Validation |
| --- | --- | --- |
| Alt+Up | move up among siblings (swap `order` with previous sibling, midpoint) | none needed; no-op at the top |
| Alt+Down | move down among siblings | no-op at the bottom |
| Alt+Right | indent: become the last child of the previous sibling | `validateParent` (cycle, depth 8, sibling name) |
| Alt+Left | outdent: become the sibling after the current parent | no-op at top level |

Each keeps focus on the moved row and announces the result (or the refusal reason) in the
polite toast live region (`#toast`, `role=status`). Each has a menu entry or equivalent so mouse and touch users
reach it without a chord. Drag and drop (`bindLabelDrag` in `app.js`; mouse on the
row, touch on the grip) and Alt+ArrowUp/Down are extras, not the only way. A drop
between two labels writes only `order` (`labeltree.js` `dropPlan`), a drop on a
label also writes `parent_id`; both stay inside the encrypted label record.
