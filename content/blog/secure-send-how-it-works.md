---
title: "Share a note without leaking it: how Secure Send works"
slug: secure-send-how-it-works
date: 2026-10-28
description: "Share an encrypted note by link with Deeperguard Secure Send. The decryption key stays in the URL fragment; the server only stores ciphertext."
cover_image: /static/blog/secure-send-how-it-works.jpg
cover_alt: "Abstract illustration of a locked link for private note sharing."
draft: false
---

You sometimes need to hand someone a note — a Wi-Fi password, a contract snippet, a temporary password — without emailing it in the clear and without giving them a vault account.

Deeperguard’s **Secure Send** does that in the browser: encrypt on your device, store only ciphertext on the server, put the decryption key in the `#` part of the link so browsers never send it to any server.

## What Secure Send is (and isn’t)

Secure Send is link-based sharing for a note (and optional attachments you choose). It is not a permanent shared folder, and it is not the same as sync between your own devices.

- You create the link from the app (sidebar link icon, or **Share by link** on a note).
- Encryption runs in your browser before anything is uploaded.
- The server stores an opaque ciphertext blob plus limits you set (expiry and max views).
- The decryption key lives in the URL fragment (`#…`). Fragment data stays in the browser; it is not sent with the HTTP request to deeperguard.com.
- Recipients open the link, tap Open, and decrypt locally. You choose once, or up to N views.
- You can reopen what you sent from **Sent** in your vault on your devices.

To verify the wire yourself: [Secure Send on /verify](https://www.deeperguard.com/verify#verify-secure-send).

## Step by step

1. Unlock your vault in the [Deeperguard app](https://www.deeperguard.com/app).
2. Open the note you want to share (or start Secure Send from the sidebar).
3. Choose what to include. Attachments from the note can come along — edit the set before you create the link.
4. Set expiry and max views. Prefer the smallest useful window and view count.
5. Optional: add a passphrase. That passphrase is stretched with the same client Argon2id parameters as vault KDF v2 and combined with a random fragment key, so the bare link alone cannot decrypt.
6. Copy the **full** URL, including the `#…` fragment. If you strip the fragment, the recipient gets ciphertext they cannot open.
7. Send the link through a channel you trust for that recipient. Treat the full URL like a secret.

On the receive side, a plain page load of the receive URL does not burn a view (preview bots that only GET/HEAD the page do not call open). Opening for real decrypts after the open request returns the same opaque ciphertext.

## What the server sees

On create, the upload is ciphertext fields (`v` / `iv` / `data`), plus `expires_in` and `max_views` — not the filename, MIME type, passphrase, or fragment key.

On open, the API returns opaque ciphertext again. File name, MIME, and size appear only after local decrypt. Response headers stay generic on purpose.

That matches the product claim: sync and Secure Send store ciphertext; the one place note text can leave your vault in readable form is **Ask AI** with Ollama Cloud, which is opt-in and separate from Secure Send.

## Habits that keep the share honest

- **Copy the whole link.** Without `#…`, there is nothing useful to decrypt.
- **Short expiry, few views.** Especially for one-time secrets — pick short expiry and few views so the link stops working when the moment has passed.
- **Passphrase for higher-stakes shares.** Share the passphrase out of band (call, Signal, etc.), not in the same email as the link.
- **Don’t paste the link into places that strip fragments** (some messengers and ticketing tools mangle `#`).

## How this fits zero-knowledge notes

Your vault notes are encrypted on the device before sync. Secure Send uses the same idea for a one-shot share: encrypt first, store ciphertext, keep the key off the server.

It does not hide metadata such as that a share existed, when it expires, or rough size. Zero-knowledge here means the host should not be able to read the note body from what it stores — not that sharing is invisible.

If you want to confirm login, sync, Secure Send, and Ask AI yourself, use [Verify zero-knowledge](https://www.deeperguard.com/verify). Public beta accounts currently include Pro features at no charge, with no payment details collected; check the live site for the current schedule.

## Next

- Create a vault: [deeperguard.com](https://www.deeperguard.com/)
- Open the app: [deeperguard.com/app](https://www.deeperguard.com/app)
- Verify claims: [deeperguard.com/verify](https://www.deeperguard.com/verify)

Questions or a vulnerability report: notes@deeperguard.com (subject “Vulnerability report” for security).
