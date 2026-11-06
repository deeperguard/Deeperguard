# Release notes

## v0.65.45 (Vienna)

- **Agenda month grid (#315):** `rangeForView` now extends the month grid through the week when the last day of the month is Monday (e.g. November 2026 includes Mon Nov 30). `gridEndWeekExclusive` uses `addDays(startOfWeekMonday(last), 7)`.
