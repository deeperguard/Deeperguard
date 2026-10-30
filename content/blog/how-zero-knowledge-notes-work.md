---
title: "How zero-knowledge notes work (and the one honest exception)"
slug: how-zero-knowledge-notes-work
date: 2026-10-28
description: "Deeperguard encrypts notes on your device before sync. Here’s what zero-knowledge means, what the server can still see, and the Ask AI exception."
cover_image: /static/blog/how-zero-knowledge-notes-work.jpg
cover_alt: "Abstract illustration of notes locked before they leave the device."
draft: false
---

“Zero-knowledge” gets used loosely. Here is what Deeperguard means by it for notes, what you can check yourself, and the one place readable text can leave your vault on purpose.

## The short version

Notes are encrypted on your device with AES-GCM 256 before sync. The server is meant to store ciphertext for those notes — not a readable copy of titles and bodies — except when you choose **Ask AI**, which sends the text you select through our server to Ollama Cloud and is not stored by us.

Your vault password is never sent in readable form. Sign-in uses SRP proofs so the host verifies you know the password without receiving the password itself.

Don’t take marketing at face value: open [Verify zero-knowledge](https://www.deeperguard.com/verify) and watch the Network tab during unlock, edit, and sync.

## What happens on your device

1. You unlock the vault. The device derives the vault key locally — Argon2id for vault KDF v2 accounts (legacy accounts still use the older SHA-256 stretch).
2. You write or edit a note. While unlocked, the client works with decrypted content on this device so you can read and edit.
3. On save/sync, the client wraps content in an AES-GCM envelope (`v` / `iv` / `data`) and pushes that ciphertext.
4. On another device, you unlock again; that device decrypts locally after pulling ciphertext.

On-device document OCR (WebAssembly in the browser) follows the same idea: text recognition runs on the device; extracted text is encrypted before sync. This post does not claim accuracy “enhancements” — only that OCR exists on the device.

## What the server can still see

Zero-knowledge for vault contents is not invisibility.

Without your vault password, the host should not read note bodies from stored ciphertext. It can still see account email, item IDs, timestamps, hashes, ciphertext sizes, and similar metadata. Traffic analysis and logs are outside the “can’t read the note” claim.

Sync freshness (rollback / freeze / fork detection) is documented on [/verify §4](https://www.deeperguard.com/verify): version counters and vault-head tips that the shipped client keeps inside AES-GCM ciphertext (or in vault-key-encrypted IndexedDB meta on the device) so the server still sees only the same ciphertext envelope and existing metadata. That is the live claim — no stronger.

## The Ask AI exception

Ask AI is opt-in. It is the one product path where note text you choose can leave the vault in readable form:

- Provider: Ollama Cloud (ollama.com).
- Your API key lives in your encrypted vault.
- Our server relays the request; it does not store your API key, the prompt, or the answer (same claim as Privacy / Settings).
- Only the text you select for that request is sent — use the in-app preview to see the payload.
- Provider policy can change; check the live Ask AI / verify wording if you rely on their retention promises.

Secure Send is different: it encrypts in the browser and keeps the decryption key in the URL `#` fragment so the server stores ciphertext for that share. It is not Ask AI.

## What support will never ask for

If someone claiming to be support asks for your vault password, recovery material, or 2FA codes, that is a scam. There is no remote restore that bypasses your vault password. Losing the password without a backup you control means the ciphertext stays unreadable — by design.

During the public beta, accounts include Pro features and no payment details are collected. Check the live site for the current schedule after beta.

## Check it yourself

- [Verify](https://www.deeperguard.com/verify) — per-action table, Secure Send, Ask AI, client hash checks  
- [App](https://www.deeperguard.com/app) — unlock and write  
- Source available for review on GitHub — inspect encryption and client code  

Security reports: notes@deeperguard.com with subject “Vulnerability report”.
