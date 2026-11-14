# Note reminders, dated tasks and quick capture (specification)

Status: design. Nothing in this document is implemented yet. It is the single
source for code, tests, PRIVACY.md and the in-app texts. Roadmap idea #54
(size M). Line numbers refer to the tree at the time of writing; re-check them
when those paths change.

Goal: make notes, agenda and tasks one app, with reminders and fast capture at
least as good as Notesnook, Joplin, Standard Notes (no reminders at all) and
Proton Calendar, **without weakening zero-knowledge**. Where a platform cannot do
something privately (closed app, iOS, widgets), we say so in plain words
(section 8) instead of faking it.

Hard rules for every section:

- **New data is only ever stored inside the existing AES-256-GCM ciphertext of an
  item, or in browser memory.** No new readable column, endpoint field, log line,
  URL, `localStorage` / `sessionStorage` / Cache Storage entry.
- **Local reminders never contact the server.** They add no row to
  `note_reminders` or `agenda_scheduled_reminders` and call no push endpoint.
- Old clients must keep working and must not destroy new fields.
- Everything shared or typed by the user is untrusted text: rendered as text,
  never as HTML.
- Spec and UI text are English, like the app (`app/templates/app.html`).

## 1. What exists today

Read from the code. "Reuse" says what the new feature builds on.

| Area | Where | What it does | Reuse |
| --- | --- | --- | --- |
| Note reminder (server-timed) | `app/static/js/app.js` ~16942-17060 (`noteReminderPayload`, `queueReminderOp`, `applyReminderOp`, `cancelNoteReminder`, `restoreNoteReminder`); field `content.warn_at` in the note payload (`app.js` ~10326, ~16942) | The note stores `warn_at` (ISO) inside its ciphertext **and** POSTs `{item_uuid, warn_at}` to `/api/reminders`. Pending ops are queued in `localStorage` key `notes_reminder_pending` (uuid + op, no time). | The date/time input and the `warn_at` field stay. Lifecycle hooks (trash, restore) are the model for local reminders. |
| Note reminder server side | `app/app.py` `api_reminders_*` (~2558-2724), `app/db.py` table `note_reminders` (~119), `app/warning_cron.py` | Server **sees** `warn_at` in clear and the note uuid, and mails/pushes. Title is blanked (`db.py` ~334). | Unchanged. Remains the only channel that works with a closed app. Opt-in, labelled as such (section 8). |
| Agenda reminders | `app/static/js/agenda-reminders.js`, `app/agenda_reminder_cron.py`, `db.py` `agenda_scheduled_reminders` (~337), endpoints `/api/agenda-reminders/*` (`app.py` ~2593-2710) | Offsets (`OFFSET_PRESETS`: at start, 5/10/15/30 min, 1 h, 1 day) per event; planned from the calendar's own occurrence expander; server stores `id`, `fire_at`, `channel`, optional `local_time_label` only (`ALLOWED_UPLOAD_KEYS`). Pro plan. Stable ids = SHA-256 of `(event id, slot, offset, channel)`. `localStorage`: `agenda_reminder_pending_v1`, `agenda_reminder_topup_at`. | `OFFSET_PRESETS`, `expandOccurrences()`, `normalizeOffsets()` and the stable-id idea are reused for local reminders. Server channels unchanged. |
| Agenda events | `app/static/js/agenda.js` (`defaultEvent()` ~2156, `type:'agenda_event'`, `version:1`), `store.js` ~1819-1990 (`listAgendaEvents`, save), `agenda-recurrence.js`, `agenda-occurrence.js`, `agenda-ics.js`, `agenda-scroll-core.js` | Events live in the item ciphertext. Agenda only lists `type === 'agenda_event'` (`store.js` ~1819), so an unknown `type` is ignored by it. | Month/week/day/agenda renderers, recurrence expander, detail card, Escape/focus handling (`agenda.js` ~379, ~2682, ~2849 `trapDialogTab`). |
| Notes | `store.js` ~1048 (`type:'note'`), `content.updated_at`, `pinned`, `starred`, `warn_at`; `templates.js` has a built-in `builtin:task` template | Items are `{content}` objects encrypted with `NotesCrypto.encryptObject` (`crypto.js`). | Item model, sync, IndexedDB ciphertext cache. |
| Rollback guard | `app/static/js/freshness.js` (`shouldTrackType`, `__fid`, `__fv`) | Every item type except `search_index` and `vault_head` gets a bound id and a monotonically rising version. | New item types are tracked automatically. Do not add a type that bypasses it. |
| Lock | `docs/LOCK_SPEC.md`, `store.js` `lock()`, `vault-secrets.js` | Key and decrypted items are dropped on lock. | Reminder timers must be cleared by the same path (section 4). |
| PWA manifest | `app/static/manifest.json` (served by `app.py` ~4085) | `display: standalone`, `start_url /app`, icons, `shortcuts` (`/app?action=new`, `/app?action=search`). **No** `share_target`. | Add `share_target` and a `quick-capture` shortcut. `app.js` ~3936 already reads `?action=`. |
| Service worker | `app/static/sw.js` | Precache + network-first app shell; skips `/api/`; `push` and `notificationclick` handlers (generic text only); `periodicsync` just pings open windows. **Handles GET only** (`fetch` handler returns for other methods). | Needs a POST handler for the share target (section 6). |
| Client manifest | `scripts/build-client-manifest.py`, `app/static/client-manifest.json`, `app/client_assets.py` | SRI/hash of shipped JS/CSS. | Rebuild when files under `app/static` change (implementation task, not this one). |

