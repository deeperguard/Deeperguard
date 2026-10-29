---
title: "Spot the recovery scam: keeping your 2FA and recovery codes yours"
slug: recovery-scams-2fa-hygiene
date: 2026-10-30
description: "Real support never asks for your vault password, recovery code, or 2FA code. Here's how account-recovery scams work and five habits that keep your codes safe."
cover_image: /static/blog/recovery-scams-2fa-hygiene.jpg
cover_alt: "Illustration of a padlocked envelope beside a phone showing a blank code field, with a red 'never share' badge"
draft: true
---

Most accounts don't get broken into by clever math. They get talked open. Someone calls, emails or DMs you, sounds helpful, and asks for "just the code we sent you." This post covers how those recovery scams work and the small habits that make them fail.

## The one rule that beats most scams

**Deeperguard support will never ask for your vault password, your recovery code, or a 2FA code.** Not by email, chat, phone or social media. There is also no "remote restore" where someone on our side unlocks your vault for you.

That isn't just policy. Your notes are encrypted on your device with AES-GCM 256 before they sync, so our servers only ever hold ciphertext. When you sign in, your vault password is checked with SRP, a protocol that proves you know the password without it ever being readable on the wire. So nobody here has a copy to "verify" with you. If someone asks for it, that alone tells you it's a scam.

## How a recovery scam usually goes

1. **Urgency.** "Unusual sign-in detected, your account will be locked in 30 minutes."
2. **A trusted look.** A logo, a support-style address, maybe your real name.
3. **The ask.** "To confirm it's you, read back the 6-digit code we just sent," or "paste your recovery code here."
4. **The takeover.** That code was really for *their* login attempt. Once they have it, they're in.

The giveaway is always step 3: a request to hand over something that only you should ever type, and only into the real app.

## Five habits that keep your codes yours

**1. Type codes, never tell them.** A 2FA code goes into the login screen you opened yourself, never into a reply, a call or a chat window someone sent you.

**2. Open the app yourself.** If a message says something is wrong with your account, close it and open Deeperguard (or any service) directly from your bookmark or app. Don't use the link in the message.

**3. Store recovery codes offline.** Print them or write them down and keep them somewhere physical and private. Don't screenshot them into your camera roll or paste them into chats.

**4. Give each 2FA entry a clear name and site.** When you add an authenticator entry, label it with the service name and site, so a fake "confirm your code for X" message is easier to spot against what you actually have.

**5. Slow down on urgency.** Real security notices don't need an answer in the next five minutes. Pressure is a tactic, not a sign of authenticity.

## If you think you already shared something

Treat this as **generic account hygiene** for whatever service you may have compromised — Deeperguard doesn’t ship a “regenerate recovery codes” or “active sessions” screen; do these steps on that service’s real site or app:

- Change the password right away.
- Regenerate recovery codes if it offers them, and store the new set offline.
- Sign out unknown sessions if the service shows active sessions.
- Remember: anyone who asked for those codes was not support.

## Want to check our claims?

Deeperguard is open source, and you can see how the encryption and sign-in work on our [verify page](/verify). We'd rather you check than take our word for it.

*Deeperguard is in public beta, and every account gets Pro for free while it lasts.*
