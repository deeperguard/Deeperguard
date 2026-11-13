---
title: "Subscribing to a calendar feed without handing us the link"
slug: agenda-calendar-subscriptions
date: 2026-11-13
description: "Deeperguard Agenda can now follow a webcal:// or https:// calendar feed. Here is how it fetches, where the link is kept, what the provider and our server can see, and what it does not do."
cover_image: /static/blog/agenda-calendar-subscriptions.svg
cover_alt: "Abstract slate-blue background with a soft grid of rounded squares and a dashed line looping back on itself, no text"
draft: false
---

When we wrote about [Deeperguard Agenda](/blog/vault-encrypted-agenda) last week, remote calendar subscriptions were on the "not yet" list. They are now in the app: paste a feed link from a school, a club or your work calendar, and the events stay up to date while your vault is open.

A feed link is not an ordinary URL. Many providers put a secret token in it: anyone who has the link can read the calendar. So most of this post is about where that link goes, and who gets to see it.

## How to subscribe

1. Unlock your vault and open the Agenda.
2. Open **Calendar settings** and find **Subscribed calendars**.
3. Paste the feed link. Both `webcal://` and `https://` links work; `webcal://` is rewritten to `https://`. Give it a name if you like. If you leave the name empty, it becomes "Calendar 1", "Calendar 2" and so on. We never derive the name from the link, because the link may be secret.
4. Click **Preview feed**. You see how many events the feed has and the first few titles, before anything is saved.
5. Click **Subscribe**.

Each subscription then has **Rename**, **Refresh** and **Delete**. Delete asks first, then removes the subscription and all of its events.

## Where the link lives

The feed link is stored inside the agenda data in your encrypted vault, next to the subscription's name, its last refresh time and, after a failure, a short error code. Like your events, that record is encrypted on your device before it syncs, so the server stores ciphertext.

The link is kept out of error messages (those use a fixed list of codes), toasts, local browser storage and event labels.

## Direct fetch: the default

By default your browser fetches the feed itself, straight from the calendar provider. Deeperguard's server is not involved in that request.

The fetch runs in a small dedicated worker that is created for one refresh and closed afterwards. It sends a plain GET with no cookies, no referrer and no custom headers. It accepts only `https`, gives up after 10 seconds and stops reading after 2 MB. The response goes through the same `.ics` parser and the same caps as a file import (10,000 events), and events are shown as text only. Nothing the feed points to, such as images or attachments, is loaded automatically.

What the calendar provider sees in this mode: your IP address, when you refresh, and that the link was used.

## When the provider blocks your browser

Many providers do not allow a web page to read their feeds directly (this is a browser rule called CORS). In that case you see an error, and the app offers a second option: **Fetch via server…**

This is a real trade-off, so the app asks first. The dialog says it plainly: the Deeperguard server will see the calendar link and the calendar contents while it fetches them. It does not store or log them. "No" is the default button.

If you say yes, that one subscription switches to the relay, gets a "via server" tag, and records the time you agreed. The server then fetches the feed for you and passes it back. The relay requires you to be signed in, takes the link in the request body (never in the address), accepts only `https` on port 443, allows 30 requests per hour per account, and has the same 2 MB and 10 second limits. It refuses links that point at private or internal network addresses and checks again at every redirect (at most three).

The provider then sees our server's IP address instead of yours. You can go back at any time with **Switch to direct**, which withdraws the consent.

Be clear-eyed about this mode: it is an exception to "the server only sees ciphertext". We do not store or log the link or the feed, but you cannot check that from your browser. If that matters to you, there is a third option: open the feed link in a new tab, save the `.ics` file and [import it](/blog/vault-encrypted-agenda). That keeps the link off our server, but doesn't update by itself.

## How refresh works

- Feeds refresh only while your vault is unlocked. The link can only be read then, so a locked vault cannot refresh.
- Automatic refreshes happen at most every 30 minutes while the Agenda is open. **Refresh** fetches immediately.
- There is no background refresh, no service-worker fetch and no server-side schedule.
- When the vault locks, timers stop, any running fetch is cancelled, and a late answer is dropped.
- The feed is the source of truth. New events are added, changed ones updated, and events that left the feed are removed.
- As a safety brake, if a refresh would remove more than half of a subscription's events (and more than 20), an automatic refresh is skipped and a manual one asks you first.
- A feed that fails to load or parse changes nothing.

## What it does not do

- **It does not keep your edits to subscribed events.** The next refresh overwrites them. The preview says so before you subscribe. Put your own notes in a separate event or an encrypted note.
- **It does not hide everything.** In direct mode the provider sees your IP address and when you refresh. In relay mode our server sees the link and the calendar while it fetches.
- **It does not write back.** Subscriptions are read-only. There is no two-way sync with Google, Apple or other cloud calendars, and no shared calendars.
- **It does not refresh while you're away.** If no device has the vault open, nothing is fetched.

One honest note on the design: to allow direct fetching, the worker may connect to any `https` host, while the main page stays limited to our own server. Our security documentation lists this as a known trade-off. If you never add a subscription, the worker never starts.