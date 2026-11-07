# PWA / Agenda visual audit (agent run, Nov 2026)

This document records **what was exercised on the agent worker** vs **not emulated**. It is **not** a substitute for human QA on physical iPhones.

## Tested on worker (bounded)

| Area | What we checked | Evidence |
|------|-----------------|----------|
| Agenda — Calendar menu | Text button “Calendar menu”; labelled sheet “Calendar settings”; Import/Export copy | Code + HTML in PR; no screenshots attached in-repo |
| Agenda — timed grid scroll | Initial scroll to ~1h before earliest timed event (or 08:00 fallback); `sessionStorage` preserves position per period | Logic in `agenda.js` |
| Agenda — iOS swipe | Horizontal swipe on `.agenda-week-layout` navigates prev/next period; vertical gesture cancels | Logic in `agenda.js` |
| ICS export | Client-only blob download; escaping/folding; roundtrip test | `tests/test_agenda_ics_export_roundtrip.js` |
| SW / stale shell | Hint in Calendar settings: reload after update | `app/templates/app.html` |

## Not tested (explicit)

- Physical iPhone hardware, iOS Safari quirks, share sheet, or Home Screen icon behavior beyond code paths.
- Full Notes / 2FA / Files / Security / Settings flows in this pass — **only Agenda-focused changes** landed here.
- Automated screenshots were **not** written to the repository (no binary artifacts in this PR).

## Remaining audit work (follow-up)

- Broader viewport matrix (e.g. 390×844, 428×926, iPad width) with screenshot harness under `/opt/cursor/artifacts/` if product wants archival proof.
- Keyboard-only navigation through Calendar settings and event editor.
- Dark/light regression snapshots outside Agenda.
