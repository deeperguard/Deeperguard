---
title: What Secure Send encrypts in the browser
slug: what-secure-send-encrypts-in-the-browser
date: 2026-10-28
description: A short overview of what stays on your device when you create a Secure Send link — aligned with the public /verify guide, not marketing claims.
cover_image: /static/blog/secure-send-cover.svg
cover_alt: Abstract illustration of a link and lock for Secure Send
draft: true
---

Secure Send is for sharing a note (and optional attachments) as a link. This post summarizes what the shipped client does before anything reaches our servers. For step-by-step DevTools checks, use [Secure Send on /verify](/verify#verify-secure-send).

## Encrypted in your browser

When you create a link, the note payload is encrypted locally. The server receives only an opaque ciphertext blob — the same shape described on `/verify` (`v`, `iv`, `data` fields). Filenames, MIME types, passphrases, and URL fragment keys are not sent in that upload.

## Key in the URL fragment

The decryption key material lives in the `#…` part of the URL. Browsers do not send the fragment to the server on navigation, so a plain `GET` or `HEAD` of the receive page does not expose the key.

## Optional passphrase

You can add an extra passphrase. The client stretches it with the same Argon2id parameters as vault KDF v2 and combines it with the random fragment key so the link alone is not enough to decrypt.

## Limits you choose

The create request includes `expires_in` and `max_views` — how long the link may work and how many opens count. Those values are policy fields, not note plaintext.

## Attachments

You can include attachments from the note when you build the link. They travel inside the same encrypted package; the server still stores ciphertext only.

## What to verify yourself

Open DevTools on the sender and recipient as listed on `/verify`: confirm `POST /api/secure-send` carries ciphertext and limits only, and that opening the link uses `POST /api/secure-send/<id>/open` for the blob — not a cleartext note body.
