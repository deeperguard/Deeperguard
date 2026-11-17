---
title: "Folders that the server can't read: nesting and moving notes in Deeperguard"
slug: nested-folders-move-notes
date: 2026-11-17
description: "How nested folders work in Deeperguard Notes: a keyboard-friendly folder tree, moving notes by drag or dialog, and what the server can and can't see about your structure."
cover_image: /static/blog/nested-folders-move-notes.svg
cover_alt: "Abstract calm blue and green shapes suggesting nested boxes and a branching tree, no text"
draft: false
---

A folder name is information. "Divorce", "Clinic", "Acme acquisition": even with every note encrypted, a readable folder list would tell a server a lot. In Deeperguard, folders are encrypted the same way notes are. This post covers how nested folders work, how to move notes into them, and what stays visible to the server.

## Folders can be nested

Create a folder from the Folders section in the sidebar. Each folder row has a **+** button for a new subfolder, a rename button and a delete button. Right-click (or press the context-menu key) for the same actions in a menu.

Nesting goes up to eight levels deep, and a folder name must be unique among its siblings, ignoring upper and lower case. The same name can exist in two different branches, so "Archive" can live under both "Work" and "Home". The code refuses cycles, so a folder can never end up inside itself.

A note sits in exactly one folder, or in none. If you want a note to show up in several places, that is what labels are for. Labels are separate from folders and can be nested too.

## A tree you can drive from the keyboard

The sidebar is a real tree for assistive technology, with levels and expanded or collapsed states announced. With a folder focused:

- **Up** and **Down** move between visible folders, **Home** and **End** jump to the first and last.
- **Right** expands a folder, or steps into its first subfolder if it is already open. **Left** collapses it, or steps up to the parent.
- **Enter** or **Space** selects the folder and filters the note list to it.
- **F2** renames, and the context-menu key opens the actions menu.

"All notes" is the first row of the tree. It is a view, not a folder. Which folders are open is remembered on the device, in the browser's local storage.

The number next to a folder counts the notes directly inside it. Notes in subfolders are not rolled up into the parent's count, and notes in the trash and templates are not counted.

## Moving a note

There are three ways, and only the first needs a pointer:

1. **Drag** a note row from the list onto a folder in the sidebar.
2. Open the **⋯** menu on a note row and choose **Move to folder…**.
3. In the editor, press **Move to folder…**.

The last two open a small dialog with the folder tree plus a **No folder** entry. Pick one with the arrow keys and Enter, or click. Escape closes it. The dialog says "Only this note changes", and that is accurate: moving a note changes that note's own encrypted record and nothing else. It does not count as an edit, so the note's "last edited" time stays the same.

Some cases are refused with a message. If the vault is locked, you are asked to unlock it first. If the note itself is locked, you are asked to unlock the note first, and locked notes can't be dragged. If the target folder was deleted on another device in the meantime, the app says the folder no longer exists instead of moving the note into a folder that isn't there.

## Deleting a folder is gentle

Deleting a folder shows a confirmation that spells out the consequences: how many notes move out to All notes, and where its subfolders go (up to the deleted folder's parent, or to the top level). No notes are deleted. Right after, an undo toast restores the folder, its subfolders and the notes' membership.

## What stays on your device and what the server stores

A folder is an item like any other. Its name, its parent and its position among its siblings live inside the encrypted content, and a note's folder membership lives inside the note's encrypted content. The browser encrypts before anything is uploaded.

The repository has a test for this (`tests/test_folder_model.js`). It creates nested folders with recognisable names, runs a push, and fails if any folder name, parent reference, `folder_id` or sort field shows up in readable form in the request. It also checks that the parent's identifier does not appear in any readable field.

What the server can still see is what it can see for every synced item: a random identifier, timestamps, whether the item is deleted, a version number and the size of the ciphertext. It can tell that you have items and when they change. The folder structure itself is not readable to it. Moving a note produces an update to that note like any other change, so the server can see that something changed and when, but not which folder it went to.

Folders are included in the encrypted backup and its import, and a test (`tests/test_backup_folders_labels_roundtrip.js`) checks that the tree and which note sits where survive a round trip.

## What it does not do

- **No manual ordering.** Sibling folders are ordered by when they were created, then by name. There is no drag-to-reorder for folders or notes.
- **No moving folders in the interface.** You can create, rename and delete folders in the tree, and move notes between them. The data layer can re-parent a folder, but the sidebar has no control for it yet.
- **One folder per note.** No multi-folder membership.
- **No rolled-up counts or filtering by branch.** Selecting a folder shows the notes directly inside it.
- **Not a security boundary.** Folders organise; they do not protect. Anyone with your unlocked vault sees all of it. For a single sensitive note, use the note lock.
- **Metadata is not hidden.** The timing and size details above are visible to the server, as for all synced items.

## A practical way to start

Keep the tree shallow: two or three levels are usually enough. Create the top-level folders first, drag in the notes you open most, and use the **Move to folder…** dialog for the rest.
