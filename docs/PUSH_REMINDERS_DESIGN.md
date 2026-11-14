# Closed-app push reminders and the metadata claim (design)

Status: design for the owner's decision. Nothing here is implemented. No code,
schema or UI text changes with this document. Roadmap idea #54 (size M), the
"push notifications" part. It extends `docs/REMINDERS_TASKS_SPEC.md` (sections 1,
8 and 9) and must stay consistent with `docs/PRIVACY.md`.

Goal: reminders that still arrive when Deeperguard is closed, **without weakening
zero-knowledge** and without a privacy claim that is stronger than what we can
prove. The text of the claim is in section 7. The decision needed from the owner
is in section 8.

Language: English, like the app. Platform behaviour (iOS, Android, push
services) is described from general knowledge of the Web Push standards and
must be re-verified on real devices before launch; items that need this are
marked **verify**.

## 1. What exists today

Read from the code in this tree.

| Fact | Where |
| --- | --- |
| The server already sends Web Push with VAPID for agenda reminders. | `app/agenda_reminder_cron.py` `try_send_push`, `app/app.py` `api_agenda_push_subscribe` |
| The server stores, per account, the push `endpoint` and the full `subscription_json` (endpoint plus `p256dh` and `auth` keys). Max 10 rows per account. | `app/db.py` table `web_push_subscriptions`, `WEB_PUSH_SUBSCRIPTION_CAP` |
| Endpoints are only accepted for `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com` and their known suffixes. | `push_endpoint_allowed` |
| Agenda reminders store `fire_at` as an **exact** timestamp in clear, plus an id and an optional time label. | `agenda_scheduled_reminders` |
| Note reminders store the note uuid and the exact `warn_at` in clear. | `note_reminders`, `app/warning_cron.py` |
| The push payload is `{title, body, url, reminder_id}` with generic text. It is encrypted to the browser by the Web Push protocol. | `try_send_push` |
| The service worker returns early when a push has no data, so an empty push shows nothing today. | `app/static/sw.js` `push` handler |

So today's push is "option A" below. It is not private about timing. The
existing text in the spec (section 8) already says so for the exact-time
channels, and that stays true.

## 2. Ground rules that apply to every option

- Web Push payloads are end-to-end encrypted between the sender (our server)
  and the browser (RFC 8291). The push service cannot read them. It does see
  the endpoint, the size of the message, the time, the sender's IP, the VAPID
  public key (which names Deeperguard as the sender) and request headers such as
  TTL and Urgency. We never set a `Topic` header, because it would be a stable
  label.
- A push must result in a visible notification (`userVisibleOnly`). Chrome and
  Safari can revoke the subscription if a push shows nothing. So **silent cover
  traffic is not possible**: a fake push would show a fake notification to the
  user. This limits what "noise" can do (option B).
- When Deeperguard is closed the browser has no key. The service worker cannot
  decrypt anything, so the notification text can only be generic, for example
  "You have a reminder".
- Local reminders (option C) never contact the server. Hard rule from the spec.

## 3. Option A: server-timed Web Push, exact times

The server stores one row per reminder with the exact fire time and sends a push
at that time. The payload is empty or generic.

What each party learns (A):

| | Server (ours) | Push service (Google, Apple, Mozilla) | Network observer |
| --- | --- | --- | --- |
| Exact time of each reminder | **Yes**, the exact `fire_at` in clear | **Yes**, a push arrives at that second | Yes, at the moment of the push (device side and server side) |
| Endpoint | **Yes**, stored | **Yes**, it is theirs | Device side: sees the connection to the push service host, not the path |
| Push keys (`p256dh`, `auth`) | **Yes**, stored | No (they never receive them) | No |
| IP address | **Yes**, at subscribe and at every upload | **Yes**: our server's IP on send, the device's IP when it connects to receive | Yes, both ends |
| Number of reminders | **Yes**, one row each | **Yes**, one push each (can be counted) | Yes, by counting pushes |
| Account | **Yes** (row is tied to the user) | No account, but a stable endpoint per device | No |
| Which note or event | Note reminders: **yes**, the note uuid is stored. Agenda: a stable id only | No | No |
| Text or title | No, if the payload is generic | No (encrypted, and generic anyway) | No |

