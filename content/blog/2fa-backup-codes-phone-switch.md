---
title: "Don't get locked out: backing up your two-factor codes before you switch phones"
slug: 2fa-backup-codes-phone-switch
date: 2026-11-04
description: "Two-factor authentication keeps attackers out, but a lost or wiped phone can keep you out too. Here's how to save backup codes, move 2FA safely to a new phone, and avoid recovery scams."
cover_image: /static/blog/2fa-backup-codes-phone-switch.jpg
cover_alt: "Illustration of an old and a new smartphone joined by a dashed arrow with a shield check badge, next to a blank paper card and a closed teal padlock on a soft cream and blue background"
draft: true
---

Two-factor authentication (2FA) is one of the best upgrades you can give an account. Even if someone learns your password, they still need the second step. But the same protection can lock *you* out if your phone is lost, broken or wiped before you've planned for it. A few minutes of preparation fixes that.

## Save your backup codes the day you turn on 2FA

Most services show a set of one-time backup codes when you enable 2FA. They're your spare key if your authenticator app is gone.

1. **Save them right away.** Don't skip the screen and promise yourself you'll do it later.
2. **Store them somewhere only you control.** Printed on paper at home, in a password manager you trust, or in an encrypted note. In Deeperguard, notes are encrypted on your device with AES-GCM 256 before they sync, so our servers only ever hold ciphertext.
3. **Keep them apart from the phone that generates your codes.** A backup that dies with the phone isn't a backup.
4. **Cross off a code once you use it.** Each one usually works only once.

## Before you switch phones

Do this while the old phone still works:

- **Check each important account's 2FA settings.** Many services let you add a second authenticator or move 2FA to a new device from inside your account.
- **Set up the new phone first, then test it.** Sign in once with a code from the new device before you reset the old one.
- **Confirm your backup codes are where you think they are.** Open them and make sure they're readable.
- **Only then wipe the old phone.** Wiping first is the most common way people lock themselves out.

## If you've already lost the phone

Use a backup code to sign in, then turn 2FA off and on again with your new phone so fresh codes are issued. Save the new backup codes and throw away the old ones. If you have no backup codes, use the service's official recovery process, reached from its real website or app, not from a link someone sent you.

## Watch out for "helpful" strangers

Lockouts are exactly when scammers strike. They pose as support and ask you to read out a code "to verify it's you." No real support team needs your 2FA codes, backup codes or password. Deeperguard will never ask you for your vault password, recovery code or 2FA codes by email, chat or phone. Anyone who does is trying to get into your account.

## Quick checklist

- Backup codes saved somewhere only you control? ✔
- Stored separately from your phone? ✔
- New phone tested before the old one is wiped? ✔
- Never shared a code with "support"? ✔

Curious how Deeperguard protects your notes and codes? Our [security page](/security) explains the design, and the source is available for review on our [verify page](/verify).
