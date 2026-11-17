# Beta findings

## Sidebar pin: 'Rename folder' click times out right after #btn-nav-pin (idea #197)

Not an app fault, no app code changed. In Chromium the pin click is not followed by any click-blocking animation or overlay: the state flips in the click handler and the sidebar has no transition on desktop. The folder actions (rename, add, delete) are `opacity: 0; pointer-events: none` until the folder row is hovered (`app.css`, `.folder-head-actions`), so a click on the pencil without a pointer over the row is intercepted by the `button.folder-select` (the folder name) beneath it. That is the 'covered by something else' message, and it also happens long after the pin click, when expanding and when collapsing. A real pointer moves over the row first and works at once; the test hovers the row, then clicks (`tests/e2e_sidebar_pin_click.py`, no sleeps, 1000 ms timeouts, expand and collapse).

Side observation: in that test the first Escape after creating a folder did not close the rename field; a second one did. Looked into: this is not a focus problem. The document-level Escape handler closes the open Filter section first and stops the event, so the field never sees it. Follow-up: `docs/bugs/escape-filter-before-rename-field.md`.
