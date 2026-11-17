---
title: "Lock it before you forget: how Deeperguard's auto-lock works"
slug: auto-lock-idle-and-leaving
date: 2026-11-16
description: "Deeperguard can lock your vault after a period of inactivity and when you leave the app. Here's what each setting does, which defaults apply, and what locking can and can't clear."
cover_image: /static/blog/auto-lock-idle-and-leaving.svg
cover_alt: "Abstract dark blue gradient with a clock face next to a closed padlock"
draft: false
---

One of the most common ways a vault gets read is not a clever attack. It is an unlocked screen left on a desk. Deeperguard's auto-lock exists for that moment: you get pulled into a meeting, you switch to another app, and the vault locks without you having to remember.

There are two separate settings in Settings, next to the vault password options. They do different jobs, so it helps to know which one you want.

## Lock after idle

**Lock after idle** locks the vault when you haven't touched it for a while. The choices are Off, 1, 5, 15, 30 and 60 minutes. The default is 15 minutes.

Some details that are easy to get wrong:

- **What counts as activity.** The timer restarts on a mouse or finger press, a key press, or a touch. If you read a long note without clicking or typing, the vault can lock after the chosen time.
- **It won't interrupt an unlock.** If an unlock is in progress, the unlock screen is showing, or (on iOS) you are typing in a text field, the timer waits and starts again instead of locking.
- **Off means off.** With Off, the vault key stays in memory until you lock manually or close the tab. The settings screen says so next to the option. Choose Off only on a device that is yours alone.

## Lock when leaving the app

**Lock when leaving the app** reacts to you switching away from the page, for example to another tab or app. There are three choices:

- **Never**
- **Immediately**
- **After 1 minute**

New setups start on **After 1 minute**. If you come back within a minute, you carry on where you were. If you were away a minute or longer, the vault is locked when you return. If the page is reloaded in the meantime and you were away for the time you set, the app opens on the lock screen.

A few situations are treated as part of your work rather than as leaving. While the document scanner is open, while a file picker is open, or while the app is installing an update, leaving the page does not start the lock. Otherwise, choosing a file from another app could lock you out of your own note.

When a lock comes from leaving the app, the next unlock has to be typed: the app asks for your vault password again.

## What happens when it locks

Locking is the same routine as the **Lock vault now** button in Settings. In short:

1. The lock screen appears at once.
2. Unsaved edits in the open note are saved to the local store on your device. The app also tries to push pending changes to the server, but waits at most about 2.5 seconds. If the network is slow, those changes stay in the local encrypted queue and are sent after your next unlock.
3. The open note, the note list, undo history, previews, thumbnails, decrypted attachment links and the AI chat history are cleared from the page, and the vault key is dropped from the app's state.

Unlocking again needs your vault password.

## A sensible setup

- **A phone or laptop that is only yours:** keep idle at 15 minutes and leave "leaving the app" on After 1 minute. If you are often in public places, go down to 5 minutes and consider Immediately.
- **A shared or travel device:** choose a short idle time and Immediately, and lock by hand when you walk away. Our post on [shared and travel devices](/blog/vault-safe-shared-travel-device) covers the rest of the routine.
- **A desk machine that locks its own screen:** a longer idle time is a reasonable trade, since the operating system lock is doing the real work.

Both settings are in the short list of preferences that Deeperguard syncs between your devices. That settings record is encrypted with your vault key before it leaves the device, so the server stores ciphertext, not readable settings. A choice you make on one device can carry over to the others.

## What auto-lock does not do

- **It cannot wipe memory perfectly.** The settings page says it plainly: locking is best effort, and JavaScript cannot clear everything from memory. Treat it as a real reduction in exposure, not a guarantee. Lock your device as well.
- **It doesn't protect a session you keep active.** If you keep working, or choose Off, the vault stays open.
- **It doesn't delete anything.** Your encrypted notes stay on your device and on the server. Only the readable copies in the open page are removed.
- **It doesn't hide that you use the app.** The server can still see account and sync metadata, such as when your devices connect and roughly how much encrypted data you store. It cannot read your notes.
- **It doesn't replace a good password.** Anyone who knows your vault password can unlock. See our [passphrase guide](/blog/vault-password-passphrase).

## Try it in two minutes

Open Settings, find **Lock after idle** and **Lock when leaving the app**, and pick values that fit where you work. Then switch to another tab for longer than your chosen time, come back, and check that the lock screen appears. Knowing it works is worth more than assuming it does.
