---
title: "Browser hygiene for your private notes: six habits that keep your vault yours"
slug: browser-hygiene-private-notes
date: 2026-10-31
description: "Encryption protects your notes on the server. These six browser habits protect them on your screen: the right URL, careful extensions, shared-computer sign-out and more."
cover_image: /static/blog/browser-hygiene-private-notes.jpg
cover_alt: "Illustration of a browser window with a padlock in the address bar, a small shield over a notes icon, and a puzzle-piece extension icon set aside"
draft: true
---

Deeperguard encrypts your notes on your device with AES-GCM 256 before they sync, so our servers only ever hold ciphertext. That handles the server side. But while your vault is unlocked, your notes are readable on *your* screen, inside *your* browser. That's the part only you can look after, and a few small habits go a long way.

## 1. Check the address before you type your vault password

Phishing pages copy logos easily. They can't copy the real address. Before you unlock, glance at the address bar and make sure you're on **deeperguard.com**. Better still, open Deeperguard from a bookmark you made yourself instead of from a link in an email or message.

Your vault password is checked with SRP, which proves you know it without the password ever being readable on the wire. That only helps if you type it into the real site.

## 2. Be picky about browser extensions

Extensions that can "read and change data on all websites" can, in principle, see whatever is on the page, including an unlocked note. Our pages use a strict Content Security Policy (CSP) that limits which scripts the page itself is allowed to load, but no website can stop an extension you installed from reading the page.

A quick tidy-up:

- Remove extensions you no longer use.
- For the ones you keep, set site access to "on click" or limit them to specific sites where your browser allows it.
- Consider a separate browser profile with no extensions just for sensitive work.

## 3. On a shared or borrowed computer, sign out when you're done

Closing the tab isn't the same as signing out. On a computer other people use, sign out of Deeperguard before you walk away. If you're online and have changes that haven't synced yet, Deeperguard warns you before signing out, so you don't lose work by accident.

Also skip "save password" prompts on shared machines. Your vault password belongs in your head or in a password manager you control, not in someone else's browser.

## 4. Keep your browser up to date

Browser updates fix security holes that attackers actively use. Turn on automatic updates and restart the browser when it asks. It's the least exciting habit on this list and one of the most effective.

## 5. Watch where you copy and screenshot

Copying a note puts it on your clipboard, where other apps may be able to read it. Screenshots end up in your photo library and, often, in a cloud photo backup you forgot about. If something is sensitive enough to keep in an encrypted vault, think twice before copying it somewhere that isn't.

## 6. Lock your screen, not just your vault

If you step away from your desk, lock the computer (Windows: <kbd>Win</kbd> + <kbd>L</kbd>, macOS: <kbd>Ctrl</kbd> + <kbd>Cmd</kbd> + <kbd>Q</kbd>). An unlocked laptop with an open tab is the easiest "hack" there is.

## Want to see what the browser is allowed to load?

Our [security page](/security) explains how Deeperguard protects your notes, and Deeperguard's source is available for review if you'd like to inspect the encryption and client code yourself. You can also check the details on our [verify page](/verify). We'd rather you check than take our word for it.