Reliability and cost: best timing (to the second). Same dependencies as the
other options (section 5).

Verdict: this is what exists. It must keep the label "our server learns when the
reminder is due". It cannot carry a claim about timing privacy.

## 4. Option B: server-timed Web Push, coarse windows

Same transport as A, but the server never receives the real time.

Mechanism:

1. The client turns the real fire time into a **window**: the real time rounded
   **down** to a 15-minute boundary (UTC, aligned to 900 s). Rounding down means a
   reminder is never late; it can arrive up to 15 minutes early.
2. The client uploads `{id, window_start}` where `id` is a fresh random value
   from `crypto.getRandomValues` (16 bytes). It is **not** derived from the
   note uuid, the event id or the time. The client keeps the mapping
   `id <-> item` only inside the encrypted item.
3. The server **rejects** any `window_start` that is not a multiple of 900 s
   (HTTP 400). Even a buggy or malicious client cannot send an exact time.
4. At `window_start` the server sends an empty push (no payload, or a fixed
   constant string) and **deletes the row immediately**, with no `sent_at`
   history.
5. The service worker shows a generic notification ("You have a reminder").
   If a page or the unlocked app is available it may replace it with the real
   text from local state. A `tag` avoids duplicates with a local reminder
   (option C) that fired at the exact time.
6. The service worker `push` handler must be changed to handle `event.data ==
   null` (today it returns early). This is an implementation note, not part of
   this task.

What "noise" can and cannot do: the owner asked about "vergroving of ruis".
Coarsening is the real protection. Added noise has two problems. First, fake
reminders would be pushed and shown (section 2), so they annoy the user and on
iOS risk the subscription. Second, a decoy marked as a decoy to the server is
useless, and one not marked becomes a visible notification. So B does **not**
hide the number of reminders. The only count control is a cap per account (for
example 50 pending windows). Random jitter on top of the window (a random
offset of a few minutes inside the window) is possible, but it adds nothing the
server can use, because the server only ever knows the window.

What each party learns (B):

| | Server (ours) | Push service (Google, Apple, Mozilla) | Network observer |
| --- | --- | --- | --- |
| Time of each reminder | The **15-minute window** only, not the minute. Also the time of the upload, which is roughly when the user set the reminder | The time of each push, i.e. the window start. They know a notification arrives around then | Same as the push service for the part they can see: device side sees traffic at the window start; server side sees our POST to the push service at the window start. Upload requests are visible by time and size, not by path |
| Endpoint | **Yes**, stored | **Yes**, it is theirs | Device side: connection to the push service host, not the path |
| Push keys (`p256dh`, `auth`) | **Yes**, stored | No | No |
| IP address | **Yes**, at subscribe, upload and in access logs | **Yes**: our server's IP on send; the device's IP when it connects | Yes, both ends |
| Number of reminders | **Yes**, per account (rows pending) | **Yes**, one push each | Yes, by counting pushes |
| Account | **Yes** | No account, but a stable endpoint | No |
| Which note or event | **No**: the id is random and unlinkable to the item | No | No |
| Text, title, exact minute | **No** | **No** | **No** |

Reliability: the same as A. Timing: 0 to 15 minutes early. Documented in the UI
as "up to 15 minutes early" if the app is closed.

## 5. Option C: no push, local only

Reminders fire from a timer or the service worker only while the app (or the
installed PWA) is running and unlocked. When Deeperguard is closed, nothing
reminds the user; on the next open we show what was missed (spec section 8).

What each party learns (C):

| | Server (ours) | Push service (Google, Apple, Mozilla) | Network observer |
| --- | --- | --- | --- |
| Time of each reminder | No | No | No |
| Endpoint | No (none is created) | No | No |
| Push keys | No | No | No |
| IP address | Only the normal IP of normal use (sync, login) | No | Normal traffic only |
| Number of reminders | No | No | No |
| Account | Only what sync already shows | No | No |
| Which note or event | No | No | No |
| Text, title, exact minute | No | No | No |

Reliability: no delivery with a closed app, by design. This is the strongest
privacy position and the only one where the claim "the server learns nothing
about your reminders" is true.

