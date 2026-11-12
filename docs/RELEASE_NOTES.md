# Release notes

## Unreleased

- **Agenda: the "now" line keeps moving.** The red line in Day/Week view moves every minute while the Agenda is open, and "today" switches at midnight (the view re-renders unless the event editor is open). Nothing runs while the tab is hidden; coming back catches up at once.
- **Agenda: no more silently lost edits.** Closing the event editor with Cancel, a click outside it, or Escape now asks "You have unsaved changes. Discard them?" when something was changed; an untouched editor closes straight away.
- **Agenda: undo after delete.** Deleting an event or a single occurrence shows "Event deleted" / "Occurrence deleted" with an **Undo** button (about 6 seconds). Undo brings back the event with its repeat, exceptions and reminders.
- **Agenda export: repeating events keep their hour.** Repeating timed events (and edited occurrences of them) are exported as local time with a time zone (`TZID` + `VTIMEZONE`) instead of UTC, so "every Monday 09:00" stays 09:00 in Google, Apple or Outlook calendars after the clock changes. One-off events stay in UTC. The zone is the one of the device that exports; the clock-change rules in the file follow today's rules for that zone.
- **Agenda import: time zones.** Invites with a `TZID` (e.g. 09:00 New York) are now placed at the right time on your device (15:00 in Amsterdam) instead of at 09:00 local. Outlook/Exchange zone names (e.g. "W. Europe Standard Time") are recognised; an unknown zone falls back to local time with a warning. Cancelled (`EXDATE`) and moved (`RECURRENCE-ID`) occurrences with a time zone now match their series. Known limit: a repeating series from another zone keeps the local time of its first occurrence, so during the weeks when that zone and yours change clocks on different dates it shows one hour off.
- **Agenda sync: no more lost changes between devices.** All events are stored in one encrypted item; when two devices changed the calendar before syncing, the newest copy used to replace the other, so an event added on one device could disappear. A sync conflict now merges event by event: additions from both sides are kept, the newer edit of the same event wins, and a delete stays deleted (remembered for 60 days) unless the event was edited after it. Reminder bookkeeping no longer counts as an edit.
- **Agenda (phone layout, list view, repeat options, interactions — #345–#348 plus review fixes):**
  - Phone header with previous/next, Today and an overflow menu; month dots with a day list; **List** view grouped by day, with multi-day events under every day they cover.
  - Repeat patterns: daily, weekly, every 2 weeks, monthly, yearly. Imported weekly `BYDAY` lists and monthly nth-weekday rules (`2TU`, `-1FR`) are shown correctly; rules the app cannot expand show their first date only and say so.
  - **Date fixes:** repeating events keep their local time across clock changes; the month grid no longer repeats a day in the week the clocks go back; monthly on the 31st and yearly on 29 February clip per period instead of drifting; all-day series repeat; long-running daily series stay visible.
  - Event detail card (date, repeat, location, **Join meeting**), named colour picker with an automatic default, in-app delete confirmation, empty title for new events starting on the day in view.
  - Search keeps focus while typing; Agenda dates use one day-first format.
- **Agenda reminders (#349 plus review fixes):** per-event email reminders (push when enabled later). The server stores only an opaque id, the fire time, the channel and an optional `HH:MM` label.
  - Reminders follow the calendar exactly (interval, end date, deleted and moved occurrences) and are planned 60 days ahead, topped up when the app opens; failed updates are retried.
  - Delivery: reminders more than 30 minutes late are closed unsent (`NOTES_AGENDA_REMINDER_MAX_LATE_SEC`); undeliverable ones never block the queue; email needs a verified address; push endpoints are limited to browser push services.
  - **Ops:** schedule `app/agenda_reminder_cron.py` (every minute) for email delivery. Do not add VAPID keys until push is enabled.
  - Reminders are Pro-only: moving an account to a plan without reminders deletes its scheduled reminders, and the cron never sends for such an account. Back on Pro, the app schedules them again the next time the Agenda opens.
## v0.65.52 (Vienna)

- **Ops #334:** After any server `notes.db` restore, operators can revoke all live sessions (`deploy/revoke-all-sessions-after-restore.{sh,py}`) so pre-restore cookies cannot authenticate; runbook in `deploy/PRODUCTION.md`.

## v0.65.51 (Vienna)

- **Sync #330:** Safe upload retries via `sync_retry_key` / request hash — identical retries are idempotent; hash mismatch returns `retry_conflict` without clobbering newer server data. Reuses wrapped ciphertext on the same dirty cycle; rotates retry key after conflict. Localized blocked-sync toasts (EN/NL) with note title for `retry_conflict`.

## v0.65.50 (Vienna)

- **Ask AI #331:** Structured send consent — destination consent recorded; cloud relay warnings and ack only for Ollama Cloud; relay-only storage copy (EN/NL).

## v0.65.49 (Vienna)

- **Sign-up #327:** Register hang UX — reassurance copy at 6s/20s, Retry without aborting SRP (180s client timeout), late success honored once, Turnstile refresh on retry, soft-fail anti-enumeration with optional sign-in link after retry (sessionStorage email prefill).

## v0.65.48 (Vienna)

- **Sync #326:** While the vault is locked, change-poll checks the server watermark before pulling; locked incremental pulls send `known_hashes` from stored ciphertext (cuts repeated full-page downloads).
- **Blog (draft only on main):** Staged draft posts for zero-knowledge basics (#324) and encrypted email backups (#325) — not listed on `/blog` until published.

## v0.65.47 (Vienna)

- **Agenda #320:** Center the earliest visible timed event in the time-grid viewport on new/changed schedules; period navigation via horizontal touch/pointer/wheel across Day, 3-day, Week, Month, and List views (vertical scroll preserved); ICS export plaintext warning unchanged.

## v0.65.46 (Vienna)

- **Agenda chrome & ICS (#318):** Import ICS lives in a **Calendar** settings sheet (opened from the calendar icon in the Agenda header). The main toolbar is slimmer, the calendar body uses more viewport height, and week/month headers stay sticky with improved narrow-width layout.

## v0.65.45 (Vienna)

- **Agenda month grid (#315):** `rangeForView` now extends the month grid through the week when the last day of the month is Monday (e.g. November 2026 includes Mon Nov 30). `gridEndWeekExclusive` uses `addDays(startOfWeekMonday(last), 7)`.
