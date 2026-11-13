# Notes organisation: nested labels, templates, note links and backlinks (specification)

Status: design. Nothing in this document is implemented yet. It describes what
will be built, so that code, tests, PRIVACY.md and the in-app texts can be
checked against one source. Roadmap idea #53 (size M).

Goal: let people organise many notes (nested labels, templates) and connect them
(links with backlinks), at least as well as Obsidian, Joplin, Evernote and
Notion, **without weakening zero-knowledge**.

Hard rules that run through every section:

- **No new readable fields go to the server.** Everything new (label parent,
  order, template flag, link targets, backlinks) lives inside the existing
  AES-256-GCM ciphertext of an item, or only in browser memory. The server API,
  its database columns and its logs do not change.
- **The backlink index exists only client-side.** It is built from decrypted
  notes in the browser, never sent anywhere, never persisted in plaintext.
- Link, label and template text is untrusted user content: rendered as text or
  through the existing sanitiser, never as HTML.
- Every migration is lossless and idempotent, and old clients keep working.

## 0. What exists today

Read from the code, not assumed:

| Piece | Where | Notes |
| --- | --- | --- |
| Encryption | `NotesCrypto.encryptObject(key, obj)` in `app/static/js/crypto.js` | `JSON.stringify(obj)` -> AES-256-GCM (noble `gcm`), random 12-byte IV, no AAD. Output `{v:1, iv, data}` (base64). Key is the vault key derived from the password (Argon2id); it stays in memory and is zeroed on `lock()`. |
| Sync row | `wrapItem`-style builder in `store.js` (about line 1680) | `{item_uuid, content_version, ciphertext, blob_ciphertext, content_hash, deleted, updated_at}`. One ciphertext **per item**; `content_hash` = hash of the ciphertext string. Endpoints: `/api/sync/pull`, `/api/sync/items`, `/api/sync/item/<id>`, `/api/sync/refetch`. |
| Item types | `content.type` inside the plaintext: `note`, `folder`, `tag`, `attachment`, `totp`, `agenda_pack`, ... | `listNotes()` = items with `type === 'note'` and not deleted. Unknown types are still synced as opaque ciphertext. |
| Note | `defaultNote()` | `title, content, tags: [tagUuid], folder_id, attachments, revisions, editor, starred, pinned, archived, trashed, locked, created_at, updated_at`. |
| Label ("tag") | `defaultTag()`, `listTags`, `renameTag`, `setTagColor`, `deleteTag`, `mergeDuplicateTags` | A **separate encrypted item** `{type:'tag', title, color, created_at, updated_at}`. Notes reference it by uuid in `note.tags`. Labels are **flat**; sorting is alphabetical by title. |
| Folder | `defaultFolder`, `listFolders` | Flat too: `note.folder_id`, no parent. Out of scope here. |
| Freshness | `freshness.js` (`__fid`, `__fv`) | Per-item version counter inside the ciphertext, used to detect stale writes. Applies to every tracked type. |
| Conflicts | `makeConflictCopy` in `store.js` | Concurrent note edits produce a "(conflict copy)" note. Agenda packs have their own field-level merge (`mergeAgendaPacks`). |
| Markdown | `app/static/js/markdown.js` | Links are only rendered when the target matches `^(https?://\|mailto:)`; everything else is dropped. A `dg-note:` target therefore needs explicit renderer support (phase 3). |
| Tag suggestions | `tagsuggest.js` | Matches note text against existing tag titles. Must keep working with nested names. |
| Existing scale benchmark | `tests/bench_agenda_scale.js` | Manual `node` script with `vm.runInThisContext`; the model for the benchmark in section 4. |

Known hazard found while reading: `mergeDuplicateTags()` groups labels by
**title only** (lower-cased) and deletes the extras. Any design that keeps a leaf
name such as `Alpha` in `title` for two different parents would be silently
merged by an old client. Section 1 is shaped around this.

## 1. Nested labels

### 1.1 Options

A. **Separate encrypted object per label with `parent_id` and `order`**
   (extend the existing `type:'tag'` item).

B. **Hierarchy as a path inside the payload**, e.g. label title `Work/Projects/Alpha`;
   the tree is derived by splitting on `/`.

### 1.2 Choice: A, with a compatibility `title`

Chosen: **A**. Motivation:

