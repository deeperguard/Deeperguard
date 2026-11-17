# 2FA tab shows Notes panel after unlock (idea #186)

## Outcome: NOT reproduced (niet gereproduceerd)

Beta-tester report (runs 88, 89, code 2880d52): after unlocking and "Not now",
a click on the 2FA tab leaves the notes list and editor visible, also after a
second click.

Test: `tests/e2e_totp_tab_lock_unlock_not_now.py` (wrapper
`tests/test_e2e_totp_tab_lock_unlock_not_now.py`), real Chromium against a fresh
app instance, Pro plan (`NOTES_DEFAULT_PLAN=pro`). Steps:

1. Register (lands unlocked); the device-phrase card shows; click "Not now".
2. Lock the vault with the header lock button, unlock with the password.
3. Real click on `#app-tab-2fa`, then a second click on it.

The "Not now" card is rendered once, after registering; after a later lock and
unlock it stays hidden (`#device-phrase-prompt[hidden]`), so "Not now" is
clicked before locking. Waits are Playwright auto-waiting assertions, no sleeps.
The test passed on two consecutive runs with identical output.

## Observed DOM (after the first and the second click, identical)

- `#app[data-app-tab]` = `2fa`
- `#totp-pane` visible; `#notes-shell`, `#notes-list` and `#editor-pane` hidden
- `#app-tab-2fa`: `aria-selected="true"`, class `app-tab active`, has focus
- `#app-tab-notes`: `aria-selected="false"`
- Console errors: only the CSP notice "The Content Security Policy directive
  'frame-ancestors' is ignored when delivered via a <meta> element."

## Not covered

Free plan (the click then only shows a toast, see
`docs/bugs/2fa-tab-switch.md`), the real Web Push prompt, a reload between
unlock and click, other browsers. No app code was changed.
