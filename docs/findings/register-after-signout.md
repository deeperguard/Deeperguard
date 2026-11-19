# Register after 'Sign out and create a new account' stays silent

Idea #224 (task #460), reported by the beta tester in runs 241 and 243 at code
`4d4a5b4`. This is diagnosis only. No app code was changed; the repair follows in
a separate task.

## Summary

| Question | Answer |
| --- | --- |
| Reproducible? | **Yes**, when the server has a Turnstile site key (`NOTES_TURNSTILE_SITE_KEY`) and the browser cannot load the Turnstile script. With a working Turnstile script the same steps end in the 'Your recovery key' dialog. |
| Cause | `validateRegisterForm()` reports the missing Turnstile token through a 20 ms timer, and its caller cancels that timer right away. See "Cause" below. |
| Is the sign-out step involved? | No. The silent path is in the form validation. Going by the code it happens on any `/register` page without a Turnstile token; the test only runs the sign-out path from the report. |
| What is `ERR_FAILED`? | `https://challenges.cloudflare.com/turnstile/v0/api.js`, the Turnstile script that `app/templates/register.html:85` loads. When it cannot be fetched, Chromium logs `Failed to load resource: net::ERR_FAILED`. |
| Why no failed API call in the log? | The form never calls the register API: validation stops before `NotesSrpAuth.register()` (`app/static/js/auth-pages.js:1064`). |

## Cause

1. `app/templates/register.html:66` renders `<div class="cf-turnstile">` and
   `register.html:85` loads the Turnstile script from `challenges.cloudflare.com`
   whenever a site key is set. If that script does not load, no
   `cf-turnstile-response` input with a token ever appears.
2. 'Create account' runs `runRegisterAttempt()`, which calls
   `validateRegisterForm()` (`app/static/js/auth-pages.js:1036`). All fields and
   both checkboxes are valid, so it reaches the Turnstile check at
   `auth-pages.js:986-988`: widget present, token empty, so it calls
   `showRegisterError(tCopy('turnstileMissing'))` and returns `null`.
3. `showRegisterError()` does not show the message at once. It schedules it with a
   20 ms `setTimeout` and stores the timer id in `registerHangTimers`
   (`auth-pages.js:859-864`).
4. Back in `runRegisterAttempt()`, `null` leads to `registerRegisterFailureUi()`
   (`auth-pages.js:1037-1038`). Its first step is `clearRegisterHangTimers()`
   (`auth-pages.js:824`), which clears every timer in `registerHangTimers`
   (`auth-pages.js:873`), including the one that would have shown
   "Please complete the security check and try again."

The result: the button goes back to 'Create account', `#register-error` stays
hidden, no request is sent, and every further click repeats the same steps. That
matches the report: the page stays on `/register` with the filled-in form, no
dialog, no message, no failed API call, only `ERR_FAILED` in the console.

The field errors (email, password, checkboxes) are not affected: `setFieldError()`
shows them synchronously.

## Where `ERR_FAILED` comes from

On the register page the only cross-origin request is the Turnstile script
(`register.html:85`). The test aborts it the way a network without access to
Cloudflare does, and Playwright reports
`script https://challenges.cloudflare.com/turnstile/v0/api.js -> net::ERR_FAILED`.
The 'known report' with the same console line is the GitHub release check on
`/verify` (`docs/VERIFY_RELOAD_ERROR.md`); that is a different request. The steps
of the tester that log the line (4, 5 and 16) are most likely the loads of
`/register`; the run logs themselves were not available for this task.

## Why the smoke test does not see it

The existing register tests (`tests/e2e_signup_autounlock.py:157-169`, and the
same snippet in `e2e_auth_screens.py`, `e2e_share_target.py`,
`e2e_layout_actions.py` and other e2e files) remove the `.cf-turnstile` widget and insert a token
themselves, so they never take the path where the Turnstile script is missing.

## Test

`tests/test_e2e_register_after_signout.py` (driver:
`tests/e2e_register_after_signout.py`) starts a temporary local server with the
Turnstile dummy keys and a mocked siteverify, registers a first account, opens
`/register`, clicks 'Sign out and create a new account', fills email, password
and confirmation, ticks both checkboxes, clicks 'Create account' and clicks it
again 1.5 s later. Within 30 s the recovery key dialog or a visible error must
appear. The browser never reaches the internet; every non-local request is
aborted.

- `test_sign_out_then_create_account_shows_recovery_key_dialog`: the Turnstile
  script URL is answered with a small stub that supplies a token. Passes: the
  'Your recovery key' dialog appears. Stays as a regression test.
- `test_sign_out_then_create_account_without_turnstile_shows_error`: the Turnstile
  script is aborted (`net::ERR_FAILED`). Marked `@unittest.expectedFailure`: no
  register API call is made and no message appears within 30 s. It expects
  `#register-error` to show a message; when the repair lands, remove the marker.

Run it alone with `python3 -m unittest tests/test_e2e_register_after_signout.py -v`
(about 90 s), or `python3 tests/e2e_register_after_signout.py` to print the
outcome of both scenarios.
