---
title: "A reminder on a note, without telling the server which note"
slug: private-note-reminders
date: 2026-11-18
description: "How private note reminders in Deeperguard work: the time stays inside the encrypted note, the optional closed-app push sends only a random ID and a 15-minute window, and what it can't do."
cover_image: /static/blog/private-note-reminders.svg
cover_alt: "Abstract dark blue background with a soft bell shape, a ring of dashed arcs and a small closed rounded square, no text"
draft: false
---

Notes are often things you have to come back to: a form due on Friday, a call to return, a gift to order. A reminder on the note itself is the obvious tool. It is also an awkward one for an encrypted app, because a reminder is a date, and a date attached to a specific note is information. Deeperguard's private note reminder is built so that the note and its time stay in your vault, and the server learns as little as possible while still being able to wake your device.

## Setting one

Open a note, open its info panel, and find **Private reminder**. Pick a date and time and press Save. A small bell and the time appear on the note in your list. Clear removes the reminder again.

The time is saved inside the encrypted content of the note, like the title and body. It syncs between your devices the way the note does, and the server only sees it as ciphertext. Each note has one private reminder.

## Reminders while Deeperguard is open

Without any extra setting, a reminder works while Deeperguard is open in a browser tab or the installed app and your vault is unlocked. At the chosen minute it shows inside the app and, if you have allowed browser notifications, as a notification. The check runs on your device, so nothing about it goes to the server.

If Deeperguard was closed at that moment, the reminder is not lost. The next time you open the app and unlock, a reminder from the last 24 hours is shown once, marked "Missed". A protected note keeps its title out of the reminder text.

## Reminders when the app is closed (optional, Pro)

If you want a nudge when Deeperguard is not open, tick **Also remind me when the app is closed**. This needs a Pro plan and push turned on for this device in the Calendar settings, and your browser has to allow push messages. Only then does anything about the reminder leave your device.

What the server stores for it is deliberately small:

- a random 32-character ID made in your browser, not derived from the note, its ID or its time;
- the start of the 15-minute window that contains your reminder time (the time rounded down to a multiple of 15 minutes);
- a link to the device you enabled, whose push address (the endpoint and keys from your browser) the server holds so that it can send the push.

The server rejects a window that is not a multiple of 15 minutes, and rejects any extra field in the request. It never receives the note's ID, title, text or your exact minute. Because the window is rounded down, the notification can arrive up to 15 minutes before the time you chose. If you choose the finer timing in the Calendar settings, that becomes 5 minutes, and the server then learns the time to within 5 minutes instead of 15.

When the window starts, the server sends a push message with no content and deletes the row. Your browser's service worker shows its own generic notification: "You have a reminder". When you open it, the app looks through your notes on your own device and opens the one whose window just began. The server never learns which note that was.

If you change the time, clear the reminder, or trash or delete the note, the app withdraws the old window by its random ID. If a window is more than 30 minutes overdue when the server reaches it, it is deleted without sending, because "your reminder is due" hours later would be wrong. The same happens if the account is no longer on a plan that includes it.

## What the server and others can still see

Be clear about the trade-off. For a closed-app reminder:

- Our server knows that your account has a pending reminder and roughly when it is due, to within the window. It does not know what it is for.
- An account can have at most 50 pending push windows at once, shared with other closed-app reminders, so the number of them is visible to the server too.
- The push service run by your browser's vendor (Google, Apple or Mozilla) can see that a notification is sent to your device, and when. Copies in our backups and logs, and anything your push service keeps, may remain until they expire.
- Delivery is not guaranteed. Browsers, battery savers and operating systems can delay or drop a push.

## What it does not do

- It does not hide the existence or approximate timing of a closed-app reminder from the server. If that matters to you, leave the box unticked and use only in-app reminders, which send nothing to the server.
- It does not put the note's title or text in a push message. The notification is generic by design.
- It does not remind you at the exact minute when the app is closed.
- It does not show in-app reminders while Deeperguard is closed; those appear as "Missed" at the next unlock.
- Opening the notification does not bypass your vault. If it is locked, you unlock first.

## A practical way to use it

Use the in-app reminder for most things; it is the most private and the most precise. Turn on the closed-app option only for the few notes where a missed reminder would cost you, and give yourself some slack, since the push may come up to a quarter of an hour early. For anything critical, add a second safeguard outside the app.