## 6. Reliability, unsubscribing, data, opt-in

### 6.1 Reliability (A and B; verify on devices)

| Platform | Expected behaviour | Risk |
| --- | --- | --- |
| Android, Chrome (FCM) | Delivers with the app closed, including after the process is killed. High urgency pushes pass Doze most of the time. | Aggressive vendor battery savers and "force stop" stop delivery. Delay is possible. |
| Android, Firefox (Mozilla autopush) | Works while Firefox is allowed to run in the background. | Less reliable than Chrome on battery-restricted devices. |
| iOS and iPadOS 16.4 and later (Apple) | Only for a PWA **added to the Home Screen**. Permission must be requested from a user tap. A Safari tab cannot receive push. | Every push must show a notification or the subscription may be dropped. The behaviour of installed web apps in the EU and Focus modes must be re-checked. Users often forget the Home Screen step. |
| Desktop (Chrome, Edge, Firefox, Safari 16+) | Works while the browser process exists. | A quit browser receives nothing on some systems. |

Therefore push is "best effort" and the UI must say so: it must never promise
delivery for something that matters (a medicine, a flight). Local fallback: when
the app opens, missed reminders are shown (spec section 8).

### 6.2 Unsubscribing and deleting data

- **Toggle off** (per device): the page calls `PushSubscription.unsubscribe()`,
  then `DELETE` for that endpoint. The server deletes the subscription row
  **and** all pending window rows of that device in one transaction.
- **Remove a single reminder**: delete its window row (random id). Deleting the
  note, trashing it, or editing the date also cancels the row through the
  existing lifecycle hooks.
- **After sending**: the window row is deleted at once (B). No history of past
  reminders is kept.
- **404 / 410 from the push service**: the subscription and its rows are purged
  (already done for subscriptions today).
- **Account deletion**: both tables use `ON DELETE CASCADE` on `users`, so the
  rows go with the account (`db.delete_user`).
- **What we cannot delete**: copies in our server backups until they rotate out
  (retention to be stated from `docs/PRIVACY.md`; **owner to confirm the number
  of days**), web-server access logs until their rotation, and anything Google,
  Apple or Mozilla keep about the endpoint or about past pushes. We do not
  control those, and the claim says so.

### 6.3 Opt-in

Yes, opt-in, off by default, **per device**.

- No push permission prompt and no call to a push endpoint on page load or on
  first run. The prompt appears only after the user turns the toggle on and has
  read the text of section 7.
- Turning it on is separate from setting a reminder. A reminder without the
  toggle is a local reminder (option C).
- iOS needs a user gesture for the permission anyway.
- The settings text states what the server stores, in the words of section 7.

## 7. Recommendation and the privacy claim

### 7.1 Recommendation

1. Keep **C (local only)** as the default and as the only mode that is claimed
   as "the server learns nothing about your reminders".
2. Add **B (coarse windows)** as an opt-in, per-device "closed-app reminders"
   switch. It is the only way to get closed-app delivery without giving the
   server the real time.
