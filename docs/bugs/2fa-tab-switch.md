# 2FA tab does not switch after unlock (idea #116)

## Outcome: NOT reproduced

Beta-tester report (run 62, code 36abfe5): after unlocking, a click on
`button#app-tab-2fa` leaves the notes list on screen; "Not now", repeated
clicks, reload and unlock again do not help.

`tests/e2e_totp_tab_reload_unlock.py` (wrapper: `tests/test_e2e_totp_tab_reload_unlock.py`)
drives a real Chromium against a fresh app instance on current `main`
(Pro plan, via `NOTES_DEFAULT_PLAN`):

1. Register (lands unlocked), real click on 2FA -> pane visible, notes list hidden.
2. Dismiss the "Not now" prompt (`#btn-device-phrase-prompt-dismiss`), click 2FA again -> same.
3. Reload, unlock with the password, click 2FA -> same.

All three checks pass, so the test is a normal passing regression test (not xfail).
No failing step was observed, so the step where it goes wrong for the tester is unknown.
The test did not exercise the Web Push prompt (out of scope here).

## How tabs switch

`setAppTab()` in `app/static/js/app.js:4513` sets `#app[data-app-tab]`, hides
`ui.shell` (the notes view) and shows `#totp-pane` (`app.js:4522-4526`).

## Suspected cause (not verified)

`app/static/js/app.js:4515-4518`: when the plan lacks `vault_authenticator`,
`setAppTab('2fa')` shows the toast "Vault authenticator is included with Pro" and
**returns before changing anything**, so the notes list stays. On a non-Pro account
every 2FA click (and every reload plus unlock) would look exactly like the report,
with no script error and no failed API call in the log. The tester's plan is
unknown and the test does not run on a non-Pro plan, so this is a hypothesis only.
