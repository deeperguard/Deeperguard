---
title: "Is this the real login page? How to spot a fake before you type your vault password"
slug: spot-fake-login-page
date: 2026-11-05
description: "Phishing pages copy the look of real sign-in screens to steal passwords. Here's how to check the address bar, avoid login links in messages, and keep your vault password safe."
cover_image: /static/blog/spot-fake-login-page.jpg
cover_alt: "Illustration of two nearly identical browser windows side by side, one with a teal shield check and one with a red warning triangle, above a closed teal padlock on a soft cream and blue background"
draft: true
---

Most stolen passwords aren't cracked. They're typed in by their owners, on a page that only looks like the real one. A phishing page can copy a logo, colors and layout in minutes. What it can't copy is the real web address. Learning to check that one detail protects every account you have, including your Deeperguard vault.

## Check the address bar, every time

Before you type a password, look at the domain in your browser's address bar.

1. **Read the domain right to left from the first single slash.** In `deeperguard.com/login`, the domain is `deeperguard.com`. In `deeperguard.com.account-check.io/login`, the real domain is `account-check.io`, and that isn't us.
2. **Watch for look-alikes.** Swapped letters, extra hyphens, or a different ending (`.co` instead of `.com`) are classic tricks.
3. **Don't treat the padlock as proof.** The padlock only means the connection is encrypted. Scam sites can have one too.

## Don't sign in from links in messages

Emails, texts and chat messages that say "your account is locked" or "verify now" are the most common way people land on fake pages.

- **Go there yourself.** Type the address or use a bookmark you saved earlier, then sign in from there.
- **Be extra careful with urgency.** "Act within 24 hours" is pressure, not a security feature.
- **If you're unsure, close the tab.** A real warning will still be there when you sign in the normal way.

## Let your password manager be a second pair of eyes

Password managers fill in saved logins based on the exact domain. If yours suddenly doesn't offer to fill on a page that looks familiar, stop and check the address. That hesitation is often the first sign something's wrong.

## Why your vault password is worth protecting

Deeperguard is built so your vault password is never sent in readable form when you sign in. We use SRP, a sign-in method that proves you know the password without revealing it, and your notes are encrypted on your device with AES-GCM 256 before they sync. That design protects you on the real site. It can't help if you type the password into a fake one, which is why the address check matters.

## No one should ask you for it

Deeperguard will never ask you for your vault password, recovery code or 2FA codes by email, chat or phone. If a message or a "support agent" asks for any of them, it's a scam, no matter how official it looks.

## Quick checklist

- Checked the domain before typing a password? ✔
- Signed in from a bookmark, not a message link? ✔
- Paused when the password manager didn't autofill? ✔
- Never shared your vault password, recovery code or 2FA codes? ✔

Want to know more about how Deeperguard protects your vault? Our [security page](/security) explains the design, and the source is available for review on our [verify page](/verify).
