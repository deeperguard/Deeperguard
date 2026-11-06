---
title: "Your calendar stays in the vault: how Deeperguard Agenda works"
slug: vault-encrypted-agenda
date: 2026-11-07
description: "Appointments and join links belong with your private notes. Here's how vault-encrypted Agenda keeps events on your device until you unlock, what you can import today, and what we deliberately don't sync yet."
cover_image: /static/blog/vault-encrypted-agenda.jpg
cover_alt: "Soft abstract cream and slate-blue wave shapes with subtle halftone dots, calm privacy-product header with no text"
draft: true
---

A calendar full of client calls, school pickups, and meeting links is just as sensitive as a note with passwords. If the host can read every title and location, encryption on your notes only solves half the problem.

Deeperguard Agenda keeps those events inside the same vault as your notes. Events are encrypted on your device before anything syncs. The server stores ciphertext, the same way it does for notes (with the usual Ask AI exception when you choose to send text).

## What you can do today

After you unlock your vault, Agenda gives you day, 3-day, week, and agenda list views so you can plan the next stretch without leaving the encrypted workspace.

You can also import a local `.ics` file once the vault is unlocked. That is handy when you already have an export from another calendar app and want the events sitting next to your private notes — without pasting titles into a chat or a cloud that can read them.

For video calls and similar joins, Agenda uses ordinary HTTPS join links. You open the link the same way you would from any calendar; we do not invent a special protocol for that step.

## What stays out of scope (on purpose)

A few calendar features sound convenient and quietly widen who can see your schedule. We are not claiming them yet:

- Remote webcal subscription (pulling a live calendar URL from somewhere else)
- Multi-user share of a calendar
- Calendar sync with Google, Apple, or other cloud calendars

If you need those later, they will land as clear, claim-checked features — not as silent add-ons in a how-to.

## Why vault encryption matters for events

Event titles leak a lot: who you meet, which clinic you visit, which project is on fire. Locations and notes leak more. Keeping Agenda in the vault means those strings are encrypted with AES-GCM 256 on your device before sync, and your vault password is never sent in readable form (sign-in uses SRP).

That matches the rest of Deeperguard: ciphertext on the server, readable text only on a device you unlock.

## A simple habit for private scheduling

1. **Unlock first, then import.** Local ICS import runs after unlock so plaintext from the file is handled on your device inside the vault session.
2. **Prefer HTTPS join links you already trust.** Paste the real meeting URL; don't route it through a random shortener you can't verify.
3. **Keep sensitive context in encrypted notes.** If a meeting needs a door code or a client brief, put that in a vault note and link it from the event description only if you need it there.
4. **Don't paste the whole week into chat.** Screenshots and forwarded agendas are hard to take back. Share the minimum, or use Secure Send when someone needs a secret that isn't an event title.

## Quick checklist

- Events live in the vault after unlock? ✔
- Using day, 3-day, week, or agenda views for planning? ✔
- Local ICS import only when you meant to bring a file in? ✔
- Join links are plain HTTPS you recognize? ✔
- Not expecting remote webcal, multi-user share, or cloud calendar sync yet? ✔

Agenda uses the same on-device AES-GCM and SRP design as notes — details on our [security page](/security) and [verify page](/verify).