- Labels are already separate items referenced by uuid. Notes do not change at
  all (`note.tags` stays a flat list of uuids), so there is **no bulk rewrite of
  notes** and no sync storm for users with thousands of notes.
- Renaming or moving a label touches **one** item (plus cheap descendants'
  compatibility titles, see below), not every note that uses it. With B a rename
  of a parent must rewrite every label below it, and the path string is the
  identity, so two devices renaming concurrently produce duplicates.
- B cannot express order, empty parents, or a stable id for a label that is
  renamed on two devices. A can.
- Colour, future icon and order live on the same object.

Cost of A, and the answer: old clients read only `title`. So the new client keeps
`title` filled with the **full path** (`"Work / Projects / Alpha"`, separator
` / `). Old clients then see a unique, meaningful flat label, and
`mergeDuplicateTags()` cannot merge two different branches because their titles
differ. This gives B's compatibility without B's identity problem.

### 1.3 Record shape

Inside the encrypted payload (snake_case like the rest):

```
{
  type:        "tag",
  title:       string   // legacy/compat: full path "A / B / C"; written by new clients, read by old ones
  name:        string   // NEW: the leaf name shown in the tree ("C"); absent on legacy labels
  parent_id:   string   // NEW: uuid of the parent label, "" or absent = root
  order:       number   // NEW: sort key among siblings (see 1.5); absent = legacy
  title_sync:  string   // NEW: the `title` this client last derived; used to detect edits by old clients (1.6)
  color, created_at, updated_at   // unchanged
}
```

Rules:

