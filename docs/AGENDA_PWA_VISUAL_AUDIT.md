# PWA / Agenda visual audit (agent run, Nov 2026)

This document records **what was exercised on the agent worker** vs **not emulated**. It is **not** a substitute for human QA on physical iPhones.

## Tested on worker (bounded)

| Area | What we checked | Evidence |
|------|-----------------|----------|
| Agenda — Calendar menu | Text button “Calendar menu”; labelled sheet “Calendar settings”; Import/Export copy | Code + HTML in PR; no screenshots attached in-repo |
| Agenda — timed grid scroll | **v0.65.47:** earliest visible timed event **centered** in `.agenda-scroll-wrap`; fingerprint/session restore unchanged; search does not jump scroll | `agenda-scroll-core.js`, `tests/test_agenda_scroll_core.js`, `tests/run_agenda_browser_checks.py` |
| Agenda — period pan | **v0.65.47:** horizontal touch/pointer/wheel on `#agenda-pane` for Day/3-day/Week/Month/List; vertical scroll preserved | `agenda.js`, local Playwright @ 390/428/1280 |
| ICS export | Client-only blob download; UTF-8 folding; timed **UTC Z**; all-day local DATE; attendees in DESCRIPTION roundtrip | `tests/test_agenda_ics_export_roundtrip.js`, `tests/test_agenda_ics_timezone.js`, `tests/test_agenda_scroll_logic.js`, `tests/test_agenda_scroll_session.js` |
| SW / stale shell | Hint in Calendar settings: reload after update | `app/templates/app.html` |

## Not tested (explicit)

- Physical iPhone hardware, iOS Safari quirks, share sheet, or Home Screen icon behavior beyond code paths.
- Full Notes / 2FA / Files / Security / Settings flows in this pass — **only Agenda-focused changes** landed here.
- Automated screenshots were **not** written to the repository (no binary artifacts in this PR).

## Remaining audit work (follow-up)

- Broader viewport matrix (e.g. 390×844, 428×926, iPad width) with screenshot harness under `/opt/cursor/artifacts/` if product wants archival proof.
- Keyboard-only navigation through Calendar settings and event editor.
- Dark/light regression snapshots outside Agenda.
