# Release notes

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