- Absent `name` means a legacy flat label: `name := title`, `parent_id := ""`.
- `name` is 1-64 chars, trimmed, may not contain ` / ` or `/` (the UI rejects it;
  legacy labels that already contain `/` stay root labels with an unchanged name,
  and are never split automatically; the user may choose "Convert a/b into
  nested" explicitly).
- Sibling names are unique case-insensitively (same rule the tag UI already
  applies to flat labels).
- Maximum depth 8, maximum 2 000 labels per vault (soft limits, enforced in the
  client UI and on import; they keep the tree and the ARIA tree usable).
- A note keeps only the labels it was given. **Filtering by a parent includes all
  descendants** (computed in the client); notes are not auto-labelled with
  ancestors. The label count shown in the tree is "this label" / "including
  sub-labels".

### 1.4 Delete, move, merge

- Deleting a label that has children: the dialog offers "Move sub-labels up" (default)
  or "Delete sub-labels too". Notes lose the label, never the note. Deletion uses
  the existing `remove()` tombstone.
- Moving = change `parent_id` (+ `order`) on that one item, then refresh the
  compatibility `title` of the subtree. Moving into own descendant is rejected.
- `mergeDuplicateTags()` is changed to group by `(parent_id, lower(name))`.

### 1.5 Order

`order` is a number; siblings sort by `order`, then `name` (locale compare), then
uuid, so the result is deterministic on every device. New labels get
`last order + 1024`; inserting between two uses the midpoint. When the gap drops
below `1e-6` the siblings are renumbered in one pass (idempotent). Concurrent
reorders on two devices may interleave; the tie-break keeps the result stable and
nothing is lost.

### 1.6 Conflicts, cycles, orphans

Labels are small, so item-level last-writer-wins with the existing `__fv`
freshness check applies. Because two devices can produce an inconsistent tree,
the loader **repairs on read, in memory, then writes the repair once**:

- Parent uuid unknown or deleted -> treat as root (orphan), and write `parent_id: ""`.
- Cycle (A under B under A) -> break at the label with the oldest `updated_at`
  parent link: it becomes a root. Deterministic, so all devices choose the same one.
- Duplicate sibling names after a merge of two devices -> shown as is; the user
  can merge. Never auto-deleted.
- `title !== title_sync` (an **old client renamed** the label): adopt the new
  `title` as the leaf `name`, keep the parent, then rewrite `title`/`title_sync`.
  Nothing the old client typed is lost.

### 1.7 Migration of existing flat labels

Lossless and idempotent. There is **no one-shot bulk migration** and no schema
flag:

1. A legacy label (no `name`) is interpreted as `name = title`, root, order by
   current alphabetical position. This is a pure read; nothing is written.
2. A label is only written in the new shape when the user edits it (rename, move,
   reorder, recolour) or creates a child under it. At that moment `name`,
   `parent_id`, `order`, `title_sync` are added; existing fields, `color`, uuid and
   all `note.tags` references stay.
3. Re-running the interpretation or the write is a no-op (same input -> same
   output; `upsert` already skips unchanged content).
4. Optional, user-initiated "Organise labels" helper proposes nesting for labels
   that contain `/`, `>` or `::` (Obsidian/Joplin/Evernote import habits). It shows
   a preview and a count, applies in one step, and is undoable by moving labels.
5. Importers (`snimport.js` etc.) that carry a path (`a/b/c`) create the chain of
   labels with `name`/`parent_id`.

Backup/export: nested labels export as the path in `title` for formats that only
know flat tags, and as a structure in our own JSON.

### 1.8 Behaviour of older clients

| Situation | Old client does | Result |
| --- | --- | --- |
| Reads a nested label | Shows `title` = `"Work / Projects / Alpha"` as one flat label | Usable, clearly hierarchical by name. |
| Adds/removes a label on a note | Edits `note.tags` by uuid | Works unchanged; the new client sees the same uuids. |
| Renames a nested label | Rewrites `title`, drops nothing (the `{...content}` spread keeps unknown fields: `name`, `parent_id`, `order`, `title_sync`) | New client detects `title !== title_sync` and adopts it (1.6). |
| Deletes a parent label | Tombstones one item; children keep a dead `parent_id` | New client treats them as orphans at root (1.6). |
| Runs `mergeDuplicateTags()` | Merges by full-path title | Safe: different branches have different titles. |

Prerequisite for shipping (phase 1): verify with a test that **every** place that
rewrites a tag item or a note on the old code path preserves unknown fields. The
code paths reviewed (`renameTag`, `setTagColor`, `deleteTag`, `upsert` of notes
with `{...note.content}`) all spread the existing content; any that do not must be
fixed first, in a release that precedes the first nested label a user can create.

## 2. Templates

### 2.1 Storage: a note with an encrypted flag

Chosen: a **normal note** with `is_template: true` inside the encrypted payload,
not a new item type.

Why: templates then reuse the editor, Markdown, attachments, labels, revisions,
trash, sync, conflict copies and export with no new code path and no new
ciphertext shape. A separate type would duplicate all of that and every importer
and the backup code would need to learn it. Trade-off: an old client lists
templates among normal notes (it ignores the flag). That is acceptable and even
useful (they are still readable); the new client hides them from the default note
lists, search "all notes", backlinks (2.4) and the "recent" view, and shows them
under "Templates". Old clients preserve the flag when saving (same spread rule as
1.8).

Fields: `is_template: true`. A template keeps `title` (the template name), `content`,
`tags`, `folder_id`. Optional `template_title`: the pattern for the new note's title
(default `{{title}}`).

### 2.2 Variables

Filled **purely client-side** at the moment a note is created from the template.
The server never sees a template or its result differently from any other note.

| Variable | Result |
| --- | --- |
| `{{date}}` | Local date, `YYYY-MM-DD` |
| `{{time}}` | Local time, `HH:mm` (24 h) |
| `{{title}}` | The title the user typed in the "new from template" prompt; empty prompt -> `Untitled` |

Parameters: `{{date:DD-MM-YYYY}}` and `{{time:HH:mm:ss}}` accept a small allow-list
of format tokens (`YYYY MM DD HH mm ss`). Unknown variables are left as typed
(`{{foo}}` stays `{{foo}}`), never evaluated; there is no scripting and no
expression language. Output is inserted as text in the editor, not as HTML.
Escaping: `\{{date}}` stays literal.

New note from template: copy `content`, `tags`, `folder_id`, `editor`; clear
`is_template`, `pinned`, `starred`, `locked`, `revisions`, `attachments` (attachments
are not copied in phase 4; stated in the UI); set fresh `created_at`/`updated_at`
and a new uuid.

Also: "Save as template" on any note (copy with the flag), and "Insert template"
into an open note at the cursor (variables replaced the same way).

### 2.3 Not in scope

Template folders, per-template shortcuts, and date arithmetic (`{{date+1d}}`).

## 3. Note links

### 3.1 Syntax

- **Typing syntax:** `[[Title]]` (and `[[Title|alias]]`). While typing, an
  autocomplete list of matching note titles opens after `[[`.
- **Stored form:** a stable Markdown link with the note id:
  `[Title](dg-note:<uuid>)`. When the user confirms a suggestion, or leaves the
  `[[...]]` span, the editor rewrites it to the stored form. The uuid is the
  existing item uuid of the target note (RFC 4122 v4 from `newUuid()`).
- A `[[Title]]` that matches no note, or several, stays as typed text until
  resolved; it is **not** a link and is not indexed. On several matches the picker
  asks. Pasting `[[Title]]` from Obsidian is resolved by title on import (section 3.5).

Because the stored form is a standard Markdown link, the note stays readable in any
Markdown viewer and in exports; the `dg-note:` target simply does not open there.

### 3.2 Rendering

- `markdown.js` today only keeps `https?:` and `mailto:` targets. Add a **narrow**
  allowance: target matching `^dg-note:[0-9a-f-]{36}$`, rendered as an in-app link
  (`<a href="#note/<uuid>" data-dg-note="<uuid>">`), never as a navigable `dg-note:`
  URL. Any other scheme stays rejected. No new HTML is allowed through.
- The visible label is the **link text in the note**; the current title of the
  target is shown as the accessible name/tooltip when they differ.
- Click/Enter opens the target note in the same pane; Ctrl/Cmd-click or
  middle-click opens in a new pane/tab where that exists. Hover/focus shows a
  short preview of the target text (decrypted locally; trashed or locked notes
  show no preview).

### 3.3 Rename behaviour

The link keeps working because it points at the **uuid**. The display text is
updated by the client:

- When a note's title changes, links whose text equals the **old title** are
  rewritten to the new title in the notes that link to it (found through the
  backlink index, section 4). Links whose text was edited by the user (alias) are
  not touched.
- That rewrite is a normal edit of each linking note (`touchUpdatedAt: false`, as
  `deleteFolder` already does for system edits), batched and shown as one undo
  step "Updated N links". Over 200 linking notes, the user confirms first.
- If the rewrite has not happened yet (other device offline, old client), the link
  still resolves; only the text is stale. The renderer shows the old text with the
  new title as accessible name. Nothing breaks.

### 3.4 Dead links

A target uuid is **dead** when the note is deleted (tombstone), in the trash, or
unknown (not in the vault of this account, e.g. pasted from another account):

- Rendered visibly different, not by colour alone: strike-through dotted underline,
  a "broken link" icon, and `aria-label="Link to missing note: <text>"`.
- Activating it shows a message ("This note is deleted or not in your vault"), with
  actions: "Restore from trash" (if trashed), "Create note with this title", "Remove link".
- Trashed notes keep their backlinks; restoring brings the links back to normal.
- Dead links are listed in the note's "Links" panel so they can be cleaned up.
- Unknown ids are never fetched from the server and never reveal whether a uuid
  exists in another account.

### 3.5 Import and export

- Import of `[[Title]]` (Obsidian) and Joplin `[Title](:/<id>)` resolves targets by
  title/id inside the imported set, then writes the stored form; unresolved ones
  stay as text and are counted in the import summary.
- Export to Markdown writes `[Title](dg-note:<uuid>)` by default, with an option
  "plain `[[Title]]`" for Obsidian users.

## 4. Backlink index

### 4.1 Definition

`backlinks: Map<targetUuid, Array<{sourceUuid, count}>>` plus the forward map
`outgoing: Map<sourceUuid, Set<targetUuid>>`, built from **decrypted** note
content by scanning for `\]\(dg-note:([0-9a-f-]{36})\)`. Templates, trashed notes
and archived notes are scanned but flagged so the UI can hide or show them.
Links inside fenced/inline code are ignored.

### 4.2 Where it lives: memory only (decision)

- **Chosen: memory only.** Built after unlock, discarded on `lock()`, logout and
  tab close, together with the decrypted items it was derived from. Nothing is
  written to IndexedDB, `localStorage`, `sessionStorage`, the service-worker cache
  or the server.
- **Rejected for now: an encrypted local cache of the index.** It would be only an
  optimisation. LOCAL_CACHE.md already stores items as ciphertext; a second
  encrypted blob would have to be invalidated on every edit/sync and must never
  exist in plaintext. It is reconsidered only if the budget below is missed on
  the reference hardware; if added, it is encrypted with the vault key like every
  other item, keyed by `(note uuid, content_hash)` so stale entries are ignored.
- The index is never synced. Every device builds its own, so there is nothing for
  the server to see or for a sync conflict to corrupt.

### 4.3 Updates

- **Initial build** after unlock, once decryption of items has finished: one pass
  over `listNotes()`, in chunks of 250 notes per task with `await` between chunks
  so the UI stays responsive. The panel shows "Indexing..." until done; link
  features degrade to "no backlinks yet", never to wrong results.
- **Local edit:** debounced (300 ms) re-scan of that one note: remove its old
  outgoing set from `backlinks`, add the new one. Cost is proportional to one note.
- **Sync pull:** for every item whose `content_hash` changed (or that was
  tombstoned), re-scan that item only. Unchanged items are skipped.
- **Delete/trash/restore:** update flags, no re-scan.
- Per-note memo: `lastHash` (the item `content_hash` or a hash of `content`) so an
  unchanged note is never re-scanned.
- Rename of a note: only the title lookup changes; links point at uuid and need no
  re-index. The text rewrite in 3.3 triggers the normal edit path.

### 4.4 Performance budget

Reference: a mid-range laptop (4 cores, 8 GB, Chrome stable), notes averaging
2 KB, 10 % containing 5 links each.

| Operation | Notes | Budget (median of 10 runs) | Hard fail (p95) |
| --- | --- | --- | --- |
| Initial index build (scan only, decrypted text in memory) | 5 000 | **<= 150 ms** total, longest single task <= 50 ms | 300 ms |
| Initial index build | 20 000 | <= 600 ms | 1 200 ms |
| Incremental update after one edit | 1 | <= 2 ms | 10 ms |
| Incremental update after a sync pull of 100 changed notes | 100 | <= 20 ms | 60 ms |
| Backlink lookup for one note | any | <= 0.1 ms | 1 ms |
| Extra heap for 5 000 notes | 5 000 | <= 2 MB | 5 MB |
| Label tree build + counts (incl. descendants) | 2 000 labels, 5 000 notes | <= 30 ms | 80 ms |

Decryption is **not** part of this budget; it already happens on unlock and is
measured separately. The index must not add a second pass of decryption.

### 4.5 Measurement method

- A manual benchmark `tests/bench_notes_links.js` in the style of
  `tests/bench_agenda_scale.js`: `node tests/bench_notes_links.js [notes] [links%]`.
  It generates a deterministic corpus (seeded PRNG, so runs compare), including
  worst cases (one note linked from every other note; 1 MB note with 5 000 links;
  notes with `[[` inside code fences), and prints median/p95 over 10 runs after
  2 warm-up runs, using `performance.now()`.
- A cheap regression test in the normal suite (`tests/test_notes_links.js`) runs the
  5 000-note build with a **generous ceiling** (5x the budget) so CI machines do
  not flake, and asserts algorithmic properties instead (build is linear: time for
  10 000 notes < 3x time for 5 000; the incremental update does not read other notes).
- Browser check on real hardware: `performance.mark`/`measure` around the build,
  plus the Long Tasks API (no task over 50 ms) recorded in a run of the existing
  Playwright-style scripts (`tests/run_agenda_browser_checks.py` is the pattern).
  Results go into the PR description with the CPU model.

## 5. Threat model

### 5.1 What the server sees

New data in this feature, and where it is:

| Data | Where | Server sees |
| --- | --- | --- |
| Label name, parent, order, colour | Inside the label item's ciphertext | Nothing readable |
| Note-to-label relation | `note.tags` inside the note ciphertext (unchanged) | Nothing readable |
| `is_template`, `template_title` | Inside the note ciphertext | Nothing readable |
| Links `dg-note:<uuid>` | Inside the note ciphertext | Nothing readable |
| Backlink/outgoing index | Browser memory only | Never leaves the browser |

**No new readable fields are sent to the server.** No new endpoint, column,
header, query parameter or log line is introduced; the sync payload keeps the
shape `{item_uuid, content_version, ciphertext, blob_ciphertext, content_hash,
deleted, updated_at}`.

### 5.2 What the server can still learn (honest list)

- **Ciphertext sizes.** AES-GCM adds a constant overhead, so the size of an item
  is the size of its plaintext plus a fixed amount. A note with many links is
  slightly larger; a label with a long path is slightly larger; a template is the
  size of its text. The server can see the size of each item, and how it changes
  when it is edited. We do not pad, as that costs storage and mobile data; this is
  already listed in PRIVACY.md ("ciphertext sizes").
- **Counts.** The number of items of the vault grows when labels or templates are
  created. The server cannot tell a label from a note by content; it sees many small
  items versus a few big ones, and the pattern can hint at the kind. This is not new,
  tags are already separate items.
- **Timing.** Moving a parent label rewrites its subtree's compatibility `title`
  (section 1.3), i.e. a burst of small writes. The server sees a burst of item updates
  at one moment, not which labels or why. Renaming a note with many backlinks causes a
  burst of note updates (3.3), which reveals "something many notes depend on changed".
  Mitigation: batching, and the burst is the same shape as a normal multi-note edit.
- **Update graph.** Which items change together is visible by time. Not preventable
  without making sync noisy.
- Not leaked: link graph, label tree shape, titles, template use, which notes link to
  which, and any search over them. The link target uuid is a random v4 uuid; it is
  inside the ciphertext.

### 5.3 Other risks

| Risk | Mitigation |
| --- | --- |
| Link text or label names used for XSS | Rendered through the existing sanitiser; `dg-note:` only accepted with a strict uuid pattern and turned into an internal anchor; names escaped everywhere (`textContent`). |
| A shared note exposes ids of other notes | Share links (SHARE_LINK_CRYPTO.md) must **strip or neutralise** `dg-note:` links to notes not in the shared set: rendered as plain text. Checked in phase 3 tests. |
| Index in plaintext on disk | Memory only (4.2); cleared on lock. A test asserts nothing is written to storage. |
| Index grows unbounded / DoS by a huge note | Cap scan per note (1 MB and 2 000 links); excess ignored and flagged. |
| Cycles in labels, huge trees | Repair on read (1.6), depth and count limits (1.3). |
| Log leakage | Titles, names, uuids of linked notes never go to `console`, error messages, toasts or analytics. |
| AI features | Any "ask AI" outbound preview must treat link text as note text; nothing about the index is sent. |

## 6. UX and accessibility

### 6.1 How other apps do it (short)

| App | Nesting | Links / backlinks | Templates | Takeaway |
| --- | --- | --- | --- | --- |
| Obsidian | Nested tags `a/b/c` in a tag pane; folders separate | `[[Note]]`, backlinks pane, unlinked mentions, rename updates links | Core plugin, `{{date}}`, `{{time}}`, `{{title}}` | Best linking model; text-based ids by title (breaks on rename unless updated). Variables are the same three we chose. |
| Joplin | Nested notebooks; tags flat | Links by id `[T](:/id)`, no real backlinks | Plugin / templates folder | ID-based links survive rename (our choice); backlinks missing. |
| Evernote | Notebooks + stacks (2 levels); tags nested | Note links by id; "backlinks" via a related-notes panel | Templates gallery | Id links, stable; shallow nesting. |
| Notion | Pages nest arbitrarily; no tags tree | `@` mentions, backlinks section | Template buttons | Smooth `@`/`[[` picker; backlinks list at the page bottom. |

We aim for: Obsidian's `[[` flow and backlinks panel, Joplin/Evernote id stability,
Notion's low-friction picker, and none of them is zero-knowledge.

### 6.2 Label tree: ARIA tree pattern

Follows the WAI-ARIA Authoring Practices **Tree View** pattern.

- Container `role="tree"` with `aria-label="Labels"`; each label `role="treeitem"`
  inside `role="group"` for children. `aria-level`, `aria-setsize`, `aria-posinset`
  are set explicitly (the tree can be virtualised). `aria-expanded` only on labels
  with children. `aria-selected` marks the active filter; the count is part of the
  accessible name ("Alpha, 12 notes, 3 with sub-labels").
- Roving tabindex: one tab stop for the whole tree.
- Keys: Up/Down move between visible items; Right expands, or moves into the first
  child; Left collapses, or moves to the parent; Home/End first/last visible;
  Enter/Space selects (filters notes); `*` expands all siblings; type-ahead
  jumps by name; `F2` renames; `Delete` deletes (with confirm); **Alt+Up/Alt+Down**
  reorders among siblings and **Alt+Left/Alt+Right** outdents/indents (move under
  the previous sibling). Context menu key or Shift+F10 opens the menu with
  "New sub-label", "Rename", "Move to...", "Colour", "Delete".
- Drag and drop is an enhancement only: everything it does has a keyboard and a
  "Move to..." dialog equivalent (WCAG 2.5.7 Dragging Movements).
- Focus is never lost: after delete or move, focus goes to the next sibling, else the
  parent. Changes are announced in a polite live region ("Moved Alpha under Work").
- Visual: indentation lines, chevron toggles at least 24x24 CSS px, colour never the
  only carrier of information, contrast and focus ring per the existing theme, works
  at 200 % zoom and with `prefers-reduced-motion` (no expand animation).
- Mobile: swipe is not required; long-press opens the same menu; expand targets are
  large enough for touch.

### 6.3 Other controls

- `[[` picker: `role="combobox"` + `aria-controls` listbox + `aria-activedescendant`
  (APG combobox pattern); results announced ("5 notes").
- Backlinks panel: a heading "Linked from (N)" with a list of links; each item shows
  the source title and a snippet around the link, text only. Empty state explains
  how to link. While indexing: "Indexing links..." (`aria-busy`).
- Dead links: see 3.4; icon plus text, not colour only.
- Templates: a "New from template" menu with a keyboard-reachable list and a preview
  of the filled variables before creating.

## 7. Phases (separate PRs, tests per phase)

Each PR is small, reviewable alone, and leaves the app working. Tests are node
tests in `tests/test_*.js`, like the existing ones; client manifest is regenerated
(`scripts/build-client-manifest.py`) in each PR that touches `app/static`.

| Phase | Content | Tests |
| --- | --- | --- |
| 0 | **Compat prerequisites** on the old code path: `mergeDuplicateTags` keyed by `(parent_id, name)` (falls back to title for legacy); confirm all tag/note rewriters spread unknown fields; tolerate unknown fields. Ship **before** phase 1 data can exist. | Unknown fields survive rename/colour/delete-child/merge round trip; legacy duplicate merge behaves as before. |
| 1 | **Label model + tree data**: `name`, `parent_id`, `order`, `title_sync`; pure functions to build the tree, derive the path title, repair orphans/cycles, descendants filter; store functions create/move/reorder/delete. No UI change beyond a flat list still working. | Lossless read of legacy labels; idempotent write; path title derivation; cycle and orphan repair deterministic across two simulated devices; old-client rename adopted; depth/count limits; sibling uniqueness; deleting a parent with both options; `noteCountForTag` including descendants. |
| 2 | **Label tree UI** with the ARIA tree pattern, keyboard moves, "Move to..." dialog, counts, optional "Organise labels" helper, importer path support, `tagsuggest.js` with names. | DOM-stub tests for roles/attributes, roving tabindex, every key in 6.2, focus after delete/move, live region text, no drag-only action; importer creates chains. |
| 3 | **Note links**: `[[` picker, stored `dg-note:` form, renderer allowance, dead-link rendering and message, title-rename rewrite, share-link neutralisation, import/export. | Renderer accepts only the strict pattern (other schemes, `javascript:`, malformed ids rejected); rename keeps link working and rewrites only matching text; dead states (deleted, trashed, unknown); links in code ignored; share output strips foreign links; `[[...]]` ambiguity. |
| 4 | **Templates**: `is_template`, "Save as template", "New from template", variables, hidden from default lists. | Variable substitution (dates in local time, DST edge, escaping, unknown left as typed, allow-listed formats only); new note clears template flag and copies labels; templates excluded from lists and index; old-client round trip keeps the flag. |
| 5 | **Backlink index and panel**: in-memory index, incremental updates on edit and sync, panel, unlinked-mentions as a later option, benchmark script. | Index equals a from-scratch rebuild after random edit/sync/delete sequences (property test); per-note update touches only that note; lock clears the index; **no storage writes**; scale ceiling and linearity test from 4.5; benchmark documented in the PR. |
| 6 | **Docs and honesty pass**: PRIVACY.md (ciphertext sizes, "index is client-side only"), help text, release notes. | Doc test that PRIVACY.md and the in-app privacy text mention that no new readable fields are sent. |

Dependencies: 0 -> 1 -> 2; 1 -> 3; 3 -> 5; 4 is independent after 0. Phases 3 and 5
may ship before 2 if needed.

## 8. Open questions

- Should `order` of root labels also apply to legacy labels on first display, or
  stay alphabetical until the user reorders? Proposed: alphabetical until the
  first manual reorder, then all siblings get numeric order together.
- Template attachments: copied or not? Proposed: not in phase 4.
- Unlinked mentions (plain title text that is not a link) as a suggestion list:
  later, same index, would need a title lookup scan.
- Whether folders should also become nested. Separate spec; labels are the request.
