---
title: "What's in your backup email — and why we can't read it"
slug: encrypted-email-backups
date: 2026-11-09
description: "If encrypted email backups are available for your account, here is what the archive and its size reveal, what stays encrypted, and why strong passwords still matter."
cover_image: /static/blog/encrypted-email-backups.jpg
cover_alt: "Illustration of a cream envelope sealed with a glowing teal padlock, a window in the envelope showing only scrambled gold and teal blocks instead of readable writing, on a soft cream and dusty-blue background"
draft: true
---

A backup arriving by email raises a reasonable question: does opening the mailbox reveal your notes? With an encrypted archive, the attachment is not a readable copy of your note contents.

If encrypted email backups are available for your account, enabling that option gives you an additional encrypted copy. Availability and the current controls should be checked in your account rather than assumed.

## What the email contains

The backup payload contains:

- **An encrypted archive** of vault data, not readable note titles or bodies.
- **A human-readable size**, showing roughly how large the archive is.

The email does not list vault contents. Ordinary email metadata, such as sender, recipient and delivery time, still exists and remains visible to email providers. The archive size is also information about the backup, even though it does not reveal readable note contents.

## What encryption protects

An encrypted attachment is different from a readable export: obtaining the attachment does not immediately reveal the stored note contents.

Encryption protects the contents; a strong, unique vault password still matters. Someone who obtains an archive may try to guess a weak password offline. A compromised device or malicious client code can expose your password or readable notes when you unlock or use them.

[How zero-knowledge notes work](/blog/how-zero-knowledge-notes-work) explains the distinction between encrypted contents and information the service can still see.

## Keep backups deliberately

If this backup option is available and enabled, keep copies according to your own needs. Your mailbox is another place to protect: use a strong, unique email password and two-factor authentication where available.

Restoring means importing a saved backup through the app's supported restore process. Before doing so, check the current instructions and how importing affects existing data; do not assume an older backup will merge harmlessly with newer notes. This guide does not verify a particular import screen or confirmation flow.

## A backup is not a password reset

We cannot reset your vault password and recover your notes for you. Do not assume that possessing a backup email or a recovery code lets you bypass the vault password. [Build a passphrase you can remember](/blog/vault-password-passphrase).

Never give anyone your vault password, recovery codes or two-factor authentication codes, and do not forward them with a backup to someone claiming to be support. [Learn how recovery scams work](/blog/recovery-scams-2fa-hygiene).

## Quick checklist

- Check whether encrypted email backups are available for your account.
- Understand that the archive is encrypted, while email metadata and archive size remain visible.
- Use a strong, unique vault password and protect your mailbox.
- Check the current restore instructions before importing a saved copy.
- Never share your vault password or recovery codes.

Our [security page](/security) explains the vault's encryption design. SRP is the sign-in protocol, not the archive-encryption mechanism. The [verify page](/verify) explains how to review what is running.
