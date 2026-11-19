# Settings export buttons "covered by something else" (idea #223)

Beta runs 232 and 242 (code ef4e79c) logged `Locator.click: Timeout 6000ms exceeded` with
"covered by something else" on 'Export current note', 'Export everything readable (ZIP)'
and 'How to get this'. After PageDown or Escape a click sometimes worked.

## Result: not an app bug, no app code changed

The export buttons, the ZIP contents and the recovery key step are untouched.

## What was tried

Playwright (Chromium), fresh account, recovery key step completed, Settings opened. For
each of the three buttons `document.elementFromPoint` at the button's centre was compared
with the button, then the buttons were clicked without `force`:

- at 1440x900, 1280x720 and 390x844 (phone, Settings opened from the header button);
- at rest, after a 'How to get this' click, after an 'Export current note' click (with its
  toast on screen), and after a finished ZIP export;
- with each button scrolled to the top, centre and bottom edge of the viewport while a
  toast was showing (the toast is `position: fixed`, z-index 100, bottom centre).

In all of these the button itself was the topmost element and the click worked.

## What covers the buttons

Clicking 'Export everything readable (ZIP)' opens the password dialog
(`#confirm-dialog`) on purpose. While it is open, `div#confirm-backdrop.settings-backdrop`
sits over the whole Settings sheet (on a phone the dialog sheet covers the lower buttons
too). A script that clicks the ZIP button and then clicks 'How to get this' or the other
export button without answering the dialog gets exactly Playwright's message: the
`#confirm-backdrop` "intercepts pointer events". A wrong password keeps the dialog open
(error "Wrong password. Nothing was exported."), which looks the same to a script.
Escape (or Cancel) closes the dialog and the backdrop; that matches "after Escape it
sometimes worked". This is the intended modal, so the layout and z-index were left alone.

The beta log does not name the covering element itself; the identification above comes from
reproducing the same error message with the dialog left open. If the tester sees it with no
dialog open, send the `elementFromPoint` result.

## Regression test

`tests/e2e_settings_export_click.py` checks that each button is the topmost element at
its centre, clicks it without `force`, repeats this after help/export clicks and after
cancelling the ZIP dialog with Escape, and asserts that the dialog's backdrop (or sheet)
is what covers the buttons while it is open and is gone afterwards. When a click
times out, the test reports the covering element (`elementFromPoint`) in its failure message.
