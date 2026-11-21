---
title: "Your notes, in your order: how \"Own order\" works inside a label"
slug: own-order-notes-in-a-label
date: 2026-11-21
description: "How to put the notes in a label in an order you choose, with drag, Alt+Arrow keys or buttons, and where that order is stored: inside the encrypted label, not on the server in readable form."
cover_image: /static/blog/own-order-notes-in-a-label.svg
cover_alt: "Abstract calm blue and green shapes: three stacked bars with arrows pointing up and down, no text"
draft: false
---

Sorting by date or title works until the order matters. A checklist for a trip, the chapters of a report, the steps of a procedure: you want the notes in a sequence you chose, not the one the clock picked. Deeperguard Notes has a sort choice for that, called **Own order**. This post covers how to use it and where the order lives.

## Turning it on

In the notes list, the sort control offers Recent, Date created, Title and **Own order**. Own order only means something inside one label, so it applies when you have selected a label in the sidebar. In "No label" or in the Files view, the list falls back to your other sort setting. Inside a label, search results keep your own order, but the reorder controls are hidden while the search box has text in it.

The choice is saved as a setting. Settings that follow your account are stored as one encrypted vault item and synced like notes, and this one is on that list, so the choice should follow you to your other devices.

## Three ways to move a note

While a label is selected and the search box is empty, every row can be moved:

- **Keyboard:** focus a note row and press **Alt+Up** or **Alt+Down**. Focus stays on the moved row, so you can press the keys again to keep going. If a note is open and nothing in the list has focus, the shortcut moves the open note.
- **Buttons:** each row shows a move-up and a move-down button, labelled with the note's title for screen readers.
- **Drag:** with a mouse, drag a row onto another one. The upper half of the target row means "before it", the lower half "after it". On touch screens and with a pen, use the grip on the row, so the row itself can still scroll and swipe.

After each move a short message says where the note went, for example "Moved to position 3 of 12". At the ends you get "Already first" or "Already last" instead.

## Where the order is stored

This is the part that matters for a zero-knowledge app. The order is not written into the notes. It is a small map inside the **label's own encrypted record**: for each note it holds a position number and a timestamp. The code is in `app/static/js/labels.js` (`moveNote`, `orderNotes`) and `app/static/js/store.js` (`moveNoteInLabel`).

What follows from that:

- Moving a note rewrites the label, not the note. The note's content, modified date and history are untouched.
- The server receives the label as ciphertext like any other item. The repository has a test for this (`tests/test_note_manual_order.js`) that checks the keys do not appear in readable form in what is sent.
- Position numbers are spaced out, and a note dropped between two others gets a number between theirs, so one move normally changes one entry. If the gap gets too small, or a neighbour has no position yet, the visible notes are renumbered in a single write.

## New notes, and two devices

Notes that have no position yet, such as notes that existed before you used Own order or notes you add later, are listed after the positioned ones, newest first. They do not jump around between sessions.

If you reorder the same label on two devices before they sync, the positions are merged note by note, and for each note the later change wins. The merge does not drop any note's position.

Pinned and starred notes are not forced to the top in this view. They sit wherever your order puts them.

## What it does not do

- **Only inside a label.** There is no manual order for "All notes" or for "No label". Inside a label, search results follow your order too, but you can only move notes while the search box is empty.
- **Not for folders.** Notes in a folder are still sorted by title, and folders and sibling labels have no drag-to-reorder.
- **A limit of 1000.** A label remembers positions for at most 1000 notes. Past that, the entries placed longest ago are dropped, and those notes fall back to the "newest first" group after the positioned ones.
- **Not invisible to the server.** The server cannot read the order, but it can still see that the label item changed, when, and roughly how large it is. That is true of every synced item.
- **Not a security feature.** Ordering is for you. Anyone with your unlocked vault sees the same list.

## A practical way to start

Pick a label with a handful of notes, set the sort to **Own order**, and use Alt+Up and Alt+Down on the first few notes to feel it out. If you have many notes, move the important ones to the top and leave the rest: they stay together after your chosen notes, in a stable order.
