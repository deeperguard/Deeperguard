---
title: "Keeping your vault safe on a shared or travel device"
slug: vault-safe-shared-travel-device
date: 2026-11-10
description: "Hotel lobby computers, a borrowed laptop, a family tablet: here's how to use Deeperguard in the browser on a device that isn't only yours, and how to leave nothing open behind you."
cover_image: /static/blog/vault-safe-shared-travel-device.jpg
cover_alt: "Illustration of a laptop on a hotel desk next to a suitcase and a padlock, on a soft cream and blue background"
draft: false
---

Sometimes the only screen nearby isn't yours: a hotel business-center computer, a colleague's laptop, the family tablet. You can still reach your notes in the browser. The trick is to arrive carefully and leave cleanly. Here's how.

## Go to the real address

Before you sign in, check where you are. The app lives at `https://www.deeperguard.com/app`. Type it yourself rather than tapping a link from a message, an email or an ad, and look at the address bar before you enter anything. Our post on [spotting a fake login page](/blog/spot-fake-login-page) has more on checking it.

On a device you don't control, don't let the browser save your password, and skip any "remember me" prompt the browser itself offers.

## What the server sees, wherever you sign in

Your notes are encrypted on the device you're using with AES-GCM 256 before they sync, so what reaches our server is ciphertext, not your notes. That holds on a borrowed laptop too. But encryption can't protect against the device itself: a public or unknown computer could have software that records what you type or shows on screen. If you can, use your own phone instead, and treat a shared computer as a last resort. Encryption also can't protect a screen someone else is looking at, or a session you forgot to close. That part is up to the habits below.

The one exception is Ask AI: text you choose to send to Ask AI passes through our server to Ollama Cloud. On a device that isn't yours, it's simplest to leave Ask AI for later.

## Four habits for a device that isn't yours

- **Lock the vault when you step away.** Even for a coffee. Locking drops the keys from memory, so someone who sits down at the keyboard can't just read your notes.
- **Sign out when you're done.** Signing out ends that device's session. It doesn't delete your notes; they're still in your vault next time you sign in.
- **Close the browser window.** Once you've signed out, close the browser window too.
- **Keep your vault password to yourself.** It's the one secret that unlocks everything, and we can't reset it. Don't write it on a sticky note for a borrowed laptop. Our [passphrase guide](/blog/vault-password-passphrase) shows how to build one you'll remember.

## Quick checklist

- Typed `www.deeperguard.com/app` yourself and checked the address bar? ✔
- Said no to the browser saving your password? ✔
- Locked the vault whenever you stepped away? ✔
- Signed out and closed the window before you left? ✔

Curious what actually leaves the device when you sync? You can check it yourself on our [verify page](/verify), and the [security page](/security) explains the design.
