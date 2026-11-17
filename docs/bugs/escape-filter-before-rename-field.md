# Escape collapses the Filter panel instead of the open folder rename field (follow-up to idea #197)

## Status: open, not fixed

Found while reviewing `tests/e2e_sidebar_pin_click.py` (review follow-up for task 257).
Split out of `docs/BETA_FINDINGS.md`, where it was listed as "not looked into".

## Reproduction

Desktop, Notes, sidebar pinned, Filter section open (its default), no note open:

1. Create a folder, click its rename pencil (the field `.folder-rename-input` opens and has focus).
2. Press Escape once: the field stays open, the Filter section closes.
3. Press Escape again: the field closes.

With the Filter section already closed, one Escape closes the field. Verified in Chromium
with `tests/e2e_layout_actions.py` helpers (probe, not committed).

## Cause

It is not a focus problem: after the first Escape `document.activeElement` is still the
rename input. The Escape is taken by the document-level keydown listener in
`app/static/js/app.js` (capture phase, `filterSection?.open` branch, about line 26933).
That listener runs before the field's own keydown handler (`beginRenameFolder`,
`app/static/js/app.js:9735`), calls `stopPropagation()`, and collapses `#filter-section`.
The field never sees the event.

Other branches of the same listener check for focus first (`ui.search`, `tagInput`).
The Filter-section branch does not, so an Escape pressed in any focused text field in
the sidebar can close the Filter section instead of that field.

## Expected

Escape in an open text field (the rename field) cancels that field first. Only when no
field of its own handles Escape should it fall through to the panel-closing branches.

## Notes

- The E2E test no longer presses Escape to leave the field (it uses Enter, which keeps the name).
  An Escape test for the rename field must be added with the fix.
- Fix not part of task 257; no app code changed there.
