# Release notes

## Unreleased

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
