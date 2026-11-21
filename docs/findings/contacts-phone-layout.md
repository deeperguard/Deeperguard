# Contacts list on phones: measured before and after the compact header

Task #507 (PR #975, commit `e3ad1cd`) made the Contacts header and toolbar
compact on phones. This page records the before and after measurements for the
PR. The orchestrator writes the PR description itself, so the measurements are
kept here.

## Results

Measured on 2026-11-21 in headless Chromium with touch enabled. Each run used a
new account with 36 contacts, 8 of them favourites, on the Contacts tab
scrolled to the top.

- "Before" is commit `4abd9bb`, the parent of `e3ad1cd`.
- "After" is the code on `main` at `2dafd1f`.

| Viewport | First row top, before -> after | Fully visible rows, before -> after |
| --- | --- | --- |
| 390x844 | 405.4 px -> 220 px | 7 -> 10 |
| 360x740 | 405.4 px -> 220 px | 5 -> 9 |

"First row top" is `getBoundingClientRect().top` of the first
`#contacts-list .contacts-row`. "Fully visible rows" counts the rows that lie
entirely inside the viewport (`top >= 0` and `bottom <= window.innerHeight`). Both use
the same `LIST_METRICS` measurement as `tests/e2e_contacts_phone_layout.py:33`.
The `BEFORE` values in that test (`tests/e2e_contacts_phone_layout.py:23`) are
these "before" numbers.

## How to repeat

1. Extract commit `4abd9bb` into its own folder, for example with
   `git archive 4abd9bb`.
2. Against that folder's server, run the `SEED` and `LIST_METRICS` steps of
   `tests/e2e_contacts_phone_layout.py` after
   registering, at both viewports.
3. The "after" numbers come from the same test, which prints them:
   `python tests/e2e_contacts_phone_layout.py`.
