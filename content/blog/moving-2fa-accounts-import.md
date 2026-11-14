---
title: "Moving your 2FA accounts into your vault: Aegis, 2FAS, Google Authenticator and otpauth lists"
slug: moving-2fa-accounts-import
date: 2026-11-14
description: "How the Deeperguard 2FA import works: which exports it reads, what you see in the preview, what stays in your browser, and what it deliberately does not import."
cover_image: /static/blog/moving-2fa-accounts-import.svg
cover_alt: "Abstract dark blue background with three rounded tiles joined by dashed lines to a closed rounded vault shape, no text"
draft: false
---

Changing authenticator apps is the moment people dread most: dozens of accounts, each tied to a secret you cannot see. Deeperguard's 2FA section can read several common export formats, so you can move accounts in one sitting instead of re-enrolling every site. This post explains what it reads, what you see before anything is saved, and where the limits are.

## What you can import

Open 2FA, then Import. The import dialog accepts:

- **Aegis** exports, either plain JSON or password-protected.
- **2FAS** backups, plain or password-protected.
- **Google Authenticator** exports. Its "Export accounts" feature shows QR codes that start with `otpauth-migration://`. You can scan them with the in-app camera scanner or paste the links.
- **A list of `otpauth://` links**, one per line, pasted or loaded from a text file.

The app detects the format from the content, so you do not have to say which one you picked. An import is limited to 5 MB of text and 2000 accounts.

## Everything happens in your browser

Parsing, decryption and the preview all run in the page. The accounts are then saved into your vault like any other item, encrypted on your device before they sync. Our server only receives vault ciphertext; it is never given the file, its password or the secrets. The import code does not send anything over the network, and QR scanning uses a scanner library served from the app itself rather than an outside service.

Password-protected Aegis and 2FAS files are decrypted in a separate Web Worker. The password is turned into bytes, handed to the worker, and cleared afterwards. If you enter a wrong password or the file is damaged, you get one generic error rather than a hint about which part failed.

## Files are treated as untrusted

An export is just a file handed to your browser, so the importer is cautious:

- JSON nesting depth, file size and account count are capped.
- Text fields have control characters removed and are cut to a maximum length.
- Encrypted files declare how much computing power it takes to open them. The app refuses files that ask for more than its limits (for Aegis, scrypt up to N = 2^20 and 256 MB of memory; for 2FAS, PBKDF2 between 1,000 and 2,000,000 iterations), so a hostile file cannot freeze your tab. You see a message that the file asks for too much and was not opened.
- An encrypted Aegis backup needs a password slot. If it has none, it is not opened.

## Google Authenticator: several QR codes

A large Google Authenticator export is split over several QR codes. The scanner collects them as you show them one after another and tells you how many of the export it has. Scanning the same code twice is harmless. A code from a different export is refused, so two exports never mix by accident. If you press "Import what I have" before the last code, the preview warns you that accounts in the missing codes will not be imported.

## The preview comes first

Nothing is saved until you have seen a preview. It lists each account by issuer and name, and shows a summary such as "12 to import, 2 already in vault, 1 skipped". Secrets are not shown. Accounts whose secret is already in your vault, or repeated within the file, are marked and skipped, so importing the same file twice does not create copies. Only then do you press Import.

## Practical steps

1. Keep the old app until you have checked that codes from Deeperguard are accepted by each site.
2. Export from the old app, then import here and read the preview.
3. **Delete the export file afterwards**, including from your downloads folder and any cloud copies. A plain export contains your secrets in readable form, and Deeperguard cannot remove a file that lives on your device. The dialog reminds you of this after the import.
4. Prefer a password-protected export when your old app offers one.

## What it does not do

- **No Authy import.** Authy has no official export, so Deeperguard does not offer one and does not point you to tools that extract secrets from it. The Authy route is to set up 2FA again on each site and scan the new QR code. The import dialog has a short guide for this.
- **No counter-based (HOTP) accounts.** These are skipped and counted as skipped in the preview, as are other unsupported types.
- **No MD5 accounts.** Entries using MD5 are skipped; SHA-1, SHA-256 and SHA-512 are accepted.
- **No protection for the file you import.** The safety of the import ends at your device: an unencrypted export lying in a folder is as exposed as it was before.
- **No recovery of missing data.** If an export was incomplete, the import cannot fill in what is not there.

The import is a convenience for moving accounts, not a reason to skip your own backup habits. Keep recovery codes for important sites somewhere safe, as described in our [guide to backing up 2FA before switching phones](/blog/2fa-backup-codes-phone-switch).
