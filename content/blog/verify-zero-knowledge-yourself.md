---
title: "Don't take our word for it: verifying zero-knowledge yourself"
slug: verify-zero-knowledge-yourself
date: 2026-11-10
description: "Any app can say “zero-knowledge.” Here's how to check Deeperguard's claim yourself with your browser's DevTools and our /verify page, what you should see, and what these checks can't prove."
cover_image: /static/blog/verify-zero-knowledge-yourself.jpg
cover_alt: "Illustration of a browser window with a magnifying glass over a list of network requests, each shown as a locked teal envelope, on a soft cream and blue background"
draft: true
---

"Zero-knowledge" is easy to put on a homepage. It's harder to prove. So instead of asking you to trust our copy, we publish a [Verify zero-knowledge](/verify) page that shows what the shipped client sends, and how you can watch it happen in your own browser. No special tools needed, just the developer tools that come with Chrome, Edge, Brave or Firefox.

## Step 1: open the Network tab

1. Open Deeperguard in a normal browser window.
2. Open DevTools: Ctrl+Shift+I on Windows or Linux, ⌘+Option+I on macOS (in Firefox, Ctrl+Shift+E or ⌘+Option+E goes straight to Network).
3. Go to the **Network** tab and turn on **Preserve log** (Firefox: **Persist Logs**) so the list survives page changes.
4. Filter to **Fetch/XHR**, or type `api` in the filter box.

Now everything the app sends to our server shows up as a row you can click.

## Step 2: watch the sign-in

Reload the login page and sign in. Look for two requests:

- `POST /api/auth/srp/challenge`: the request body contains only your email.
- `POST /api/auth/srp/verify`: the request carries your email, a public value `A` and a proof `M1`.

Sign-in uses SRP, a protocol that lets the server check you know your password without receiving it. You should not see your password, or a field named `password`, in either request.

## Step 3: watch a note sync

Unlock your vault, create a test note, type something recognizable like "blue giraffe", and let it sync. Filter for `sync` and click `POST /api/sync/items`.

Each item carries a `ciphertext` field that looks like `{"v":1,"iv":"…","data":"…"}`, which is an AES-GCM envelope. Search the request for "blue giraffe". You shouldn't find it, because the note was encrypted in your browser before it was sent.

You'll also see what the server *can* see, including item IDs, timestamps, hashes, ciphertext sizes and your account email. We say that openly. Zero-knowledge covers what's inside your notes, not this metadata.

## Step 4: compare with "View on server"

In the unlocked app, open a note, then **Note info → View on server**. The dialog is titled "View on server" and shows two columns: "Server JSON (as stored)" and "Decrypted on this device". The server column should only ever hold ciphertext and metadata.

## The one honest exception: Ask AI

Ask AI is opt-in, and it's the one place where note text can leave your vault in readable form. When you use it, the text you choose for that request goes through our server to Ollama Cloud. Our server relays it and doesn't store your API key, the prompt or the answer. That "doesn't store" applies to our relay only; Ollama processes the text under its own terms, and we don't control their policy. The in-app send preview shows exactly what will be sent. If you never use Ask AI, nothing goes that way.

## Bonus: check the code you're running

Encryption only helps if the code doing it is the code that was published. Settings → About (and the /verify page) hashes the app files loaded in your browser and compares that hash with the one published on the matching GitHub release. For an independent check, you can rebuild the client from source at the release tag and verify the release signature with `cosign`. The steps are on [/verify](/verify).

## What these checks can't prove

Being honest about limits is part of the claim:

- Your browser only shows what's sent now. It can't show what a server keeps in old backups.
- Metadata like your email, IP address and request timing is still visible to the server.
- The in-browser hash check is served by our own site, so for full independence use the rebuild and `cosign` steps.

## Found something that doesn't match?

If you ever see your password, your vault key, or a readable note title or body in a sync request, our claim has failed and we want to know. Email notes@deeperguard.com with the subject "Vulnerability report".

For the full per-action table, Secure Send checks and the Ask AI details, see [Verify zero-knowledge](/verify). For a plain-language overview first, start with [How zero-knowledge notes work](/blog/how-zero-knowledge-notes-work).
