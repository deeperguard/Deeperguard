---
title: "Contacts in your vault: an encrypted address book, and how to move yours in"
slug: contacts-encrypted-address-book
date: 2026-11-20
description: "Deeperguard now has a Contacts tab. How contacts are stored and synced, how vCard import and export work, what the server can still see, and what the feature does not do yet."
cover_image: /static/blog/contacts-encrypted-address-book.svg
cover_alt: "Abstract dark blue background with a rounded card holding a round avatar shape and three lines, beside a small vault shape, no text"
draft: false
---

An address book says a lot about a person: who they work with, who their family is, where people live. Deeperguard now has a **Contacts** tab, between Agenda and 2FA, that keeps it in the same encrypted vault as your notes. This post explains how it works, how to bring your contacts in, and where it stops.

## What a contact is

Each contact is a separate item in your vault. It can hold a structured name (prefix, given, middle, family, suffix), a nickname, a company and department, a job title, several phone numbers, email addresses, postal addresses and websites, dates such as a birthday, a free-text note, one photo, labels and a favourite star.

Like a note, a contact is encrypted in your browser before it is saved or synced. The sync request carries an item ID, the ciphertext and a few technical fields. The type "contact" sits inside the ciphertext, so the server cannot tell a contact from a note.

## Using the tab

- **Add** with the **+** button. The form covers names, numbers, addresses, labels and a photo.
- **Search** with the box at the top, or press `/` to jump to it. Every word must match, in names, company, title, note, numbers, emails, addresses or labels. Part of a phone number is found even when the stored number has spaces or brackets. `label:work` and `is:favorite` narrow the list.
- **Favourites** appear in their own section at the top of the list when no search or label filter is active.
- **Tap to call or write.** A phone number becomes a `tel:` link and a valid email address a `mailto:` link, so your device opens its own phone or mail app. Phone numbers, email addresses and postal addresses also have a **Copy** button.

The search in this tab covers only contacts. The main notes search does not include them, just as it does not include the agenda or 2FA.

## About the photo

A photo, picked by you or taken from an imported card, is redrawn in your browser: cropped to a square, scaled to 192 pixels and saved as a JPEG of at most 12 KiB. Only the pixels are drawn, so EXIF data such as a GPS position is not copied. If an imported photo cannot be made that small, the contact is kept without it and the summary says so.

## Bringing your contacts in

Most address books can export a vCard file (`.vcf`). Deeperguard reads vCard 2.1, 3.0 and 4.0.

1. Open Contacts and choose **Import**, then **Choose files**, or drop the files onto the dialog. You can choose several files at once.
2. The files are read on your device and are not uploaded. You get a preview: how many contacts were found, how many have a photo, which cards were skipped and why, and the first 50 names, each with a checkbox. If the accents look wrong, the **Wrong characters?** list lets you read the file with another encoding.
3. Contacts that match one already in your vault by email address, phone number or vCard UID are marked "already in your vault". The option **Leave out contacts I already have** is on by default, so importing the same file twice does not double your address book.
4. Choose **Import**. The result tells you how many were imported, left out or not imported, with the reasons.

Changed your mind? **Undo import**, in the dialog and in the message afterwards, removes the contacts that import created, until the vault locks. A contact you edited since is kept.

Fields Deeperguard has no place for, such as a related name from Apple Contacts, are kept with the contact and written back when you export. A photo given as a web address is never fetched; the address is kept as text.

## Taking them out again

**Export** writes a `.vcf` file in vCard 3.0, or 4.0 if you tick that option. It exports the contacts currently shown, or only the ones you ticked after pressing **Select**. In a contact's detail, **Share as vCard** writes just that one.

The file is not encrypted, so the app warns you and asks for your vault password first. The file is built on your device and nothing is sent to the server. Delete it when you are done.

## Two devices, one address book

If your phone changes a number while your laptop changes the address of the same contact, sync keeps both changes. When two devices change the same field differently, the newer value wins and the other version is saved as a separate contact marked "(conflict copy)". Adding, editing and importing also work offline; the changes upload when you are back online.

Your encrypted backup includes contacts, because it takes every item in the vault.

## What it does not do

- It does not hide that you have items or how many. The server sees each item's size, when it changed and that it was deleted, as it does for notes. A large import shows up as many small items arriving together, and a contact with a photo is larger than one without.
- It reads only vCard. CSV and LDIF files cannot be imported yet; export from your old app as vCard.
- It does not merge an incoming duplicate into the contact you already have. You can leave it out or import it as an extra contact.
- It does not sync with your phone's own address book or with CardDAV. Contacts live in Deeperguard only.
- Contacts are not in the readable ZIP export. Use the vCard export for a plain copy.
- It does not call or send email itself. A link hands the number or address to your device's own app, and from there that app's privacy rules apply.
