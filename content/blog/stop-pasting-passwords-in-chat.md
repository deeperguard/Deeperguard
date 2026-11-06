---
title: "Stop pasting passwords into chat: a safer way to share a secret"
slug: stop-pasting-passwords-in-chat
date: 2026-11-06
description: "Passwords, Wi-Fi keys and account numbers pasted into chat or email stay there for years. Here's a simple habit for sharing secrets safely, and how Secure Send keeps the key out of our hands."
cover_image: /static/blog/stop-pasting-passwords-in-chat.jpg
cover_alt: "Illustration of two phones with shield icons and a speech bubble between them holding a teal envelope with a closed padlock, joined by a dotted line, on a soft cream and blue background"
draft: true
---

Sooner or later someone needs a secret from you: the Wi-Fi password for a guest, a shared streaming login, a door code, an account number for a family member. The quickest move is to paste it into the chat you already have open. It's also the move most likely to come back and bite you.

## Why chat and email are a bad home for secrets

A message isn't just seen once and gone.

- **It sticks around.** Chats and inboxes keep history for years, often synced to several devices and backups.
- **It spreads.** Messages get forwarded, screenshotted and searched. Anyone who later gets into that account, or just picks up an unlocked phone, can scroll back and find it.
- **You lose track of it.** A year from now you won't remember which thread holds which password, so you can't clean it up.

None of that means the people you're talking to are careless. It's simply that ordinary messaging was built to remember things, and a secret is exactly the thing you want forgotten.

## A simple habit for sharing secrets

1. **Ask whether it needs to be shared at all.** For shared accounts, a separate login or a guest option is often better than handing over your own password.
2. **Send the secret encrypted, not as plain text.** Use a tool that encrypts it before it leaves your device, so the chat only carries a link, not the secret itself.
3. **Keep the context separate.** Don't write "here's the bank password" next to the link. Say what it is in a call or another message.
4. **Change it afterwards when it makes sense.** If you shared a temporary code or a guest password, rotate it once it's no longer needed.

## How Secure Send fits in

Deeperguard's Secure Send is built for step 2. Your text is encrypted in your browser with AES-GCM 256 before anything is uploaded. The key that unlocks it lives in the part of the link after the `#`. Browsers don't send that part to the server when the link is opened, so we only ever store the encrypted version and can't read what you sent.

That also means the link itself is the key. Treat it like the secret: send it only to the person who needs it, and not in a public channel or group chat.

## What to do with old secrets in your chats

If you scroll back and find passwords sitting in old threads, don't panic. Change the passwords that still matter, then delete those messages where your app allows it. From now on, the link-not-secret habit keeps the problem from growing.

## Quick checklist

- Shared a link instead of the secret itself? ✔
- Kept "what this is" out of the same message? ✔
- Sent the link only to the person who needs it? ✔
- Changed any password that's been sitting in old chats? ✔

Want the details on how Secure Send and your encrypted notes work? Our [security page](/security) explains the design, and the source is available for review on our [verify page](/verify).