Gaps found while reading (must be resolved or documented, not copied):

- `agenda_reminder_pending_v1` in `localStorage` holds `fire_at` in plain text.
  That is the existing server-channel queue, not covered by the new rule, but it
  contradicts "no times in browser storage" for people who enable it. Section 9
  lists it as a known limit; the follow-up is to move it into the encrypted
  IndexedDB queue.
- Existing server reminders reveal time and (for notes) the item uuid. The new
  local reminders must be clearly distinguishable from them in the UI.

## 2. Data format (inside the encrypted payload)

All fields below live in the decrypted `content` object. The server still sees
only `{item_uuid, ciphertext, content_hash, ...}` (see `docs/SETTINGS_SPEC.md`
and the sync row in `store.js`). Unknown keys are always preserved on edit.

### 2.1 Reminder on a note

Added to `type: 'note'` content as one optional object:

```json
"reminder": {
  "v": 1,
  "at": "2026-12-01T09:30:00",
  "tz": "Europe/Amsterdam",
  "repeat": "",
  "snoozed_until": "",
  "fired_at": "",
  "dismissed_at": ""
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer | Schema version of this object. Currently `1`. |
| `at` | string | Wall-clock local time `YYYY-MM-DDTHH:mm:ss` **without offset**, interpreted in `tz`. Floating wall time survives DST and travel the way people expect ("09:30"). |
| `tz` | string | IANA zone at creation (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Empty = use device zone. |
| `repeat` | string | `""` or an RFC 5545 `RRULE` subset already supported by `agenda-recurrence.js`. Occurrences come from the same expander as the calendar. |
| `snoozed_until` | string | ISO-8601 UTC instant, empty if none. |
| `fired_at` | string | ISO-8601 UTC instant the reminder was last shown on any device, empty if never. |
| `dismissed_at` | string | ISO-8601 UTC instant of the last explicit dismiss. A repeat fires again for the next occurrence after it. |

Relation to `warn_at`: `warn_at` (ISO string, existing) stays untouched and keeps
meaning "also ask the server to notify me" (section 1). A note may have either,
both, or neither. A client that reads `reminder` and finds `warn_at` with no
`reminder` shows a **server** reminder (legacy behaviour), never a local one. We
do not silently convert `warn_at` into `reminder`, because that would turn a
channel that works with a closed app into one that does not.

### 2.2 Task with a due date

A task is its own item type, so the agenda can list it without scanning every
note and old clients ignore it (they only list `agenda_event`, `store.js` ~1819):

```json
{
  "type": "agenda_task",
  "version": 1,
  "title": "Renew passport",
  "notes": "",
  "due": "2026-12-01",
  "due_time": "",
  "tz": "",
  "rrule": "",
  "done_at": "",
  "note_uuid": "",
  "reminder": null,
  "created_at": "2026-11-14T10:00:00.000Z",
  "updated_at": "2026-11-14T10:00:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `version` | Schema version, same convention as `agenda_event` (`agenda.js` `defaultEvent()`). |
| `due` | `YYYY-MM-DD` local date. Required. A task with no date is not an agenda task (it stays a checklist in a note). |
| `due_time` | `HH:mm` or empty (all-day). |
| `rrule` | Empty or recurrence, same expander as events. Completing one occurrence stores `done_at` per occurrence in `done_occurrences` (array of `due` dates), not a single `done_at`. |
| `done_at` | ISO UTC instant, empty = open. Non-recurring only. |
| `note_uuid` | Optional link to a note (the ID-based link format of `docs/NOTES_ORGANIZATION_SPEC.md`). A dead link is shown as dead, not an error. |
| `reminder` | Same object as 2.1 or `null`. |

A checklist item inside a note body is **not** migrated into a task. Making one
a dated task is an explicit user action ("Add to agenda"); the task then holds
`note_uuid`.

### 2.3 Versioning and backwards compatibility

Rules, in order of importance:

1. **Additive only.** A new field never changes the meaning of an existing one.
   A breaking change gets a new `type` (like `agenda_task`) or a higher
   `reminder.v` / `version`.
2. **Old clients, `reminder` on a note.** The field is simply unknown. Old notes
   code spreads `...item.content` in most update paths (`store.js` ~3479, ~5720,
   ~5753), so it survives. Implementation must add a test that edits, trashes,
   restores and re-syncs a note with a `reminder` through the oldest supported
   edit paths, and that any path that rebuilds `content` field by field (check
   `store.js` ~1048 and the editor save in `app.js`) copies unknown keys. Where
   one does not, fix it in the same change; it is a data-loss bug.
3. **Old clients, `agenda_task` items.** Ignored by the agenda
   (`type !== 'agenda_event'`), absent from the note list (`type !== 'note'`),
   but still synced, rollback-tracked and re-encrypted untouched. They are never
   deleted by an old client. They are invisible there; the Settings > About
   "newer data" notice (as `settings-sync.js` does for `v > SCHEMA_V`) is shown
   when a client sees an `agenda_task` whose `version` it does not know.
4. **New client, newer `v`.** If `reminder.v` or `version` is greater than the
   client knows: show the item read-only, never schedule it, never rewrite it,
   and show "Update Deeperguard to edit this reminder." Same pattern as
   `settings-sync.js` (`rec.v > SCHEMA_V` returns `newer: true`).
5. **New client, missing or malformed fields.** Missing `v` = `1`. A malformed
   `at` or `due` disables the reminder and keeps the data. Never throw in a
   render path.
6. **Merge.** Items sync as one ciphertext, last writer wins per item (existing
   behaviour). `fired_at` and `dismissed_at` are monotonic: on conflict take the
   later instant, so one device dismissing is not undone by another.
7. **No migration job.** Nothing is rewritten in bulk. Fields appear when the
   user sets them.

## 3. Dated tasks in the agenda

Source: `agenda_task` items, listed by a new `listAgendaTasks()` next to
`listAgendaEvents()` in `store.js`. Rendering reuses the range and view logic in
`agenda.js` (`rangeForView`, month/week/day/agenda views).

Display:

- **Agenda (list) and day view:** task rows are interleaved with events by due
  time; all-day tasks sit in the all-day strip. Row = checkbox, title,
  due time, note-link icon.
- **Week and month views:** a task is a compact chip with a checkbox glyph and a
  hollow outline (events are filled), so tasks and events differ by shape, not by
  colour alone. A day with more items than fit shows the existing "+N" overflow.
- **Overdue:** open tasks with a past `due` appear once, on **today**, in an
  "Overdue" group at the top, labelled with their original date. They are not
  repeated on past days (no stacked pile of red).
- **Done:** done tasks are struck through, dimmed to meet 4.5:1 contrast, and
  hidden after 7 days unless "Show completed" is on. Un-checking restores them.
- A toggle "Show tasks" (default on) lives with the other calendar settings and
  is stored in the synced settings (`settings-sync.js`), not in clear storage
  of times.

Completing:

- Checkbox click, `Space` on a focused checkbox, or `x` while the row is
  focused. Sets `done_at` (or adds the date to `done_occurrences` for repeats);
  a toast "Task done. Undo" for 6 seconds reverts it.
- Completing a task also clears its pending local reminder and, if it has a
  server reminder, queues the cancel through the existing `cancelNoteReminder`
  style op.

Keyboard:

- Rows are in the existing roving-focus order of the agenda
  (`agenda.js` ~2477). `Enter` opens the detail card, `Space` toggles done,
  `Escape` closes and returns focus to the originating row
  (`handleEscapeKey`, ~2688). `n` then `t` in the agenda creates a task for the
  selected day. Dialogs reuse `trapDialogTab` (~2849).
- All actions are also available as visible buttons; no gesture-only action.

Screen reader:

- A task row is `role="listitem"`; the checkbox is a native
  `<input type="checkbox">` with a visible label, not an ARIA imitation. Its
  accessible name is `"{title}, due {date} {time}"`; an overdue task adds
  `"overdue"`. State is announced by the native checked state.
- Completion and undo are announced through the existing polite live region
  (`aria-live="polite"`): "Task done: {title}. Undo available." Reminder alerts
  use `role="alert"` only for a reminder that fires while the app is focused.
- Chips in month view carry the same accessible name; the shape difference is
  never the only cue (name says "task").
- `prefers-reduced-motion` disables the strike-through animation. Focus rings
  and hit targets follow the rules in `docs/AGENDA_PWA_VISUAL_AUDIT.md`
  (44 px minimum on touch).

## 4. Local reminders

"Local" means: the reminder is decrypted, scheduled and shown by this browser
tab/PWA while the vault is **unlocked**. Nothing else.

When they fire:

- Only while the app is open (a tab or an installed PWA window) **and** the vault
  is unlocked. After unlock and after sync, the client builds a schedule from
  decrypted items: every `reminder` on non-trashed notes and open tasks whose
  next occurrence is within the next 24 hours.
- Scheduling is `setTimeout` per reminder, held in memory only. A browser clamps
  a delay above 2^31-1 ms and throttles background timers, so one timer re-plans
  every 15 minutes and on `visibilitychange`, and fires `setTimeout` only for
  items due before the next re-plan. Timer lateness up to one minute is
  accepted.
- Display: if `Notification.permission === 'granted'` and the page is hidden, an
  OS notification (`new Notification` from the page; no service worker `push`
  involved). If the page is visible, an in-app banner with the same text instead,
  so the user is not notified twice.
- **Permission is requested only after an explicit user action**: the first time
  the user turns on "Local reminders", with our own explanation shown *before* the
  browser prompt (text in section 8). Never on load. If the answer is "denied",
  reminders still show as in-app banners and missed-reminder lists; the toggle
  shows how to re-enable it in browser settings.
- Notification content: by default **generic** ("You have a reminder"), because
  OS notification centres and lock screens are outside our control. A setting
  "Show note title in notifications" (default off) puts the title in.
  The body never contains note text. The `tag` is a random per-run value, not the
  item uuid, so a notification does not leak ids to the OS history.
- Clicking a notification focuses the app and opens the item. If the vault is
  locked at that moment the unlock screen is shown first and the target is kept
  in memory only (not in the URL, not in storage).

Missed reminders:

- On unlock/open the client compares each reminder's next due instant with
  `fired_at`/`dismissed_at`. Everything due since the last time it was shown on
  this device, up to 14 days back, is collected.
- They are shown once, in one panel "Missed while Deeperguard was closed":
  title, original time ("Tue 09:30"), buttons **Open**, **Snooze** (10 min /
  1 hour / tomorrow 09:00), **Dismiss**, and a **Dismiss all**. No OS
  notification is created for missed ones (they would arrive late and wrong).
- The panel is a dialog reachable by keyboard, announced with
  `role="dialog"` + `aria-labelledby`, with focus trapped and returned on close.
- A repeating reminder that was missed several times is shown **once** with the
  count ("missed 3 times"), then continues from the next future occurrence.
- Showing, snoozing or dismissing updates `fired_at` / `snoozed_until` /
  `dismissed_at` in the encrypted item, which syncs; other devices then do not
  show the same missed reminder again.

Locked vault:

- All timers are cleared in the same place that clears decrypted state
  (`lock()`; see `docs/LOCK_SPEC.md`). While locked there is **no** schedule and
  the client cannot know which reminder is due, because it cannot decrypt.
- Consequently a locked vault never produces a content notification. It produces
  at most **no** notification. We do not store "next reminder at" in clear to
  wake the user, because that is exactly a time leak.
- On the next unlock the missed-reminder panel (above) shows what was due.
- Auto-lock timing is the user's choice; the Settings text in section 8 says
  that locking pauses reminders.

Existing server channels stay available, opt-in and clearly separate: "Notify me
by email or push even when Deeperguard is closed" (Pro for agenda events). That
is where time is visible to the server, which section 8 states.

## 5. Quick capture: global shortcut

- A single in-app shortcut: `Ctrl/Cmd + Shift + K` (not `Ctrl+N`, which the
  browser keeps) opens the **Quick capture** sheet from anywhere in the app,
  including the agenda. It is listed in the keyboard help, can be rebound, and
  does nothing while an IME composition or another dialog is open.
- The sheet has one text field, a type switch (Note / Task), optional due date
  and reminder, **Save** and **Cancel**. `Ctrl/Cmd+Enter` saves. Saving creates
  an item exactly like a normal one (encrypted in the client, queued, synced).
- "Global" is limited by the platform: a web page cannot capture keys while it
  is not focused, and a PWA cannot register an OS-wide hotkey. The text says
  "while Deeperguard is open" (section 8). The manifest `shortcuts` entry
  `/app?action=capture` (new, next to `new` and `search`) gives a launcher
  entry on desktop and Android; it opens the same sheet.
- If the vault is locked, the sheet is not shown; the unlock screen is.
  `?action=capture` is remembered in memory across unlock only.

## 6. Quick capture: Web Share Target (Android / Chromium only)

Manifest addition (`app/static/manifest.json`):

```json
"share_target": {
  "action": "/app/share-target",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```

Support: Chromium on Android (installed PWA), and recent desktop Chromium.
Not supported on iOS/Safari, and Firefox ignores `share_target`. There the entry
simply does not appear; nothing breaks (section 8).

Flow, designed so that **nothing readable is ever stored**:

1. The OS posts the share to `/app/share-target`. The service worker's new
   `fetch` handler (`sw.js`, `request.method === 'POST'` for this exact path)
   intercepts it. The request never reaches the server: the handler answers
   itself, so shared text is not in server logs.
2. The handler reads `title`, `text`, `url` (bounded: 64 KiB total; longer is
   truncated with a visible marker), keeps them **in worker memory only**, and
   responds with a `303` redirect to `/app?action=share`. It does not use Cache
   Storage, IndexedDB, `localStorage`, or the URL for the content.
3. The app page asks the worker for the pending share with a one-shot
   `postMessage` / `MessageChannel`; the worker returns it and **deletes** it.
   If nobody asks within 2 minutes, the worker drops it.
4. If the vault is **unlocked**, the client opens the Quick capture sheet
   prefilled (text, title, url as a link line), the user picks Note or Task, and
   **Save** encrypts it with the vault key in the client like any item. Cancel
   discards it.
5. If the vault is **locked**, the shared content stays only in memory (worker
   or the page's JS heap). The unlock screen says "Shared content is waiting.
   Unlock to save it." After unlock the sheet opens. If the user closes the tab,
   the worker is stopped by the browser, or 2 minutes pass, the content is gone;
   the next share must be redone. This is intentional: persistence would require
   writing it unencrypted, or encrypting it with a key we do not have.
6. Files in a share (`files` param) are **not** accepted in v1; the manifest does
   not declare them.

Why not encrypt it at share time with a stored key: the vault key is not
available while locked and must not be written anywhere for this. A separate
"inbox key" would mean a second secret in browser storage and a second
decryption path to audit; rejected for v1. An opt-in design with a public-key
"inbox" (encrypt to a key stored in clear, decrypt after unlock) is possible
later, and must go through its own threat review.

Security of the handler: the POST is cross-origin-capable by design (any app can
share to us), so the handler only stores into memory, never acts on content,
rejects other methods and paths, and the sheet shows the content as text and
requires a user click to save. CSP stays as in `app.html`; the shared `url` is
not fetched or previewed automatically.

## 7. Why a widget is not possible in a PWA

- A home-screen or lock-screen widget is a native OS surface. Android widgets
  are `AppWidgetProvider` components in an APK; iOS widgets are WidgetKit
  extensions. Neither platform lets a web app or PWA register one. There is no
  web API for it (the W3C PWA Widgets proposal is Microsoft-only, for Windows
  Widgets, and is not available in the browsers we target).
- Even if a widget existed, it would have to render notes, tasks or counts while
  the vault is locked. It cannot decrypt, so it would either show nothing or
  need readable data (an unencrypted snapshot) outside the vault, which breaks
  the threat model (section 9). A widget "to add a note" is just a launcher
  shortcut, which we already give: manifest `shortcuts` and, per section 5,
  `?action=capture`.
- Therefore: no widget in the PWA. Users can pin the app and use the shortcuts.
  A native wrapper could one day offer an add-only widget; that is out of scope
  here.

## 8. Exact user-facing text

These strings are normative. Use them as written (English, sentence case, no
trailing period unless shown). Place them where stated.

**Local reminders, before the browser permission prompt** (dialog, buttons
"Turn on" / "Not now"):

> Reminders only work while Deeperguard is open and unlocked.
> They stay on your devices: we never learn what or when. If you close the app or lock your vault, you will not be notified. Missed reminders are shown the next time you unlock.

**Settings > Reminders, permanent note under the toggle:**

> Local reminders are checked only while Deeperguard is open and your vault is unlocked. They are private: the time and text are encrypted and never sent to our server.

**iOS / Safari limitation** (shown in the same place whenever the browser is
Safari or iOS, and in the install help):

> On iPhone and iPad, reminders can be missed. iOS does not let web apps run in the background, so a reminder only appears if Deeperguard is open and unlocked. Notifications also need the app added to your Home Screen. Sharing to Deeperguard from other apps is not available on iOS.

**Closed-app limitation** (all platforms, next to the toggle and in the
missed-reminder panel footer):

> If Deeperguard is closed, nothing can remind you. Open it and we will show what you missed. To be notified while it is closed, you can turn on email or push reminders, but then our server learns when the reminder is due (never what it is about).

**Server reminders (existing channels), label above the control:**

> Email and push reminders: our server learns the time of the reminder, and for notes the note's ID. It never sees the text.

**Locked vault, in the unlock screen, when reminders exist or a share waits:**

> Your vault is locked, so reminders are paused. Unlock to see anything you missed.

> Shared content is waiting. Unlock to save it. It is kept only in memory and is discarded if you close this page.

**Quick capture sheet, hint under the field:**

> Saved encrypted on this device, then synced. Shortcut works while Deeperguard is open.

**Share target unsupported (install help, shown on iOS/Firefox/desktop Safari):**

> Sharing to Deeperguard works on Android with Chrome or another Chromium browser, after you install the app.

**Notification permission denied:**

> Notifications are blocked in your browser settings. Reminders will appear inside Deeperguard when it is open.

**Generic OS notification:** title `Deeperguard`, body `You have a reminder`.

**Newer-version item:**

> Update Deeperguard to edit this reminder.

## 9. Threat model

Assets: note and task text, reminder times (they reveal habits, appointments,
health and travel), the vault key.

Adversaries and what each learns:

| Adversary | Local reminders / tasks / share | Server channels (opt-in) |
| --- | --- | --- |
| **Our server, its operators, backups, logs** | Only ciphertext, item uuid, size, update time (as for every item). **No reminder time and no content**: `reminder`, `due`, `done_at`, the share text and the type switch are all inside the ciphertext or never leave the browser. A POSTed share never reaches the server (section 6). | Sees `fire_at`, channel and (agenda) a `HH:mm` label; for notes the item uuid and `warn_at`. Never text. Stated in section 8. |
| **Network observer** | TLS; same as sync. | Push services (FCM, Mozilla, Apple) see that a push happened and its timing, with generic text only. |
| **Someone with the unlocked device** | Can read everything the app can. Out of scope; use lock. | |
| **Someone with the locked device / disk image** | Only ciphertext in IndexedDB. **Nothing readable in browser storage.** Shared content in worker/page memory is lost on close. | `agenda_reminder_pending_v1` in `localStorage` holds `fire_at` in clear (known gap, section 1). |
| **Lock screen / notification centre viewer** | Generic text by default; title only if the user turns it on. | Same. |
| **Malicious site or app sharing to us** | Gets nothing back; content is memory-only and needs a click to save, shown as text. | |
| **Malware / extension in the browser** | Out of scope, as for the rest of the app. | |

Rules that make the first two rows true; tests and review must check them:

1. No reminder/task field name or value appears in a request body, URL, header
   or `console.*` output. A test greps the sync payload builder.
2. No such value in `localStorage`, `sessionStorage`, Cache Storage or an
   unencrypted IndexedDB store. Persisting anything (pending ops, schedule,
   queue) goes through the existing encrypted item/queue path. The in-memory
   schedule is rebuilt on unlock, never persisted.
3. The service worker holds shared content in a JS variable only, with a
   2-minute expiry and delete-on-read, and never writes it to a cache.
4. `lock()` clears all timers and pending share content before it returns.
5. No new server endpoint, column or log field for local reminders or the share
   target. A review that finds one fails the change.
6. Notification `tag` and `data` contain no uuid, title or time.

Accepted residual risks, stated in the product text: timing of existing server
reminders; OS notification history if the user turns on titles; the push
service sees that something was pushed.

## 10. Competitors (what we match, what we do better)

From their public documentation and behaviour; verify before quoting in
marketing.

- **Standard Notes:** no reminders. We offer private local reminders.
- **Notesnook:** reminders on its native apps via OS scheduling, which works
  while closed on mobile but runs through the OS and is not available in the web
  app to the same extent. We match with local reminders and are explicit about
  the limit; our optional server channel is the closed-app answer, with its
  cost stated.
- **Joplin:** to-do alerts in desktop/mobile apps; no calendar integration. We
  match with tasks in the agenda.
- **Proton Calendar / Tasks:** server-side notifications. We keep time off the
  server by default.
- Look and feel: tasks reuse the agenda design (`docs/AGENDA_PWA_VISUAL_AUDIT.md`),
  one capture sheet for keyboard, launcher and share, undo instead of confirm
  dialogs, and plain-language limits instead of hidden failures.

## 11. Acceptance for the implementation (tests to write)

- Round-trip: `reminder` and `agenda_task` encrypt/decrypt with unknown extra keys
  preserved through note edit, trash, restore, sync, and the lock/unlock cycle.
- Old client simulation: a build that only knows `agenda_event` and `note` still
  syncs a vault containing `agenda_task` and notes with `reminder`, and does not
  drop, rewrite or crash on them.
- `v` greater than known: read-only, not scheduled, not rewritten.
- Timer: fires once, not after lock, not twice across two tabs (use `fired_at`
  and a `BroadcastChannel` single-leader), re-plans on `visibilitychange`.
- Missed panel: ordering, repeat collapse, snooze, dismiss-all, keyboard and
  screen-reader roles.
- Share target: POST handled by the worker, no network request, no storage write,
  2-minute expiry, locked-vault path keeps memory only, 64 KiB bound.
- No-leak test: a recorded sync/API trace for a vault with reminders contains no
  time, title or text; storage snapshot has none.
- Text test: the strings in section 8 appear verbatim in `app.html` /
  `app.js`.
- Rebuild the client manifest (`scripts/build-client-manifest.py`) after any
  change under `app/static`.
