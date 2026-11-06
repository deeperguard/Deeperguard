# Release notes

## v0.65.46 (Vienna)

- **Agenda chrome & ICS (#318):** Import ICS lives in a **Calendar** settings sheet (opened from the calendar icon in the Agenda header). The main toolbar is slimmer, the calendar body uses more viewport height, and week/month headers stay sticky with improved narrow-width layout.

## v0.65.45 (Vienna)

- **Agenda month grid (#315):** `rangeForView` now extends the month grid through the week when the last day of the month is Monday (e.g. November 2026 includes Mon Nov 30). `gridEndWeekExclusive` uses `addDays(startOfWeekMonday(last), 7)`.
