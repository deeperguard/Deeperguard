---
title: "What \"zero-knowledge\" really means for your notes"
slug: zero-knowledge-notes-basics
date: 2026-11-08
description: "Lots of apps say your notes are encrypted. Zero-knowledge means something stricter: the service never holds the key. Here's what that means in plain words, what it protects, and what it can't."
cover_image: /static/blog/zero-knowledge-notes-basics.jpg
cover_alt: "Illustration of a laptop showing a notebook page behind a glowing teal padlock, with a gold key resting beside the laptop while small scrambled blocks travel along a dotted line up to a cloud, on a soft cream and blue background"
draft: false
---

“Your notes are encrypted” leaves an important question unanswered: **who holds the key?** Encryption alone does not prevent a service from reading your notes if it can use the decryption key.

## Encrypted is not the same as zero-knowledge

Encryption at rest protects stored data, but does not by itself tell you who can decrypt it. A zero-knowledge design keeps the service from holding the key needed to decrypt your stored note contents.

Your notes are encrypted on your device before they leave it. The key comes from your vault password. Stored note contents are ciphertext; account details and sync metadata remain visible to the service.

## How Deeperguard does it

- **Encryption happens in your browser.** Notes are encrypted with AES-GCM 256 before they sync. Synced note contents reach our servers as ciphertext; this does not mean account details and sync metadata are encrypted in the same way.
- **Signing in uses SRP.** This protocol proves you know your password without sending the password to the server.
- **The code is source available for review.** Our [verify page](/verify) explains how to check what is running.

## The honest exception: Ask AI

Ask AI sends the text you select in readable form through Deeperguard’s server to Ollama Cloud. Deeperguard does not store the submitted text or response; Ollama Cloud processes it under its own policies.

If a note is too sensitive to share this way, don't submit its text to Ask AI. This exception is separate from encrypted storage and sync of note contents.

## What zero-knowledge protects, and what it doesn't

For stored encrypted note contents, a server breach alone does not supply the vault key needed to read them. The service likewise cannot decrypt those stored contents for staff access or a request for readable notes. This does not hide account details or sync metadata, and it does not cover text you choose to submit to Ask AI.

It cannot protect you from:

- **A weak or reused vault password.** Someone who obtains your password can unlock your vault. [Build a passphrase you'll remember](/blog/vault-password-passphrase).
- **Fake login pages.** Typing your password into a lookalike site gives it away. [Learn how to spot one](/blog/spot-fake-login-page).
- **An unlocked, unattended device.** Lock your vault when you step away.
- **A compromised device or malicious client code.** Either can expose plaintext when you enter your password or unlock and use your notes.

## The trade-off: we cannot recover your notes for you

Because we never hold your key, we can't reset your vault password and recover your notes for you. Do not assume a recovery code can recover your vault notes. Never give anyone your vault password or recovery codes. [More on recovery scams](/blog/recovery-scams-2fa-hygiene).

## Quick checklist

- Use a long, unique vault password.
- Never give anyone your vault password or recovery codes.
- Only submit text to Ask AI if you are comfortable with the processing described above.
- Check the address bar before signing in and lock your vault when you step away.

Our [security page](/security) explains the design, and the [verify page](/verify) shows how to check it yourself.
