---
title: "A vault password you'll actually remember: how to build a strong passphrase"
slug: vault-password-passphrase
date: 2026-11-03
description: "Your vault password is the one secret everything else rests on. Here's how to build a long, memorable passphrase, where to keep a backup, and what to avoid."
cover_image: /static/blog/vault-password-passphrase.jpg
cover_alt: "Illustration of four blank rounded tiles linked into a chain that ends in a key, beside a closed teal padlock on a soft cream and blue background"
draft: true
---

Deeperguard is built so that your notes are encrypted on your device with AES-GCM 256 before they sync, and our servers only ever hold ciphertext. That design has one consequence worth taking seriously: your vault password is the secret that everything else rests on. Make it strong, make it memorable, and keep it to yourself.

## Why length beats cleverness

Swapping letters for symbols (`P@ssw0rd!`) feels clever, but attackers' guessing tools know every one of those tricks. What actually slows guessing down is length and randomness. A password that is long and genuinely random is far harder to guess than a short one dressed up with symbols.

The easiest way to get long *and* memorable is a passphrase: several random, unrelated words strung together.

## How to build a passphrase in two minutes

1. **Pick the words at random.** Don't choose them yourself; people are bad at randomness. Use a diceware word list with real dice, or a trusted password manager's passphrase generator.
2. **Use at least five words.** For example (don't use this one, it's now public): `orbit cactus velvet harbor sixty`.
3. **Keep the words unrelated.** No song lyrics, quotes, pet names, birthdays or anything someone could find on your social media.
4. **Add a separator if you like.** Spaces, dashes or a single digit between words are fine. Length still does most of the work.
5. **Practice it a few times.** Type it daily for the first week and it will stick.

## Use it for Deeperguard only

Never reuse your vault password anywhere else. If another site is breached and your password leaks, attackers will try it on other services. A unique passphrase means a breach elsewhere stays elsewhere.

Deeperguard checks your vault password with SRP, which proves you know it without the password ever being readable on the wire. That protects it in transit. Keeping it unique protects it everywhere else.

## Keep a backup you control

A memorable passphrase can still be forgotten after a long holiday. Keep a backup somewhere only you control:

- In a password manager you already trust, or
- Written on paper and stored somewhere safe at home, not in a note on your phone or in your email.

Store your Deeperguard recovery code the same careful way, and separately from your passphrase if you can. Remember: Deeperguard will never ask you for your vault password or recovery code by email, chat or phone. Anyone who does is trying to scam you.

## What to avoid

- Personal details: names, dates, addresses, favourite teams.
- Famous phrases, lyrics or keyboard patterns like `qwerty123`.
- Sharing it "just this once" with anyone, including someone claiming to be support.
- Typing it on a page you reached through a link. Open Deeperguard from your own bookmark instead.

## Quick checklist

- Five or more random words? ✔
- Used nowhere else? ✔
- Backup stored somewhere only you control? ✔
- Recovery code stored safely too? ✔

Want to see how your password and notes are protected? Our [security page](/security) explains the design, and Deeperguard's source is available for review on our [verify page](/verify). We'd rather you check than take our word for it.