3. Do **not** present **A** as private. The existing exact-time channels keep
   the existing wording of `docs/REMINDERS_TASKS_SPEC.md` section 8 ("our
   server learns the time of the reminder"). Route new work to B.
4. Do not add fake reminders or fake notifications as noise (section 4).

Reasons: B removes the one piece of metadata that gives reminders their value
as surveillance data (the exact minute) and any link to a note, at a cost the
user can see (up to 15 minutes early). It does not remove the account,
endpoint, IP or count, and the text must not hide that.

### 7.2 Claim for the settings screen (literal text)

Use exactly this text, next to the toggle. Do not shorten it.

> Reminders when the app is closed (optional, off by default). When this is on, our server stores a random ID and a 15-minute time window for each reminder, together with your account, the time and your IP address when you set it, and this device's push address (the endpoint and push keys from your browser). At the start of the window it sends an empty push and your device shows "You have a reminder", up to 15 minutes before the exact time. About the reminder itself, our server learns only that window: never its text or title, which note or event it belongs to, or the exact minute. It does know how many reminders you have set. Google, Apple or Mozilla, whichever runs your browser's push service, can see that a notification is sent to your device around that window. Turning this off removes these rows from our server and unsubscribes this device. Copies in our backups and logs, and anything kept by Google, Apple or Mozilla, are outside our control and may remain until they expire. Delivery is not guaranteed.

### 7.3 Claim for the website (literal text)

> Optional closed-app reminders. If you turn them on, about each reminder our server learns only a 15-minute time window and a random ID: never its text or title, which note or event it belongs to, or the exact minute. Our server also knows your account, your device's push address, your IP address, when you set each reminder and how many reminders you have set. Google, Apple or Mozilla, who run your browser's push service, see that a notification is sent to your device around that window. This is off by default. Turning it off removes these rows from our server, but not copies in our backups or logs, or at your push service, until they expire. If you leave it off, reminders are fully local and only fire while Deeperguard is open.

Scope: these claims cover only the new window mode. The older exact-time email
and push channels keep their own text ("our server learns the time of the
reminder"), and the UI must not show 7.2 or 7.3 for them.

### 7.4 How each part of the claim is checked

Each check is an automated test or a release step. A claim sentence may only
ship while its checks pass.

| Claim | Check |
| --- | --- |
| "learns only that window", never the exact minute | (1) API test: `window_start` not a multiple of 900 returns 400 and writes nothing. (2) Client test with a mocked `fetch`: set a reminder at a time such as 10:07:43; collect every request (URL, headers, body); assert the exact epoch, the ISO string and its minute never appear and that the body keys are exactly `id` and `window_start`. (3) Storage test: after create, dump every table and all rows of the SQLite file and assert the exact time is not found in any column; `created_at` is the upload time, which the claim names. (4) Log test: run create, fire and delete with log capture and a fake access-log fixture; assert no record contains the exact time, a note uuid, a title or a request body. A grep step confirms no middleware logs request bodies. |
| "random ID", not linked to a note | Test: two reminders for the same note get different ids; ids have 128 bits; the generator takes no uuid or time argument (static check). The server schema test asserts the **exact** column set of the new table (`id`, `user_id`, `device_id`, `window_start`, `created_at`), so any new column fails the test until the claim is reviewed. |
| "never its text or title, nor which note" | Test: the server API rejects any extra key in the upload (strict allow-list, as `ALLOWED_UPLOAD_KEYS` does today). Test: the push call has no payload or the fixed constant, no `Topic` header, and fixed size. |
| "up to 15 minutes before" | Test: for random times, `window_start <= real time < window_start + 900`. |
| "empty push ... You have a reminder" | Service-worker test: a push with `event.data == null` calls `showNotification` with the generic text. |
| "also knows account, push address, IP, set time, count" | This is listed so the claim stays honest. Test: the table schema and the subscription row match the list; if a new field appears, the claim must change. |
| Google, Apple or Mozilla "see that a notification is sent" | Not testable by us; it follows from the protocol. The claim only says what they can see, not what they do with it. |
| "off by default", no call before opt-in | Test: with the toggle off, a mocked network sees no call to any push endpoint and `Notification.requestPermission` is never called on load. |
| "turning it off removes these rows" | Tests: toggle off deletes the subscription row and all window rows for that device; account deletion cascades with foreign keys enabled; 404/410 purges; rows are deleted after the push. |
| Backups and logs "may remain" | Release step: the retention numbers in `docs/PRIVACY.md` match the real backup and log rotation. |
| Same text everywhere | Test: the claim block in 7.2 and 7.3 is byte-identical to the strings in `app/templates/app.html` and the website page. |

## 8. Decisions for the owner

1. Approve B as an opt-in feature and C as the default? (Recommended: yes.)
2. Is a window of 15 minutes right? A larger window (30 or 60 minutes) hides
   more but arrives earlier. Shorter (5 minutes) leaks more. (Recommended: 15.)
3. Confirm the backup and log retention numbers so the "may remain until they
   expire" sentence can name them.
4. Accept that the count of reminders per account, the IP, the account and the
   endpoint stay visible to the server, and that silent cover traffic is not
   possible?
5. Keep the old exact-time channels, labelled as such, or retire them once B
   exists?
6. Is iOS Home-Screen-only delivery acceptable as stated in the UI?

Nothing in the app or server is changed by this document.
