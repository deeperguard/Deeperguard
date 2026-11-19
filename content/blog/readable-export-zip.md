---
title: "A copy you can read without us: the readable ZIP export, and when to use it"
slug: readable-export-zip
date: 2026-11-19
description: "Deeperguard can build an unencrypted ZIP of your notes, attachments and agenda on your device. What is inside, what is left out, why it asks for your password, and what it does not do."
cover_image: /static/blog/readable-export-zip.svg
cover_alt: "Abstract dark blue background with a closed vault shape, a dashed arrow and a stack of open pages, no text"
draft: false
---

An encrypted backup is the right default, but it has one limit: you need Deeperguard and your vault password to open it. Sometimes you want the opposite, a plain copy in standard formats, Markdown and `.ics`, that any text editor can open. For that, Settings has a **Readable export (not encrypted)**. This post explains what it produces, how to use it safely and where it stops.

## Where it is and what it does

In Settings, under **Keep a copy**, the button **Export everything readable (ZIP)** builds one ZIP file with:

- your notes, one Markdown file each, in a `notes/` folder;
- your attachments, in an `attachments/` folder;
- your agenda events as a single `agenda/agenda.ics` file, a standard calendar file other calendar apps can import;
- a `README.txt` that repeats the warning, the export time, the counts and a list of what was not exported.

The ZIP is built in your browser from data your open vault already holds in memory. The code makes no network request, and the in-app text says the same: nothing is sent to the server. The file is named `deeperguard-export-YYYY-MM-DD.zip`, using the UTC date.

## The confirmation step

Because the result is not encrypted, the app does not let you do this by accident. A dialog tells you that anyone who gets the file can read it, that your vault password does not protect it, and how many notes and agenda events will be exported. You must type your vault password to continue. A wrong password stops the export before anything is built.

The dialog also has an unticked option to include your 2FA secrets. Leave it unticked unless you really need it. If you tick it, the ZIP gets a `2fa/otpauth.txt` file with one standard `otpauth://` line per account. Those lines contain the live secrets, so anyone holding the file can generate your login codes without your phone. Without the option, no 2FA secret is read or written.

## What the notes look like

Each note becomes `notes/<title>.md`. Titles are cleaned so the name works on common file systems: characters such as `/ : * ? " < > |` become `_`, names are cut to a sensible length, and clashes get a ` (2)`, ` (3)` suffix.

At the top of each file is a small front-matter block:

```
---
title: "Trip planning"
created: 2026-03-02T09:14:00.000Z
modified: 2026-03-05T18:40:00.000Z
tags: ["travel", "2027"]
---
```

The body follows as your note text. The tag names are written out as words, not as internal IDs. If a note has attachments, an `attachments:` line is added and a list of links is appended to the body. The links are relative, so they work when you unzip the folder and open the note next to its files. Importing the ZIP back into Deeperguard reads these links as attachments again, as described in docs/IMPORT_EXPORT_SPEC.md (section 3.1). Images are linked as images. Attachment files get the first eight characters of their internal ID as a prefix, so two files with the same name do not overwrite each other.

The body is written as stored, without conversion. A checklist note comes out as `- [ ]` and `- [x]` lines.

## What it does not include

The README lists these, and so does the code:

- **Locked notes** are skipped. Unlock them first if you want them in the file. The confirmation dialog tells you how many will be skipped.
- **Trashed notes** are never exported.
- **Folders.** Notes are written flat into `notes/`, so your folder structure is not in the ZIP.
- **2FA accounts**, unless you ticked the option above.
- **Agenda reminders and agenda tasks.** Only events that have both a start and an end time are written to the `.ics` file; the README counts the others as not exported.
- **An attachment that cannot be read.** It is listed in the README rather than silently dropped.

If there are no exportable notes and no agenda events, there is nothing to build and the app says so.

## Taking it back in

The Markdown importer in Settings accepts a ZIP, including this export. You see a summary before anything is saved, and files linked by relative path inside the ZIP become attachments again. That makes the readable ZIP a reasonable way to move notes between tools, as long as you accept the losses above, such as folders.

## Using it well

- Treat it like a printed copy of everything: store it somewhere private, and delete it when you are done.
- Do not put it in a shared folder, a chat or an email. It has no password.
- Keep your encrypted backup file as well. The readable ZIP is a complement, not a replacement.
- If you lose both your master password and your vault recovery key, an export you saved earlier is one of the few ways left to get your text back. We cannot read your vault for you.

## What it does not do

- It does not encrypt anything. The vault password does not protect the file.
- It does not run on a schedule. It happens only when you click, and the Settings line reads "Manual: when you click".
- It does not upload the file or send it by email. It is a normal browser download.
- It does not clean up after itself. Once it is on your disk or in a synced downloads folder, its safety depends on that place.
