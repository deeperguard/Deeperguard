# UI polish: inventory and design token spec

Status: written as a spec (idea #92, task 106); the per-area tasks have since
implemented it. **Section 8 marks every inventory point of section 2 as
resolved or as a deliberate exception.** Follow-up tasks implement it area by area (tokens/buttons/dialogs first, then
notes, agenda, 2FA, sign-in, settings). Every follow-up is visual/wording only:
no change to behaviour, crypto, sync, storage or protected paths, and no new
libraries, fonts or network requests. The look stays recognisable: refinement,
not a redesign.

Sources reviewed: `app/static/css/app.css` (single stylesheet for the app,
~11.5k lines; `app/static/css/marketing.css` is out of scope), and the
templates `app/templates/{app,login,register,verify,totp,receive}.html`.
Line numbers refer to the tree at commit `67c2ea8` and will drift; the
selector/id is the stable reference. Items marked *(to verify)* were read from
CSS/markup only and must be confirmed in a browser (phone + desktop width,
light + dark) by the task that fixes them.

---------------------------------------------------------------------------

## 1. CSS variables that exist today

All in `app/static/css/app.css`.

### 1.1 `:root` (dark is the default theme), lines 2-45

| Group | Variables (dark value) |
|---|---|
| Surface | `--bg #0f1419`, `--bg-elevated #171d24`, `--bg-hover #1f2730`, `--border #2a3440` |
| Text | `--text #e8edf2`, `--muted #8b98a5` |
| Accent / status | `--accent #4f8cff`, `--accent-soft rgba(79,140,255,.15)`, `--danger #ff6b6b`, `--success #3ecf8e`, `--warning #ff9f1c` |
| Sidebar-style | `--sn-search #1f2730`, `--sn-icon-note #4f8cff`, `--sn-icon-util #ff9f1c` |
| Documents | `--doc-surface #111318`, `--doc-viewer-bg #0b0d10`, `--doc-page-bg #fff` |
| Radius | `--radius 12px` (duplicate of `--radius-md`), `--radius-sm 8px`, `--radius-md 12px`, `--radius-lg 16px` |
| Shadow | `--shadow-sm 0 1px 2px rgba(0,0,0,.06)`, `--shadow-md 0 6px 20px rgba(0,0,0,.08)` (these two are *light-theme-sized* values in the dark default) |
| Motion | `--ease-out cubic-bezier(.22,1,.36,1)` |
| Layout | `--sidebar-width 320px` (620px at >=1000px), `--touch 44px`, `--swipe-delete 88px`, `--safe-top/bottom/left/right` (`env(safe-area-inset-*)`) |
| Type | `--font` (system stack), `--note-title-size 16px`, `--note-title-weight 600`, `--note-title-line 1.3`, `--note-title-tracking -0.01em`, `--note-body-size 16px`, `--note-body-line 1.55`, `--note-after-body-gap`, `--note-preview-size` (13px), `--note-meta-size` (12px) |

### 1.2 Light theme overrides (two layers!)

* `html[data-theme="light"]`, lines 47-68: Tailwind-slate palette
  (`--border #e2e8f0`, `--text #0f172a`, `--muted #64748b`, `--accent #2563eb`,
  `--danger #dc2626`, `--success #059669`, `--warning #b45309`, shadows retuned).
* `body[data-theme="light"], html[data-theme="light"]`, lines 7382-7399: an
  iOS-style palette **overrides the first layer** because it comes later
  (`--border #e5e5ea`, `--text #1c1c1e`, `--muted #8e8e93`, `--accent #086dd6`,
  `--danger #d94848`, `--sn-icon-util #e68619`). It does not set `--success`
  or `--warning`, so those still come from the slate layer.
  **The effective light theme is therefore a mix**; the slate values
  `--text`, `--muted`, `--accent`, `--danger`, `--border` are dead.
  Hard-coded slate values (`#e2e8f0`, `#f8fafc`, `#e0f2fe`, ...) are still used in
  `html[data-theme="light"] .auth-page` / `.auth-card` (2157-2179), so sign-in
  looks slate while the app looks iOS.

### 1.3 Layout/sidebar variables (>=1000px, lines 8885-8909)

`--sn-nav-width`, `--sn-list-width`, `--sn-nav-bg`, `--sn-nav-text`,
`--sn-nav-muted`, `--sn-list-bg`, `--sn-editor-bg` (set separately for dark and
light). `--sn-nav-width` is redefined at 9829, 9834, 10143.

### 1.4 Component-scoped variables

`--editor-kb-offset` (3896), `--scan-kb-offset` (5343), `--swatch`
(`.agenda-color-swatch`, per-element), `--touch` is the only spacing-like
token that is actually reused.

### 1.5 Missing today

No spacing scale, no z-index scale (hard-coded 49, 50, 51, 90, 100, 110, 120,
121, 200-220), no type scale, no focus-ring variable, no overlay/backdrop
variable (`rgba(0,0,0,.45)`, `.55`, `rgba(15,20,25,.62)` repeated), no
on-accent / on-danger text variable, no transition-duration variables, no
`color-scheme` declaration *(to verify)*.

---------------------------------------------------------------------------

## 2. Inventory of inconsistencies per area

Format: **problem** (file `selector`, line). Severity tags: **[A]** accessibility,
**[L]** layout/spacing, **[C]** consistency, **[W]** wording/feedback.
All files are `app/static/css/app.css` unless stated.

### 2.1 Cross-cutting (tokens, buttons, forms, focus, contrast)

Radius values hard-coded 222 times as `border-radius: Npx`; values in use
include 6, 8, 10, 12, 14, 16, 18, 20, 999 and 50% (the tokens
`--radius-sm/md/lg` exist but are barely referenced).
Inputs use 10px (`input, textarea, select`, 1934-1942) while buttons use
`--radius-md` 12px (`.btn`, 1947) and settings selects use `padding 8px 10px`
and 14px font (`.settings-row select`, 7042-7049) against the global
`12px 14px` / 16px.

**Buttons**
* `.btn` (1947) defines padding `10px 14px` but **no min-height**; only
  `.btn.block`, `.btn.sm`, `.btn.icon`, `.confirm-dialog-actions .btn`,
  `.scan-dialog-foot .btn` get `--touch`. A bare `.btn` is ~40px tall [A][L].
  `.note-warn-buttons .btn` forces 40px (7669) [A].
* Variants are inconsistent: `.btn.primary`, `.btn.ghost` (transparent bg),
  `.btn.subtle` (transparent + border + hover), `.btn.danger` (outline only),
  `.btn.primary.danger`, `.btn.primary.success`, `.btn.link`, `.btn.sm`,
  `.btn.icon`, `.btn.block` (1956-1986, 5639-5640). `ghost` and `subtle` differ
  by hover only; templates mix them for the same role (e.g. `login.html`
  uses `subtle block` for the passkey and recovery buttons, `ghost block` for
  unlock secondary actions in `app.html` 591-601) [C].
* `.btn.danger` border uses `rgba(255,107,107,.35)` hard-coded dark red, wrong
  in light theme (1970) [C].
* Only `.btn.primary:hover` and `.btn.subtle:hover` have a hover state; plain
  `.btn`, `.ghost`, `.danger` do not. **No `:active`/pressed state anywhere on
  `.btn`** (the exception is `.btn-sync-now:active`, 3366) [A][C].
* Disabled = `opacity .55` (2096). Fine, but `.btn.subtle:disabled` is
  redefined at 2849; `aria-disabled` has no pointer-events guard [C].
* Many one-off buttons duplicate the pattern instead of using `.btn`:
  `.agenda-icon-btn` (754), `.agenda-title-btn` (623), `.agenda-month-more-btn`
  (719), `.agenda-calendar-menu-btn` (1341), `.scan-add-btn` (5448),
  `.section-label-btn` (6080), `.vault-lock-btn` (6785), `.edit-lock-btn` (6832),
  `.note-info-protect-btn` (7715), `.list-density-btn` (7791),
  `.label-menu-btn` (11286), `.receive-download-btn` (2648),
  `.secure-send-file-remove` (2060) [C].
* Icon-only: `.btn.icon` is 44x44 (2083) and good, but `.agenda-color-swatch` is
  28x28 (222), `.password-toggle.btn.sm` is a text button "Show", checklist and
  tag chips are < 44 *(to verify)*. `.btn.icon[aria-label]` gets
  `position: relative` (10421) with no visible tooltip.

**Focus ring**
* Buttons: `.btn:focus-visible` 2px accent, offset 2px (2079). Good baseline.
* Inputs: `input:focus` 2px **`--accent-soft`** outline (1944): in light theme
  that is `rgba(8,109,214,.12)` on white, effectively invisible, only the
  1px border colour changes (contrast 1.3:1 to 5:1 borderline) [A].
* Focus removed without replacement: 503 (`#agenda-editor ... date input`),
  824, 3609, 4614, 6375, 7523 (`.check-text:focus`, bg change only), 7636
  (`.note-warn-field input[type=datetime-local]`), 8665, 8671, 9031, 11329
  (`.label-menu [role=menuitem]:focus-visible`, bg tint only) [A].
* Ring colours/offsets differ: `.agenda-title-btn` offset 3px, `.agenda-color-swatch`
  offset 3px, `.btn` offset 2px, `.settings-row.settings-highlight` uses a
  hard-coded `#4f8cff` fallback (4020) [C].

**Forms**
* Labels: `.auth-card label` is a 14px/500/`--muted` grid with 6px gap
  (2180); `.settings-row` labels are 15px/`--text` flex rows; agenda uses
  `.agenda-sheet-label`, dialogs use `.template-dialog-field`; modal forms
  use plain `<label>`. Four label looks for the same thing [C].
* Error text: `.field-error` (13px, `margin:-4px 0 0`, 2188), `.error` (13px,
  2106-2107), `.settings-hint.error` (7054), `.agenda-*` inline errors. Only
  `register.html` wires `aria-invalid` + `aria-describedby` + `role=alert`
  per field; `login.html` has a single `#login-error` `role=alert`;
  `#password-change-error` (`app.html` 1920) has **no `role=alert`** [A][W].
* Required marker: `aria-required` is set but no visible required marker or
  legend anywhere [W].
* Selects: custom chevron via gradient (1943) `padding-right:32px`; settings
  override padding. Date/time inputs have bespoke wrappers
  (`.agenda-editor-datetime-field`, 466) [C].
* Checkboxes: `.checkbox`/`.settings-row.checkbox`/`.consent-row` are three
  implementations; the native checkbox is ~13-16px, the whole row is
  clickable only for settings rows [A].

**Headings / type**
* Dialog titles: `.confirm-dialog h2` 18px/default weight (5603),
  `.scan-dialog-head h2` 18px/650 (5372), `.agenda-editor-heading` 17px/680
  (269), `.settings-head h2` 18px/650 (6920), `.empty-state-card h2` 22px (5282),
  `.brand h1` 26px/650 (2517), `.settings-group > h3` 13px/600 muted (6929).
  Weights 600, 650, 680, 700 all in use [C].
* Body sizes seen: 12, 13, 14, 15, 16, 17, 18, 22, 26px; line-heights
  1.3, 1.4, 1.45, 1.5, 1.55 [C].
* Many `font-size` values below 13px (hints 12px, `.note-readonly-banner` 12px,
  `.agenda-editor-recurrence legend` 12px) [A].

**Contrast** (computed WCAG ratios, text on its usual background)

| Pair | Ratio | Verdict |
|---|---|---|
| light `--muted #8e8e93` on `#fff` | **3.26** | fails AA for normal text (`.muted`, hints, labels, 2105, 7053) |
| light `--sn-nav-muted #8e8e93` on `#f2f2f7` | **2.92** | fails |
| light `--danger #d94848` on `#fff` | **4.22** | just fails for 13px `.error`/`.field-error` |
| white on light `--danger #d94848` (`.btn.primary.danger`) | 4.22 | fails for normal text |
| dark white on `--accent #4f8cff` (`.btn.primary`) | **3.22** | fails (needs >= 4.5; large/bold text only passes 3) |
| dark white on `--danger #ff6b6b` (`.btn.primary.danger`) | **2.78** | fails |
| dark white on `--success #3ecf8e` (`.btn.primary.success`) | **2.00** | fails |
| light white on `--accent #086dd6` | 5.04 | ok |
| light `--warning #b45309` on `#fff` | 5.02 | ok |
| dark `--muted #8b98a5` on `--bg` / `--bg-elevated` | 6.29 / 5.76 | ok |
| dark `--accent` on `--bg`; `--danger` on `--bg` | 5.75; 6.67 | ok |
| `--border` light `#e5e5ea` on white / dark `#2a3440` on `--bg` | 1.26 / 1.47 | fine for decoration, but **input borders need >= 3:1** (WCAG 1.4.11): fails in both themes |

**Aria / semantics**
* `#toast` (`app.html` 2851) is a bare `<div hidden>`; no `role="status"` /
  `aria-live`; error toasts are not announced *(to verify the JS at app.js
  4334-4366 does not set them)* [A].
* Dialogs have `role=dialog aria-modal aria-labelledby` (good, 27 found), but
  `#agenda-import-preview` uses `aria-label`, and `#doc-viewer` has an empty
  body at load. Notes `#editor-sync-banner`, `#unlock-update-hint` use
  `aria-live`; `#unlock-status` does too. Password toggles use
  `aria-label="Show password"` that never changes to "Hide" in markup
  *(to verify the JS toggles `aria-pressed`/label)* [A].
* Search inputs combine `role="searchbox"` on `type="text"`; redundant but
  harmless; `#totp-search` uses `type="search"` [C].

### 2.2 Sign-in, registration, recovery, unlock

Files: `app/templates/login.html`, `register.html`, `verify.html`, `totp.html`
(2FA code entry at sign-in), `app.html` `#unlock-screen` (572-609);
CSS `.auth-page` (2147), `.auth-card` (2162), `.auth-card label` (2180),
`.brand` (2517), `.auth-hint` (2723), `.password-field-wrap` (5641),
`.pw-meter`, `.zk-badge` (~2350), `.session-cap-panel` (2108),
`.login-progress-*`, `.unlock-progress`.

* Light `.auth-page`/`.auth-card` use slate hard-codes (`#e2e8f0`, `#f8fafc`,
  `#e0f2fe`) whereas the rest of the light theme is iOS-grey (see 1.2) [C].
* `.auth-card` radius 20px (not on the 8/12/16 scale), padding `36px 24px 20px`
  (asymmetric: 20px bottom with the footer links) [L].
* `login.html`: primary "Sign in" then two `subtle block` buttons and a
  `hint center` paragraph then a `.btn.link` inside a `<p>`; four secondary
  elements compete with the single primary action [C][W].
* Hint text is long and duplicated: `login.html` 15, 34, 40, 52; `register.html`
  36, 68 (one 90-word paragraph, `.auth-hint`); unlock 577, 580, 588-590, 599.
  Wording/length to be reviewed, not removed (protected semantics) [W].
* Unlock: up to 6 `.auth-hint` paragraphs and 4 `ghost block` buttons share one
  stack; the primary "Unlock" sits between two groups of ghosts (598-601) [C][W].
* `register.html`: field error paragraphs are separate siblings with
  `margin:-4px 0 0`, so hint, meter and error stack with different gaps
  (`.stack` 12px) [L]. Consent rows use `.consent-row`, not `.checkbox` [C].
* Password toggle `.password-toggle.btn.ghost.sm` text "Show", 44px tall but
  the input is 44-46px: baseline/height mismatch *(to verify)* [L].
* `totp.html` code input 22px with 0.35em tracking, no `aria-label` beyond the
  wrapping label *(to verify)* [A].
* Error `p.error` is 13px, 4.22:1 in light (see contrast) [A].

### 2.3 Notes list and editor

Files: `app.html` `#note-list-head` (958), `#search`, `#search-filter-panel`
(1009), `#note-list` (1054), `#empty-state` (1073), `#editor-scroll` (1411),
`#md-toolbar` (1424), `#preview`, `#checklist` (1465), `#history-list`,
`#editor-actions-overflow-panel` (1184), `#note-options`; CSS `.note-row`,
`.note-item`, `.filter`, `.editor-actions` (6771), `.note-readonly-banner`
(7401), `.checklist` (7416), `.note-warn-*` (7664), `.label-menu` (11286),
`.list-density-btn` (7791), `.vault-lock-btn` / `.edit-lock-btn` (6785/6832).

* Horizontal padding differs: `.note-readonly-banner` margin `0 14px`
  (7401), `.checklist` padding `8px 14px 16px` (7416), `.settings-row` `12px
  14px`, `.agenda-editor-scroll` `14px 16px`, `.scan-dialog-*` `20px` [L].
* `.editor-actions` gap 6px (6771) vs 8px / 10px / 12px elsewhere for button
  rows [L].
* Icon buttons in the editor header (`.editor-actions .btn.icon`) are 44px, but
  `.list-density-btn`, `.label-menu-btn` (opacity-on-hover, revealed by
  `:focus-visible` only, 11299), and note-row swipe actions use their own
  sizes [A][C].
* Lock/protect icons come as three separate implementations
  (`.vault-lock-btn`, `.edit-lock-btn`, `.note-info-protect-btn`) with
  inline-SVG show/hide of open/closed glyphs [C].
* Markdown/code token colours in light use hard-coded Tailwind hexes
  (`.tok-kw #0369a1`, 10418-10420, 10482-10484) [C].
* Empty state: `.empty-state-card` (5263) with `h2` 22px, tips list, and
  `.empty-state-actions .btn { min-width: min(280px,100%) }` on mobile only
  (8882) [C].
* `.label-menu [role=menuitem]:focus-visible` has `outline:none` (11329) [A].

### 2.4 Attachments and OCR

Files: `app.html` `#attachment-list` (1473), `#attachment-repair` (1957),
`#scan-dialog` (2412) and `#scan-empty` (2419), `#doc-viewer` (2803) with
`#doc-enhance-panel` (2830) and `#doc-viewer-find-slot` (2840), `#file-download-progress`
(338); CSS `.attachment-main`, `.ocr-retry` (4025), `.scan-dialog*`
(5342-5410), `.scan-empty`, `.doc-viewer*` (6597-6646), `.file-download-progress*`.

* `.scan-dialog` is a bottom sheet with a drag **handle** (5360) that is purely
  decorative (no swipe handler implied by the markup *(to verify)*), while
  other dialogs have none [C].
* Header/body/foot paddings are `20px` here (5370-5395) vs `18px` in
  `.confirm-dialog` (5595) and `16px 18px` in `.settings-head` [L].
* `.scan-dialog` uses `box-shadow 0 -12px 40px rgba(0,0,0,.4)` (hard-coded) vs
  `.confirm-dialog` `0 16px 48px rgba(0,0,0,.35)` vs `.toast`
  `0 8px 24px rgba(0,0,0,.35)` and the token `--shadow-md` (never used by
  these) [C].
* `.doc-viewer-tools` hides its scrollbar (6645); on narrow screens the tool
  row scrolls horizontally with no affordance [L].
* `.doc-viewer .btn.ghost` (6646) restyles buttons locally [C].
* Progress dialogs (`#app-update-progress`, `#file-download-progress`,
  `#login-progress-overlay`) are three different layouts, and the first uses
  `role=alertdialog` with `aria-busy` but no focusable element and no Escape
  semantics (intentional; must stay non-cancellable) [C].
* Download/OCR feedback relies on `#toast` (see 2.1 aria) [W].

### 2.5 Agenda

Files: `app.html` `#agenda-pane` (1487), `#agenda-calendar-settings` (1491),
`#agenda-calendars-list` (1507), `#agenda-subscribe-*` (1522-1528),
`#agenda-subscriptions-list`, `#agenda-sheet` (2594), `#agenda-scope-chooser`
(2620), `#agenda-detail-card` (2644), `#agenda-editor` (2657),
`#agenda-import-preview` (1489); JS `app/static/js/agenda.js`,
`agenda-subscriptions.js`, `agenda-calendars.js`; CSS 200-620 (editor, sheet,
scope chooser), 623-760 (title/more/icon buttons), 1272-1349 (calendar
settings), 11445.

* **Dialog build is inconsistent even inside Agenda**: `#agenda-sheet`,
  `#agenda-scope-chooser`, `#agenda-detail-card`, `#agenda-editor` all use
  `.confirm-dialog` as a base but each overrides position/z-index
  (`body.agenda-*-open` rules at 210-213, 232-233, 397, 409, 1303, 1383), while
  `#agenda-calendar-settings` is a separate `aside` panel with its own head
  (`.agenda-calendar-settings-head`, 1306) [C].
* z-index ladder is patched with per-body-class overrides: confirm 200/201 vs
  agenda editor 205/210 vs confirm-over-editor 219/220 [C].
* Heading `.agenda-editor-heading` 17px/680 vs 18px elsewhere [C].
* `.agenda-scope-actions` stacks full-width `btn primary / ghost / ghost`,
  while `#confirm-dialog` right-aligns buttons: two different action layouts
  [C]. Cancel is placed last here and **first** in `#confirm-dialog` (cancel
  left of confirm) [C][A].
* Colour swatches are 28x28 (222), below 44px; selected state relies on a
  border colour change (`.is-selected`, 248) [A].
* `.agenda-editor-datetime-field input[type=date]:focus { outline: none }` (503):
  the container uses `:focus-within` (478) so focus is visible *(to verify
  contrast in light)* [A].
* `#agenda-sheet` help: `<dl class="agenda-shortcut-list">` with `<kbd>`; lists
  "Esc: Close a dialog", which must stay true (see 4.3).
* Agenda editor vertical rhythm: `.agenda-editor-scroll` padding `14px 16px 10px`;
  `legend` 12px/650; inline `margin: 12px 0 0` fieldsets (276-278) [L].
* Subscriptions: `#agenda-subscribe-url` / `-name` use global input style, list
  rows `.agenda-subscription-*` *(to verify)* [C].
* Reduced motion only covers `.agenda-task-title` colour (11445) [A].
* Related prior audit: `docs/AGENDA_PWA_VISUAL_AUDIT.md`.

### 2.6 2FA codes (list, add, import, QR scan)

Files: `app.html` `#totp-pane` (1559), `#totp-search`, `#totp-list-head`
(1596), `#totp-list` (1603), `#totp-cam` (2450), `#totp-add-dialog` (2468),
`#totp-import-dialog` (2511) with `#totp-import-preview/-list` (2529-2531);
JS `app/static/js/totp.js`, `totp-import.js`; CSS `.totp-code` (1642), `.totp-ring`
(1649), `.totp-cam` (11449), `html.totp-toast-open` (5318-5334), `.scan-dialog`
(shared with add/import).

* Add and import dialogs reuse `.scan-dialog` (bottom sheet) while the camera
  `#totp-cam` is a full-screen `inset:0` layer with its own close button
  [C].
* Toast handling is special-cased for 2FA (`html.totp-toast-open` reserves 56px
  and changes the toast to full width, 13px), so toasts look different on this
  screen only [C].
* Code font 22px/700 with 0.08em tracking and the ring 22x22 (1642-1651); copy
  affordance is the row itself *(to verify keyboard access and `aria-label`)* [A].
* Import: password field `#totp-import-password` has `autocomplete="off"`
  (fine) but no show/hide toggle, unlike the other password fields [C].
* Inputs in the add dialog use `maxlength` 120-512 with placeholder-only
  examples; the label markup is `<label>Text <input>` (implicit) [C].
* Empty state for 2FA list *(to verify; not found as a shared
  `.empty-state-card`)* [C][W].

### 2.7 Secure send

Files: `app.html` `#secure-send-panel` (2171), `#secure-send-title` (2183),
`#secure-send-passphrase` (2203), `#secure-send-file-inclusion-list` (2195),
`#secure-send-sent-list` (2236), `#secure-send-detail` (2270) with
`-preview/-attachments`, `#settings-secure-send-link` (1832), `receive.html`;
JS `secure-send.js`, `secure-send-receive.js`; CSS `.secure-send-*` (1987-2078,
inside the `.btn` block), `.receive-download-btn` (2648).

* `.secure-send-*` rules are interleaved with the `.btn` block (1987-2078),
  which makes the button definitions hard to find [C].
* `.secure-send-file-remove` is a 44px button with a text "×" at 20px instead of
  the `.ui-icon` svg [C].
* `#secure-send-detail` is a `.note-options` sheet (its own dialog family) while
  the panel is an `aside.settings-panel` [C].
* Hints at 12px with `opacity .9` on `--muted` (2019-2027): compounds the
  contrast failure in light theme [A].
* `receive.html`: passphrase field has `autocomplete="off"`, one primary action *(to
  verify wording)* [W].

### 2.8 Settings, session and device panels

Files: `app.html` `#settings-panel` (1651), `#plan-picker-panel` (1618),
`#signed-in-devices-group` (1704), `#signed-in-devices` (1758),
`#approve-new-device-panel` (1724), `#verify-device-start-panel` (1737),
`#vault-freshness-panel` (1708), `#device-phrase-settings` (1869),
`#passkey-settings` (1881), `#password-change` (1904), `#attachment-repair`
(1957), backup groups (Google Drive 1998, Dropbox 2037, pCloud 2117, email
2072), `#settings-ai-chat` (1804), `#settings-about`, `#settings-danger-zone`
(2158), `#account-info-dialog` (2575), `#session-cap-panel` (login.html);
CSS `.settings-panel` (6900), `.settings-head` (6915), `.settings-body`
(6921), `.settings-group` (6928), `.settings-row` (7010), `.settings-hint`
(7053), `.settings-nested`, `.session-cap-panel` (2108).

* `.settings-group > h3` is 13px `--muted` (6929): section titles are
  **smaller and fainter than row text (15px)**, fails contrast in light, weak
  hierarchy [A][C].
* Rows use `justify-content: space-between` with wrap; long labels + control
  wrap unpredictably at 360px *(to verify)* [L].
* `.settings-row select` 14px/8px padding vs global 16px/12px [C].
* Mixed button forms in one panel: `btn`, `btn primary`, `btn ghost`,
  `btn danger`, `btn sm`, bare text links; e.g. "Lock vault now" is plain `.btn`
  while "Change vault password" is `.btn.primary` in the same panel (1921,
  1925) [C].
* `#password-change-current` is `readonly` with `autocomplete="off"` and
  `required`; error `#password-change-error` has no `role=alert` [A].
* `#settings-danger-zone` danger styling is outline-only `.btn.danger` (low
  emphasis) *(to verify visual weight)* [C].
* `.settings-hint` carries 3 roles (help, warning, error) distinguished only by
  extra classes (7054-7066) [C].
* Panel is `aside` right-docked 420px with `settings-backdrop`; the
  plan picker re-uses the same chrome. Close affordance location differs from
  the other dialogs (see 2.9) [C].

### 2.9 Dialogs, toasts, confirmations (all popups)

Families found (27 `role=dialog|alertdialog` elements in `app.html`):

| Family | Elements | Position | Notes |
|---|---|---|---|
| `.confirm-dialog` | `#confirm-dialog` (2780), `#folder-prompt` (2769), `#account-info-dialog`, `#tag-manage-dialog` (2561), `#hero-guide-dialog` (2756), `#ai-outbound-dialog` (2790), agenda sheet/scope/detail/editor | fixed, bottom-centre, `bottom:max(16px, safe-area)`, `width:min(420px,100vw-24px)`, z 90 (5584-5597). `#folder-prompt` and `body.confirm-over-unlock` re-centre to `top:50%` (5598, 114) | `h2` 18px, no close X, padding `18px 18px 14px` |
| `.scan-dialog` | `#scan-dialog`, `#totp-add-dialog`, `#totp-import-dialog`, `#server-copy-dialog` (2387), `#auth-security-notice` (2375, `alertdialog`) | bottom sheet, full width, z 51, radius `16px 16px 0 0` (5342) | head/body/foot split, handle |
| `.template-dialog` | `#template-dialog` (307), `#quick-capture` (320) | *(to verify)* | |
| `.note-options` | `#note-options`, `#secure-send-detail` | sheet | |
| `.settings-panel` | `#settings-panel`, `#plan-picker-panel`, `#secure-send-panel`, `#ai-chat-panel` | right drawer, 420px | head with title, close |
| `.modal` (native `<dialog>`) | `.modal`, `.modal-body`, `.modal-head` (6756-6767) | native `showModal`, backdrop `rgba(0,0,0,.55)` | the only family with native focus handling; `.modal-body` `max-height: calc(100dvh - 24px)` plus `.modal` `max-height` same, so it can overflow by the padding *(to verify)* |
| Full-screen | `#doc-viewer` (2803), `#totp-cam` (2450) | `inset:0` | |
| Progress | `#app-update-progress`, `#file-download-progress`, `#login-progress-overlay` | | non-cancellable by design |

Gaps against the target pattern (section 4):

* **Escape**: `confirmAction()` handles it correctly, Escape = cancel
  (`app.js` 5735-5740) and resolves `false`, and initial focus is on **Cancel**
  (5746-5748). Other dialogs implement it individually (26 `Escape` sites in
  `app.js`, 11 in `agenda.js`); coverage is not uniform *(to verify per dialog)* [A].
* **Focus trap**: only a single `Tab` handler at `app.js` ~6048 (overlay) and
  25805; `confirmAction()` has **no Tab trap and no focus restore** to the
  opener [A].
* **Close button**: none of the `.confirm-dialog` or `.scan-dialog`
  dialogs has a header X; settings panels have one, with different markup [C].
* **Action order and alignment**: `#confirm-dialog` right-aligned
  `Cancel | (extra) | Confirm`; agenda dialogs full-width stacked with primary
  first; `.scan-dialog-foot` equal-width flex row [C].
* **Transitions**: no open/close transition on dialogs; `prefers-reduced-motion`
  is only handled for progress bars (10252, 10964) and one agenda colour
  transition (11445). Any new transition must be added together with a
  reduced-motion guard [A].
* **Scrolling on small screens**: `.scan-dialog` and `.agenda-editor-scroll`
  scroll internally; `.confirm-dialog` has **no max-height / overflow**, so a
  long `#confirm-message` (`white-space: pre-line`, 5605) or
  `#tag-manage-dialog` list can run off-screen on a phone in landscape [L].
* **Backdrops**: `rgba(0,0,0,.45)` `.settings-backdrop` (6897), `.scan-backdrop`
  `.45` (5339), confirm `rgba(15,20,25,.62)` (111), `.modal::backdrop` `.55`
  [C].
* **Toast** `.toast` (5299): fixed bottom-centre, radius 10px, padding
  `10px 16px`, `--bg-hover` background, hard-coded shadow, `.error` = border and
  text `--danger` only (contrast per theme, no icon); `html.toast-above-dialog`
  moves it to 112px above (5313); 2FA has its own override (5318). `.toast-undo`
  inside a flex toast (10404). No `role=status`; no dismiss; duration lives in
  JS [A][C][W].
* **Confirm wording**: default title "Confirm" and default labels "Confirm/Cancel"
  (`app.js` 5679-5682); callers pass specific verbs in places, but generic
  "Confirm"/"OK" remain (`#account-info-close` "OK", 2589). Destructive
  confirms should name the action ("Delete note", "Delete 3 notes") [W].

---------------------------------------------------------------------------

## 3. Proposed design tokens

Principle: **derive every token from a value already in use** so the visual
change on day one is close to zero, then migrate rules to the tokens area by
area. Token names extend the existing `--bg/--text/--accent/--radius-*`
names (no renames). New tokens are added in one `:root` block (dark) and one
`html[data-theme="light"]` block. The duplicate second light block (7382) is
merged into the first as part of the tokens task, resolving the iOS-vs-slate
conflict (see 3.3).

### 3.1 Spacing scale (4px base)

Derived from the paddings/gaps in use (4, 6, 8, 10, 12, 14, 16, 18, 20, 24).

| Token | Value | Replaces typically |
|---|---|---|
| `--space-1` | 4px | tight gaps (`.empty-state-actions`, 4px margins) |
| `--space-2` | 8px | default gap between buttons/inline items (most common) |
| `--space-3` | 12px | `.stack` gap, row padding vertical, grid gap |
| `--space-4` | 16px | dialog/panel padding, `.settings-head` vertical |
| `--space-5` | 20px | `.scan-dialog` padding, auth page padding |
| `--space-6` | 24px | auth card padding, section gaps |
| `--space-7` | 32px | `.settings-body` bottom, large separation |

Odd values 6, 10, 14, 18 are folded to the nearest step (6 -> 8 or 4, 10 -> 8
or 12, 14 -> 12 or 16, 18 -> 16 or 20). Allowed exceptions: 1-2px borders,
optical alignment inside icons, and the existing `calc(... + var(--safe-*))`
expressions, which keep wrapping a token (`calc(var(--space-6) + var(--safe-top))`).

Standard paddings after migration: dialog/panel body `--space-4` on phones,
`--space-5` from 600px; list/settings rows `--space-3 --space-4`; form field
gap `--space-2` (label to input) and `--space-3` (between fields); button row
gap `--space-2`.

### 3.2 Radius

Keep the three existing steps and add two missing ones. Existing literal values
map as follows.

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 8px (existing) | chips, small inputs inside rows, kbd |
| `--radius-md` | 12px (existing; `--radius` stays as alias) | buttons, inputs (10px -> 12px), cards, toast |
| `--radius-lg` | 16px (existing) | dialogs, sheets, auth card (20px -> 16px) |
| `--radius-pill` | 999px | pills, progress, handle |
| `--radius-round` | 50% | swatches, avatar-like dots |

Literal 6/10/14/18px collapse into the nearest of the above.

### 3.3 Colour (dark = current `:root`, light = one consolidated block)

Dark keeps today's values unchanged. **Light** is consolidated by taking the
*effective* (second-layer, iOS-style) value that users already see, with three
corrections that fix contrast failures measured in 2.1; changed values are
marked **(changed)**.

| Token | Dark (unchanged) | Light (effective today) | Light (proposed) |
|---|---|---|---|
| `--bg` | #0f1419 | #ffffff | #ffffff |
| `--bg-elevated` | #171d24 | #ffffff | #ffffff |
| `--bg-hover` | #1f2730 | #f2f2f7 | #f2f2f7 |
| `--border` | #2a3440 | #e5e5ea | #e5e5ea (decorative dividers) |
| `--border-strong` (new) | #5b6b7c (>= 3:1 on `--bg`) | n/a | #8a8a91 (>= 3:1 on white), **used for input/checkbox borders only** |
| `--text` | #e8edf2 | #1c1c1e | #1c1c1e |
| `--muted` | #8b98a5 | #8e8e93 (3.26:1) | **(changed)** #6b6b73 (>= 5:1 on white and on `#f2f2f7`) |
| `--accent` | #4f8cff | #086dd6 | #086dd6 |
| `--accent-soft` | rgba(79,140,255,.15) | rgba(8,109,214,.12) | same |
| `--on-accent` (new) | #0f1419 (5.75:1 on #4f8cff) | n/a | #ffffff (5.04:1) |
| `--danger` | #ff6b6b | #d94848 (4.22:1) | **(changed)** #c93636 (>= 4.5:1 on white) |
| `--on-danger` (new) | #0f1419 | n/a | #ffffff |
| `--success` | #3ecf8e | #059669 | #059669 (white on it is 3.8:1, so use `--on-success` #0f1419 in dark / #fff only for >= 18px bold, or keep success as a text/icon colour, not a button fill) |
| `--warning` | #ff9f1c | #b45309 | #b45309 (5.02:1) |
| `--overlay` (new) | rgba(0,0,0,.55) | | rgba(15,23,42,.45) |
| `--focus-ring` (new) | = `--accent` | = `--accent` | = `--accent` |

Notes:
* The dark white-on-accent button text (3.22:1) and white-on-danger (2.78:1)
  fail AA; the proposal switches dark filled buttons to dark text
  (`--on-accent` #0f1419, 5.75:1) **or** darkens the dark-theme fill. The
  follow-up task must pick one and verify in a browser; recognisability
  argues for keeping the blue and changing the label colour only if the
  owner agrees, otherwise darken the fill to `#2f6fe4` (white = 4.6:1).
* `--sn-*` and `--doc-*` tokens remain, resolved per theme in the same two
  blocks; the `>=1000px` media block keeps only layout widths.
* `color-scheme: dark` on `:root` and `light` on the light block should be set so
  native controls (date pickers, scrollbars) follow the theme.
* Status colours always travel with an icon or text, never colour alone.

### 3.4 Shadows

Today `--shadow-sm/md` are unused by the dialogs, which hard-code their own.
Proposed set (dark values are the current hard-coded ones; light values
reuse the current slate-tinted light shadows):

| Token | Dark | Light | Use |
|---|---|---|---|
| `--shadow-sm` | 0 1px 2px rgba(0,0,0,.25) | 0 1px 2px rgba(15,23,42,.05) | hover on primary, raised rows |
| `--shadow-md` | 0 8px 24px rgba(0,0,0,.35) | 0 8px 24px rgba(15,23,42,.08) | toast, menus, popovers (current `.toast`) |
| `--shadow-lg` | 0 16px 48px rgba(0,0,0,.35) | 0 16px 40px rgba(15,23,42,.14) | dialogs (current `.confirm-dialog`) |
| `--shadow-sheet` | 0 -12px 40px rgba(0,0,0,.4) | 0 -12px 40px rgba(15,23,42,.16) | bottom sheets (current `.scan-dialog`) |

### 3.5 Type scale

Base font stays the system stack (`--font`, no new fonts). Current sizes
(12-26px) collapse to:

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 12px / 1.4 | 400 | timestamps, badges only (never body or hints) |
| `--text-sm` | 13px / 1.45 | 400 | hints, errors, helper text |
| `--text-base` | 15px / 1.5 | 400 | rows, labels, descriptions |
| `--text-md` | 16px / 1.5 | 400 | inputs (keeps iOS no-zoom 16px), note body |
| `--text-lg` | 18px / 1.35 | 600 | dialog and panel titles (h2) |
| `--text-xl` | 22px / 1.25 | 650 | empty-state and page headings (h1/h2 big) |
| `--text-2xl` | 26px / 1.2 | 650 | auth page h1 (`.brand h1`) |

Weights are limited to 400, 500 (labels), 600 (headings, buttons) and 700
(2FA code only); 650 and 680 fold into 600. `--note-*` variables are
user-controlled editor sizes and stay as they are.
Heading rule: one `h1` per full page, dialogs use `h2` with `--text-lg`,
section titles inside a panel use `h3` at `--text-base`/600 in `--text`
(not `--muted`, replacing the 13px muted `.settings-group > h3`).

### 3.6 Touch target, motion, z-index, focus

* `--touch: 44px` (existing) is the **minimum hit area** of every control on
  touch layouts: buttons, icon-only buttons, toggles, checkbox rows, list rows,
  swatches (28px visual can stay if the hit area, via padding or `::before`
  with `inset: -8px`, reaches 44px), select, date and time inputs. Adjacent
  targets are at least 8px apart (`--space-2`). Inputs use `min-height: var(--touch)`.
* Motion: `--dur-fast: 120ms`, `--dur-base: 180ms`, existing `--ease-out`.
  Everything animated is wrapped as in 4.4.
* Z-index scale (replaces ad-hoc 49-220 and per-body-class patches): `--z-sheet:
  50`, `--z-dialog: 90`, `--z-toast: 120`, `--z-confirm: 200`. A confirm must
  always sit above any other dialog; this removes the 219/220 and 120/121
  special cases.
* Focus ring (one rule for all interactive elements):
  `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }`
  Inputs also use this ring (replacing the `--accent-soft` 2px outline) and
  additionally `border-color: var(--accent)`. `outline: none` is allowed only
  when a container with `:focus-within` shows the same ring.

---------------------------------------------------------------------------

## 4. Patterns

### 4.1 Buttons

Base `.btn` (all variants): `min-height: var(--touch)`, padding
`0 var(--space-4)` (`var(--space-3)` for `.sm`; `.sm` remains 44px high on
touch layouts), `border-radius: var(--radius-md)`, `font-size: var(--text-base)`,
weight 600, `line-height: 1.2`, inline-flex centred, `gap: var(--space-2)`
between icon and label, transition on background, border-color, box-shadow
`var(--dur-fast)` (disabled under reduced motion). One variant per role; the
legacy classes map as: `ghost` and `subtle` -> **secondary** (kept as
aliases until all templates are migrated), `.btn.danger`
-> **danger (outline)**, `.btn.primary.danger` -> **danger (filled)**,
`.btn.icon` -> **icon-only**, `.btn.link` stays a text link.

Rule: **at most one primary per screen/dialog**; destructive actions never share
the primary style with the safe action next to them.

| State | Primary | Secondary | Danger | Icon-only |
|---|---|---|---|---|
| Default | bg `--accent`, text `--on-accent`, border `--accent` | bg transparent, text `--text`, border `--border-strong` | outline: text `--danger`, border `--danger`, bg transparent (filled variant for the final confirm: bg `--danger`, text `--on-danger`) | 44x44, bg transparent, border 0, icon `currentColor` (`--muted` default, `--text` on hover), `border-radius: var(--radius-md)` |
| Hover (pointer devices only, `@media (hover: hover)`) | `color-mix(in srgb, #000 8%, var(--accent))` fill plus `--shadow-sm` | bg `--bg-hover`, border `color-mix(in srgb, var(--accent) 35%, var(--border-strong))` | bg `color-mix(in srgb, var(--danger) 10%, transparent)` (filled: darker 8%) | bg `--bg-hover`, icon `--text` |
| Focus-visible | ring from 3.6 | same | same | same; ring must not be clipped by `overflow:hidden` parents |
| Pressed (`:active`, `[aria-pressed=true]` for toggles) | fill darker 14%, no shadow, `transform: translateY(1px)` (guarded, see 4.4) | bg `color-mix(in srgb, var(--accent) 14%, var(--bg-hover))` | bg `color-mix(in srgb, var(--danger) 18%, transparent)` | bg `--accent-soft`, icon `--accent` (matches today's `.editor-actions .btn.icon.active`, 6775) |
| Disabled (`:disabled`, `[aria-disabled=true]`) | `opacity .55`, `cursor: not-allowed`, no hover/pressed, `pointer-events: none` only for `aria-disabled` (so the title tooltip still works) | same | same | same |
| Busy (optional) | `aria-busy=true`, label kept, spinner via existing `.btn-sync-now.is-syncing` approach | same | same | same |

Icon-only buttons **must** have `aria-label` (and `title` for desktop); the
SVG has `aria-hidden="true"` (the `.ui-icon` class already sets
`pointer-events:none`). Icons come from the existing inline `.ui-icon` set,
stroke 2, 20px in 44px, the same size everywhere; text glyphs ("x" or "x" in
`.secure-send-file-remove`) are replaced by the icon during the polish task.

### 4.2 Forms

* Label above the field, always visible (no placeholder-only labels):
  `--text-sm`/500, colour `--text` (not `--muted`), gap `--space-2` to the field.
* Field: `min-height: var(--touch)`, padding `--space-3 --space-4`,
  `border: 1px solid var(--border-strong)`, radius `--radius-md`, font 16px.
* Help text `--text-sm`, `--muted`, below the field; error text `--text-sm`,
  `--danger`, with a leading icon or "Error:" word so it does not rely on
  colour; linked with `aria-describedby`, field gets `aria-invalid="true"`; the
  error element has `role="alert"` (as `register.html` already does) and is
  placed directly under its own field with `margin-top: var(--space-1)`.
* Required: a visible "(required)" suffix or `*` with a legend; `aria-required`
  stays.
* One checkbox/toggle row component: whole row clickable, 44px high, 20px
  control.
* Password fields keep `.password-field-wrap` plus a "Show"/"Hide" toggle whose
  `aria-label` and `aria-pressed` update.

### 4.3 Dialog pattern

**Status (shared tokens/buttons/dialogs task):** the tokens from section 3
are CSS variables in `app.css` (dark in `:root`, light in the first
`html[data-theme="light"]` block); the button states from 4.1 are one shared
rule set on `.btn`; and `app/static/js/dialog-a11y.js` gives **every**
`role="dialog"`/`role="alertdialog"` element with `aria-modal="true"` the shared
behaviour: focus trap, safe initial focus (never a `.danger` button), and focus
back to the opener on close. It also adds the short open/close fade, which is
off under `prefers-reduced-motion`. `confirmAction()` uses `DialogA11y.confirm()`:
Escape, the X button and the backdrop always resolve `false`, and they are
ignored while the dialog or one of its buttons has `aria-busy="true"`. So far only
`#confirm-dialog` uses the full header/close/body/actions markup
(`.dialog-pattern`). The other dialogs keep their own markup and Escape
handling, and the per-area tasks in section 6 move them to `.dialog-pattern`.

One structure for every modal (confirm, prompts, sheets, editors, add/import,
detail cards). Wrapper `role="dialog"` (or `alertdialog` for unavoidable
decisions) `aria-modal="true"`, `aria-labelledby` = title id,
`aria-describedby` = message id when there is body text.

```
<div class="dialog-backdrop" hidden></div>
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="X-title">
  <header class="dialog-head"> <h2 id="X-title">Title</h2>
    <button class="btn icon" aria-label="Close">...</button></header>
  <div class="dialog-body"> ...scrolls... </div>
  <footer class="dialog-actions"> secondary ... primary </footer>
</div>
```

(Class names are a proposal; the follow-up task may keep the existing
`.confirm-dialog` / `.scan-dialog` names and only align the parts.)

* **Header**: title `h2` `--text-lg`/600, left; close button (icon-only, 44px)
  right; `padding: var(--space-4) var(--space-4) var(--space-2)`. Dialogs with a
  single "OK" (e.g. `#account-info-dialog`) still get the X.
* **Body**: `padding: 0 var(--space-4)`; `overflow-y: auto`,
  `overscroll-behavior: contain`, `-webkit-overflow-scrolling: touch`; text
  `--text-base`, message `white-space: pre-line` kept where it exists.
* **Actions**: footer separated by a 1px `--border` top line on sheets; buttons
  right-aligned on >= 600px, **Cancel/secondary left of the primary**,
  `gap: var(--space-2)`, `flex-wrap: wrap`; on phones the buttons are full-width,
  stacked, **primary on top**, cancel at the bottom. Same order everywhere
  (resolves the confirm vs agenda difference in 2.9).
  Destructive confirms use the filled danger button, label names the action,
  and the **initial focus is on the safe button (Cancel)**, as
  `confirmAction()` does today (`app.js` 5746-5748). Non-destructive dialogs focus
  the first field, or the primary button when there is no field.
* **Close button**: top-right icon-only X, `aria-label="Close"` (or "Cancel"
  in confirm-type dialogs where closing equals cancelling); same action as
  Escape and backdrop click.
* **Centring**: desktop/tablet: centred horizontally and vertically
  (`position: fixed; inset: 0; margin: auto` or flex container), width
  `min(480px, 100vw - 2*var(--space-3))` (wide editors `min(640px, ...)`).
  Phone (<600px): bottom sheet, full width, radius `--radius-lg` on the top
  corners only, `padding-bottom: var(--safe-bottom)` (as `.scan-dialog` does).
  The same component switches mode with one media query; the special-cased
  `#folder-prompt` / `confirm-over-unlock` re-centring rules disappear.
* **Scrolling on small screens**: dialog `max-height: min(92dvh, 720px)`
  (`dvh`, so mobile browser chrome and the keyboard are accounted for), flex
  column, header and actions fixed, only the body scrolls; keyboard offset via
  the existing `--scan-kb-offset` / `--editor-kb-offset` pattern. No dialog
  may exceed the viewport (fixes `.confirm-dialog` without max-height, 2.9).
* **Focus trap**: on open, remember `document.activeElement`, move focus into the
  dialog (rule above), keep Tab and Shift+Tab inside (wrap first<->last
  focusable), set `inert`/`aria-hidden` on the page behind where supported,
  and on close return focus to the opener. Nested dialogs (confirm above
  editor) trap in the top-most only. Implement once as a shared helper, not
  per dialog.
* **Escape = cancel, never confirm.** Pressing Escape always runs the
  **cancel** path: the dialog closes, the promise resolves `false` / the
  callback receives "cancelled", and **nothing is saved, deleted, sent or
  otherwise confirmed**. Escape is never mapped to the primary action, and
  Enter on a destructive dialog never fires the confirm unless the confirm
  button is focused. In a stack of dialogs Escape closes only the top-most
  one (existing `confirmAction` uses a capture-phase handler that
  `stopPropagation`s, 5735-5740, which is the reference). Unsaved-changes
  prompts: Escape = "Keep editing/Cancel", never "Discard". Progress dialogs
  (`#app-update-progress`, `#file-download-progress`, login progress) are the only
  exceptions: they have no cancel action and ignore Escape; this is
  intentional and documented in markup (`role=alertdialog`, `aria-busy`).
  Backdrop click = the same as Escape for non-destructive dialogs; for dialogs
  that hold unsaved input, the backdrop click is ignored.
* **Transition**: open = opacity 0->1 plus `translateY(8px)->0` (sheet:
  `translateY(100%)->0`), duration `--dur-base` 180ms, `--ease-out`; close =
  reverse in `--dur-fast` 120ms, after which `hidden` is set (the JS that sets
  `hidden` waits for `transitionend` with a 200ms fallback timer so a missed
  event can never leave a dialog stuck open). Backdrop fades in `--dur-fast`.
* **Reduced motion**: wrap in
  ```
  @media (prefers-reduced-motion: reduce) {
    .dialog, .dialog-backdrop, .btn { transition: none; animation: none; transform: none; }
  }
  ```
  so dialogs appear and disappear instantly; also remove the `.btn:active`
  translate. Transitions are only declared inside
  `@media (prefers-reduced-motion: no-preference)`, or are neutralised by the
  block above, whichever the follow-up task chooses; both must hold in a
  browser with the OS setting on.
* z-index from the scale in 3.6; backdrop `--overlay`; shadow `--shadow-lg`
  (centred) / `--shadow-sheet` (sheet).

### 4.4 Toasts and inline messages

* `#toast`: `role="status"` + `aria-live="polite"` (errors: `role="alert"`),
  bottom-centre, `--radius-md`, `--shadow-md`, `padding: --space-3 --space-4`,
  max width `min(420px, 100vw - 24px)`, `--text-sm`/`--text-base`; success
  and error carry an icon, not only colour; error uses `--danger` border *and*
  text colour that passes 4.5:1. Auto-dismiss duration stays JS-owned;
  `Undo` is a secondary text button inside the toast (>= 44px target).
* Stays above any dialog footer via the z-scale rather than the
  `toast-above-dialog` / `totp-toast-open` overrides *(follow-up to evaluate)*.
* Empty states: one component (`.empty-state-card`): icon/mark, `h2`
  `--text-xl`, one sentence, **one primary action** that creates the first
  item; used in notes, trash, search-no-results, agenda list, 2FA, secure
  send history, sessions/devices.
* Confirmation wording: title = verb + object ("Delete this note?"),
  body = consequence ("It can be restored from Trash for 30 days." only
  where true), confirm = verb ("Delete note"), cancel = "Cancel". No "Are you
  sure?" and no bare "OK"/"Confirm" for destructive actions.

---------------------------------------------------------------------------

## 5. Protected form fields (do NOT change)

These attributes drive password managers, passkey/conditional UI, the SRP
and key-derivation code paths and browser autofill. **A polish task must not
change, remove, add or reorder-in-a-way-that-changes** the `id`, `name`,
`type` or `autocomplete` of the fields below, and must not wrap a field in
another `<form>`, change `novalidate`, or move the submit handlers
(`type="button"` + `id` hooks used by `auth-pages.js`, `app.js`,
`auth-native-submit-guard.html`). Labels, classes, wrapper elements, hints and
ordering of *visual* chrome may change; the JS looks the fields up by id.
Attributes not listed (e.g. `required`, `aria-*`, `spellcheck`, `inputmode`,
`placeholder`) are visual/accessibility and may be refined, but the
`aria-describedby` targets must keep existing ids. Values reflect
commit `67c2ea8`.

| Screen | File | `id` | `name` | `type` | `autocomplete` |
|---|---|---|---|---|---|
| Sign in: email | `app/templates/login.html:28` | (none) | `email` | `email` | `username` |
| Sign in: password | `login.html:32` | `login-password` | (none) | `password` | `current-password` |
| Sign in: recovery code | `login.html:38` | `login-recovery-code` | (none) | `text` | `off` |
| Sign in: form / submit | `login.html:26,50` | form `login-form`; button `login-submit` (`type=button`) | | | |
| Register: email | `app/templates/register.html:26` | `register-email` | `email` | `email` | `email` |
| Register: password | `register.html:32` | `register-password` | (none) | `password` | `new-password` |
| Register: confirm password | `register.html:45` | `register-password2` | (none) | `password` | `new-password` |
| Register: terms | `register.html:51` | `register-terms` | `terms` | `checkbox` | (none) |
| Register: recover ack | `register.html:56` | `register-recover-ack` | `recover_ack` | `checkbox` | (none) |
| Register: honeypot | `register.html:63` | `register-company` | `company` | `text` | `off` (must stay hidden off-screen via `.hp-field`, `tabindex=-1`) |
| Register: form / submit | `register.html:24,73` | form `register-form`; button `register-submit` | | | |
| Unlock: vault password | `app/templates/app.html:585` | `unlock-password` | (none) | `password` | `current-password` |
| Unlock: form / submit | `app.html:583,598` | form `unlock-form` (`autocomplete="off"` on the form); `unlock-submit` | | | |
| Change vault password: current | `app.html:1906` | `password-change-current` | (none) | `password` | `off` (stays `readonly`) |
| Change vault password: new | `app.html:1910` | `password-change-new` | (none) | `password` | `new-password` |
| Change vault password: confirm | `app.html:1916` | `password-change-confirm` | (none) | `password` | `new-password` |
| Change vault password: submit | `app.html:1921` | `btn-change-password` | | | |
| 2FA at sign-in (code) | `app/templates/totp.html:18` | (none) | `code` | `text` | `one-time-code` (keep `inputmode=numeric`, `pattern`, `maxlength=6`) |
| Receive a secure send: passphrase | `app/templates/receive.html:25` | `receive-passphrase` | (none) | `password` | `off` |

Related fields that reuse the same patterns and are also treated as protected
(same reasoning; they are used for recovery/verification flows):

| Field | `id` | `type` | `autocomplete` |
|---|---|---|---|
| Disable 2FA: password | `totp-disable-password` (`app.html:1942`) | `password` | `current-password` |
| Disable 2FA: code | `totp-disable-code` (1946) | (default text, `inputmode=numeric`) | `one-time-code` |
| Account email verification code | `account-verify-code` (1678) | (default text) | `one-time-code` |
| Backup email / verify code | `backup-email` (2072) `email`/`email`; `backup-verify-code` (2077) | | `email` / `one-time-code` |
| Note lock password | `note-lock-password` (1459) | `password` | `current-password` |
| Attachment repair password | `attachment-repair-password` (1960) | `password` | `current-password` |
| pCloud account | `pcloud-username` (2117) | `email` | `username` |
| Secure send passphrase | `secure-send-passphrase` (2203) | `password` | `new-password` |
| Device recovery phrase / start code | `device-phrase-input` (1871) `text`/`off`; `device-start-code-input` (1746) `text`/`off` | | |

Also protected: the `id`s of all show/hide toggles' `data-target` values
(`register-password`, `register-password2`, `password-change-new`,
`password-change-confirm`), and the **recovery** entry points
(`login-recovery-block`, `login-toggle-recovery`, `login-recovery-submit`,
`unlock-recovery-hint`, `unlock-signout`, `unlock-clear-saved`,
`unlock-empty-retry`).

Review checklist for any follow-up PR touching these templates:
1. `git diff` shows no change on the attributes above (grep for the id and compare).
2. Password managers still offer save/fill on `login.html` (email field keeps
   `autocomplete="username"` next to a `current-password` field).
3. Registration still offers "suggest password" (both fields `new-password`).
4. The honeypot remains invisible and non-focusable.

---------------------------------------------------------------------------

## 6. Rollout plan (one small task per area)

Order and contents; each task is reviewed and merged on its own, checked in a
real browser at phone (~375px) and desktop (~1280px) width in light and dark,
and, for CSS under `app/static`, followed by
`scripts/build-client-manifest.py`.

1. **Tokens**: add the variables from section 3 to one `:root` + one light
   block, merge the duplicate light block (1.2), add `color-scheme`, no
   visible changes except the contrast fixes in 3.3. Add `--focus-ring` rule
   and reduced-motion guard.
2. **Buttons**: `.btn` base + variants + states from 4.1; migrate one-off
   button classes (2.1 list) onto them.
3. **Dialogs + toast**: shared structure, focus-trap helper, Escape = cancel,
   transitions + reduced motion, z-scale, toast roles (4.3, 4.4). The JS part
   is behaviour-adjacent: keep it minimal and test Escape/focus per dialog
   (`confirmAction` first).
4. **Notes list and editor** (2.3), including attachments/OCR (2.4).
5. **Agenda** (2.5), event dialog, subscriptions.
6. **2FA** (2.6) and **secure send** (2.7).
7. **Sign-in / registration / unlock / recovery** (2.2): visual only, honour
   section 5.
8. **Settings, sessions, devices** (2.8) and the empty-state/wording pass (4.4).

Out of scope for all tasks: encryption, sync, storage, protected paths, new
libraries, fonts, network requests, `.github/`, `deploy/`, release files.

---------------------------------------------------------------------------

## 7. Layoutplan app-shell

Layout plan for the restructure of the app shell (idea #105). Presentation
only: no feature is removed, no id or data attribute is renamed, and nothing
in encryption, sync, storage, API or the data model changes. All values use
the tokens of section 3. `tests/e2e_layout_actions.py` reads the table in 7.2
and fails when a control disappears, loses its accessible name or becomes
unreachable, so every follow-up task must keep it green (and update the
"Reach" column in the same change when a control moves into another menu).

### 7.1 Target structure

Today (desktop): top bar with `#app-tab-notes` / `#app-tab-agenda` /
`#app-tab-2fa`, under it a loose `#btn-drawer-close` ("Close"), an icon rail
(`#filters` on top, five boxed buttons at the bottom), the list pane, and the
editor. Target, shared by Notes, Agenda and 2FA:

```
+--------------------------------------------------------------------+
| Top nav: Notes | Agenda | 2FA            (one navigation level)    |
+----------+----------------+----------------------------------------+
| Sidebar  | List column    | Content column                         |
| icon +   | (Notes only;   | header, toolbar, body/viewer, footer   |
| label    | resizable)     | max reading width, centred             |
+----------+----------------+----------------------------------------+
```

1. **One navigation level.** The tab bar (`role="tablist"`) is the only
   area switch. No second "Notes" heading and no loose "Close" button on
   desktop: `#btn-drawer-close` stays in the DOM and is only shown where the
   sidebar is an overlay drawer (tablet/phone).
2. **One sidebar.** Sections as rows of icon + label in one visual style
   (`.btn ghost`, `--touch-min` high): views (`#filters`), Folders, Tags, then
   a footer group (Secure Send, Settings, Lock, Account info, Sync). It
   collapses to icons only; `#btn-nav-pin` becomes the collapse/expand toggle.
   The toggle is a disclosure button: its accessible name and `title` are the
   fixed text "Expand/Collapse sidebar" (on Notes, Agenda and 2FA alike), and
   `aria-expanded` carries the state. `aria-expanded="true"` means the sidebar
   is pinned open (`body.nav-pinned`, stored as `navPinned`). It does not
   reflect the temporary hover or focus expansion of a collapsed sidebar, so
   while the pointer or focus opens it, `aria-expanded` stays `"false"`.
   Collapsed icons keep `aria-label` and get a `title` tooltip; the active
   view has `aria-current="page"` plus the accent background. Agenda and 2FA use the same sidebar frame for their own
   section actions (calendar menu; 2FA add/import/settings) so the frame does
   not jump between areas.
3. **List column** (Notes): 320px default, `min 260px`, `max 420px`,
   collapsible; header with search, sort, density, add document, new note.
4. **Content column**: fills the rest; inner content (header, toolbar, body,
   footer, backlinks) shares one left edge and is capped at
   `--content-max: 860px` for text notes and `1100px` for the viewer, centred
   when the column is wider.

Status (task 1b, shell frame): Agenda and 2FA use the same left column as
Notes at 1000px and wider (same `--sn-nav-width`, background and border). It
holds `#agenda-calendar-settings-btn` (Agenda) and, as a footer group,
`#btn-totp-lock`, `#btn-totp-settings` (2FA) as icon + label rows;
`#btn-totp-add` and `#btn-totp-import` sit right in the 2FA content header;
the labels collapse to icons while the sidebar is not pinned. The active tab
carries `aria-current="page"`. Below 1000px the Notes and 2FA controls stay
where they were. Agenda between 769px and 999px is the exception: the phone
layout ends at 768px (`isAgendaPhoneLayout()`), so the calendar menu button is
drawn as its own row above the agenda header, because the sidebar grid
(`.agenda-root:not(.agenda-root--phone)`) only applies from 1000px.
`tests/e2e_app_frame.py` measures this.

### 7.2 Every existing control and where it goes

Columns: selector (current id or stable selector, unchanged), accessible name
today (`aria-label`, else visible text), current place, new place, the screen
or note type it applies to (`all` = Notes, Agenda and 2FA; `notes` = plain and
PDF note; `plain`; `pdf`; `agenda`; `2fa`), and how it is reached today:
`visible`, `via` one or more visible openers clicked in order,
`conditional` (only shown in a state or viewport the desktop test does not
set up; the test then checks presence and accessible name only),
`phone-only` (the control is in the DOM but not shown on desktop: `phone via`
lists the openers at phone width, `desktop action via` lists the openers and,
last, the control that offers the same action on desktop; the test checks the
control at phone width and the action at both widths by clicking it and
looking at the note), or `by row kind` (per kind of list row, `normal`,
`trashed` and `locked`: `visible` on hover or focus, or `hidden` with the
openers and control that offer the action instead).

The last column, `Phone reach`, says how the same control is reached at
390x844 (phone), with the same syntax as `Reach`. It was worked out from the
media queries and markup, not copied from the desktop column: `visible`;
`via` the openers that are visible on phone, clicked in order (the sidebar
drawer is opened with `#btn-list-menu`, the note actions with
`#btn-editor-overflow-mobile`, the agenda menu with `#agenda-phone-more`);
`conditional: <state>` when the control is not shown at 390px or needs a state
(desktop-only controls such as `#btn-list-toggle` and `#btn-nav-pin`, controls
that a phone control replaces, long press or swipe on a row), the phone twin
being named in brackets; and the `phone-only` and `by row kind` forms. For
`by row kind` at phone width, `hidden` with `.note-swipe-delete` means the
row is swiped. The desktop checks do not read this column yet; the table parser
in `tests/e2e_layout_actions.py` exposes it as `phone_reach` and checks that
every row has a value that parses.

<!-- layout-actions:start -->
| Selector | Accessible name | Current place | New place | Applies to | Reach | Phone reach |
|---|---|---|---|---|---|---|
| `#app-tab-notes` | Notes | Top bar | Top nav | all | visible | visible |
| `#app-tab-agenda` | Agenda | Top bar | Top nav | all | visible | visible |
| `#app-tab-2fa` | 2FA | Top bar | Top nav | all | visible | visible |
| `#btn-drawer-close` | Close | Loose button under top bar | Sidebar header, shown only when sidebar is an overlay drawer | notes | conditional: overlay drawer (tablet/phone) | conditional: overlay drawer open and `#btn-list-menu` covered by it |
| `.filter[data-filter="all"]` | Notes | Icon rail, top | Sidebar: Views, icon + label | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="documents"]` | Files | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="pinned"]` | Starred | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="archived"]` | Archived | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="trash"]` | Trash | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="templates"]` | Templates | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `.filter[data-filter="untagged"]` | Untagged | Icon rail, top | Sidebar: Views | notes | visible | via `#btn-list-menu` |
| `#filter-section summary` | Views | Pinned sidebar, section label | Sidebar: Views section header | notes | via `#btn-nav-pin` | via `#btn-list-menu` |
| `#folder-section summary` | Folders | Pinned sidebar, section label | Sidebar: Folders section header | notes | via `#btn-nav-pin` | visible |
| `#btn-new-folder` | + New folder | Pinned sidebar, Folders | Sidebar: Folders section | notes | conditional: folders section open | via `#btn-list-menu` `#folder-section summary` |
| `#tag-section summary` | Tags | Pinned sidebar, section label | Sidebar: Tags section header | notes | via `#btn-nav-pin` | visible |
| `#btn-new-tag` | + New tag | Pinned sidebar, Tags | Sidebar: Tags section | notes | conditional: tags section open | via `#btn-list-menu` |
| `#btn-manage-tags` | Manage | Pinned sidebar, Tags | Sidebar: Tags section | notes | conditional: tags section open | via `#btn-list-menu` |
| `#btn-sync-now` | Sync now | Pinned sidebar, bottom | Sidebar: footer group | notes | via `#btn-nav-pin` | conditional: desktop only, not shown at 390px (phone: state text in `#sync-indicator`) |
| `#sync-indicator` | Waiting to sync (state text) | Sidebar head (phone) | Sidebar: footer group, next to Sync | notes | conditional: phone / sync state | visible |
| `#btn-secure-send-nav` | Secure Send | Icon rail, bottom (boxed) | Sidebar: footer group, icon + label | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-secure-send-head`) |
| `#btn-settings-nav` | Settings | Icon rail, bottom (boxed) | Sidebar: footer group | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-settings-head`) |
| `#btn-lock-nav` | Vault unlocked. Tap to lock. | Icon rail, bottom (boxed) | Sidebar: footer group | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-lock-head`) |
| `#btn-nav-pin` | Expand/Collapse sidebar | Icon rail, bottom (boxed) | Sidebar: collapse/expand toggle | notes | visible | conditional: desktop only, not shown at 390px |
| `#btn-account-info-nav` | Account info | Icon rail, bottom (boxed) | Sidebar: footer group | notes | visible | conditional: not shown at 390px (sidebar footer is desktop only) |
| `#btn-secure-send-head` | Secure Send | Sidebar head (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | visible |
| `#btn-lock-head` | Vault unlocked. Tap to lock. | Sidebar head (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | visible |
| `#btn-settings-head` | Settings | Sidebar head (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | visible |
| `#btn-account-info-head` | Account info | Sidebar head (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | conditional: not shown at 390px (hidden in the phone sidebar head) |
| `#btn-new` | New note | Sidebar head (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | conditional: not shown at 390px (phone: `#btn-new-list`) |
| `#btn-new-from-template` | New from template | Sidebar head (phone drawer) | Sidebar: Views, next to Templates | notes | conditional: phone | visible |
| `#filter-select` | Filter notes | Sidebar (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | visible |
| `#sort-select-sidebar` | Sort notes | Sidebar (phone drawer) | Unchanged (phone drawer) | notes | conditional: phone | conditional: desktop only, not shown at 390px (phone: `#btn-list-sort`) |
| `#btn-list-scan` | Add document | List header | List header | notes | visible | visible |
| `#btn-list-density` | Toggle list density | List header | List header | notes | visible | visible |
| `#sort-select` | Sort notes | List header | List header | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-list-sort`) |
| `#btn-new-list` | New note | List header | List header (primary) | notes | visible | visible |
| `#btn-list-menu` | Open sidebar | List header (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#btn-list-sort` | Sort: … Tap to change. | List header (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#btn-list-toggle` | Hide note list / Show note list | (new) | Divider between list and content: collapse/expand the list column | notes | conditional: desktop | conditional: desktop only, not shown at 390px |
| `#search` | Search notes and scanned documents | List header | List header, full width | notes | visible | visible |
| `#search-filter-toggle` | Search filters | In search field | In search field | notes | visible | visible |
| `#search-titles-only` | Titles only (label) | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-include-protected` | Include protected (label) | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-include-archived` | Include archived (label) | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-include-trashed` | Include trashed (label) | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-filter-clear` | Clear all | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-filter-apply` | Done | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `#search-filter-close` | Close filters | Search filter panel | Unchanged | notes | via `#search-filter-toggle` | via `#search-filter-toggle` |
| `.note-item` | note title (text) | List row | List row: icon, title + meta line, date | notes | visible | visible |
| `.note-row-more` | More actions for <title> | List row, right | List row, menu column | notes | visible | conditional: not shown at 390px (phone: long press on a row opens its menu) |
| `.note-row-delete` | Trash note <title> / Delete note <title> | List row, extra X on the row | Normal rows: List row "…" menu (X no longer a separate column, stays in the DOM with `data-in-menu`); trashed and locked rows have no "…" menu and keep the X | notes | by row kind: normal hidden, action via `.note-row-more` `#note-row-menu-trash`; trashed visible on hover or focus; locked visible on hover or focus | by row kind: normal hidden, action via `.note-swipe-delete`; trashed hidden, action via `.note-swipe-delete`; locked hidden, action via `.note-swipe-delete` |
| `#note-row-menu-secure-send` | Share by link | Row "…" menu | Row "…" menu | notes | via `.note-row-more` | conditional: phone, long press on a row |
| `#note-row-menu-trash` | Trash note <title> | (new home of the row X) | Row "…" menu | notes | via `.note-row-more` | conditional: phone, long press on a row |
| `.note-swipe-delete` | Trash note <title> | List row swipe (phone) | Unchanged (phone) | notes | conditional: phone swipe | conditional: phone swipe |
| `#fab-add` | New note | Floating button (phone) | Unchanged (phone) | notes | conditional: phone | conditional: not shown at 390px (phone: `#btn-new-list`) |
| `#fab-scan` | Scan document | Floating button (phone) | Unchanged (phone) | notes | conditional: phone | conditional: not shown at 390px (phone: `#btn-list-scan`) |
| `#btn-nav-menu` | Open sidebar | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#btn-back` | Back to notes | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#note-title` | Title | Editor head, shared row | Header: own line | notes | visible | visible |
| `#note-folder-select` | Folder | Editor head, large dropdown | Header: compact meta row | notes | visible | visible |
| `#tag-bar-toggle` | Tags … / Add tag | Editor head | Header: compact meta row | notes | visible | visible |
| `#tag-bar-input` | New tag (placeholder) | Tag bar, expanded | Header meta row, expanded | notes | via `#tag-bar-toggle` | via `#tag-bar-toggle` |
| `#tag-bar-add` | Add tag | Tag bar, expanded | Header meta row, expanded | notes | via `#tag-bar-toggle` | via `#tag-bar-toggle` |
| `#tag-bar-show-all` | Show assigned only | Tag bar, expanded | Header meta row, expanded | notes | via `#tag-bar-toggle` | via `#tag-bar-toggle` |
| `#btn-prevent-edit` | Lock editing | Toolbar | Toolbar (equal-size, tooltip) | notes | visible | conditional: desktop only, not shown at 390px (phone: `.editor-mobile-proxy[data-editor-proxy="btn-prevent-edit"]`) |
| `#note-editor-type` | Note type | Toolbar | Toolbar; hidden for attachment-only notes | plain | visible | conditional: desktop only, not shown at 390px (phone: `#btn-note-type-menu`) |
| `#btn-find-desktop` | Find in note | Toolbar | Toolbar | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-find`) |
| `#btn-ai-chat` | Ask AI | Toolbar | Toolbar | notes | visible | via `#btn-editor-overflow-mobile` |
| `[data-editor-proxy="btn-star"].editor-desktop-star` | Star | Toolbar | Toolbar | notes | visible | via `#btn-editor-overflow-mobile` |
| `#btn-download-note` | Download note / Download file | Toolbar | Toolbar | notes | visible | conditional: desktop only, not shown at 390px (phone: `.editor-mobile-proxy[data-editor-proxy="btn-download-note"]`) |
| `#btn-editor-overflow-desktop` | More actions | Toolbar | Toolbar, last | notes | visible | conditional: desktop only, not shown at 390px (phone: `#btn-editor-overflow-mobile`) |
| `#find-input` | Find in note | Find bar | Find bar under toolbar | plain | via `#btn-find-desktop` | via `#btn-find` |
| `#find-case-toggle` | Match case | Find bar | Find bar | plain | via `#btn-find-desktop` | via `#btn-find` |
| `#find-prev` | Previous match | Find bar | Find bar | plain | via `#btn-find-desktop` | via `#btn-find` |
| `#find-next` | Next match | Find bar | Find bar | plain | via `#btn-find-desktop` | via `#btn-find` |
| `#find-close` | Close find | Find bar | Find bar | plain | via `#btn-find-desktop` | via `#btn-find` |
| `#btn-undo` | Undo | Toolbar "…" menu | Toolbar "…" menu; hidden for attachment-only notes | plain | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-redo` | Redo | Toolbar "…" menu | Toolbar "…" menu; hidden for attachment-only notes | plain | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-preview` | Edit / Preview | Toolbar "…" menu | Toolbar "…" menu | pdf | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-ocr-text` | OCR text | Toolbar "…" menu | Viewer toolbar ("Scanned text") and "…" menu | pdf | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-rescan-ocr` | Rescan with OCR | Toolbar "…" menu | Toolbar "…" menu | pdf | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-desktop-doc-fullscreen` | Fullscreen | Toolbar "…" menu | Viewer toolbar and "…" menu | pdf | via `#btn-editor-overflow-desktop` | conditional: desktop only, not shown at 390px (phone: the immersive viewer, opened from `#attachment-list .attachment-thumb`) |
| `#btn-note-info` | Note info | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-share` | Copy note | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-note-secure-send` | Share by link | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-star` | Star | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-pin` | Pin | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-archive` | Archive | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-duplicate` | Duplicate | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-save-template` | Save as template | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-trash` | Trash | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-editor-settings` | Settings | Toolbar "…" menu | Toolbar "…" menu | notes | via `#btn-editor-overflow-desktop` | via `#btn-editor-overflow-mobile` |
| `#btn-clear-checked` | Clear checked | Toolbar "…" menu | Toolbar "…" menu | notes | conditional: checklist notes | conditional: checklist notes |
| `#btn-delete-forever` | Delete forever | Toolbar "…" menu | Toolbar "…" menu | notes | conditional: note in trash | conditional: note in trash |
| `#btn-mobile-doc-attachment-share` | Share file | Toolbar "…" menu (phone) | Unchanged (phone) | notes | conditional: phone, file note | conditional: phone, file note |
| `#btn-note-type-menu` | Note type | Toolbar "…" menu (phone) | Unchanged (phone) | notes | conditional: phone | via `#btn-editor-overflow-mobile` |
| `#btn-editor-overflow-mobile` | More actions | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#btn-find` | Find in note | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `.editor-mobile-proxy[data-editor-proxy="btn-prevent-edit"]` | Lock editing | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `.editor-mobile-proxy[data-editor-proxy="btn-share"]` | Copy note | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `.editor-mobile-proxy[data-editor-proxy="btn-pin"]` | Pin | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | conditional: plain notes (not shown on PDF notes; `#btn-pin` stays in the menu) |
| `.editor-mobile-proxy[data-editor-proxy="btn-download-note"]` | Download note / Download file | Editor head (phone) | Unchanged (phone) | notes | conditional: phone | visible |
| `#btn-md-mode` | Preview | Markdown toolbar | Toolbar, second row for Markdown | plain | conditional: Markdown notes | conditional: Markdown notes |
| `#note-body` | Note text (placeholder) | Editor body | Content column, max reading width | plain | visible | visible |
| `#note-options-close` | Done | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-info-star` | Star | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-star`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-star` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-star` |
| `#note-info-pin` | Pin | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-pin`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-pin` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-pin` |
| `#note-info-share` | Copy note | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-share`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-share` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-share` |
| `#note-info-archive` | Archive | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-archive`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-archive` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-archive` |
| `#note-info-duplicate` | Duplicate | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-duplicate`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-duplicate` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-duplicate` |
| `#note-info-trash` | Move to trash | Note info panel, quick row (phone only; not shown on desktop) | Unchanged (phone only); desktop keeps the action in the toolbar "…" menu (`#btn-trash`) | notes | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-trash` | phone-only: phone via `#btn-editor-overflow-mobile` `#btn-note-info`; desktop action via `#btn-editor-overflow-desktop` `#btn-trash` |
| `#note-info-copy` | Copy | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-warn-at` | Warning date and time | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-warn-save` | Save | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-warn-clear` | Clear | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-info-share-bottom` | Copy note | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | conditional: desktop only, not shown at 390px (phone: `#note-info-share`) |
| `#note-info-server-copy` | View on server | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#note-info-protect` | Protect note | Note info panel | Unchanged | notes | via `#btn-editor-overflow-desktop` `#btn-note-info` | via `#btn-editor-overflow-mobile` `#btn-note-info` |
| `#doc-close` | Close preview | Full-screen viewer bar | Viewer toolbar (full screen) | pdf | via `#btn-editor-overflow-desktop` `#btn-desktop-doc-fullscreen` | conditional: desktop only, not shown at 390px (phone: `#doc-immersive-close`) |
| `#doc-zoom-out` | Zoom out | Full-screen viewer bar | Viewer toolbar, also inline | pdf | via `#btn-editor-overflow-desktop` `#btn-desktop-doc-fullscreen` | conditional: desktop only, not shown at 390px (phone: the immersive viewer) |
| `#doc-zoom-reset` | Reset zoom | Full-screen viewer bar | Viewer toolbar, also inline (fit width) | pdf | via `#btn-editor-overflow-desktop` `#btn-desktop-doc-fullscreen` | conditional: desktop only, not shown at 390px (phone: the immersive viewer) |
| `#doc-zoom-in` | Zoom in | Full-screen viewer bar | Viewer toolbar, also inline | pdf | via `#btn-editor-overflow-desktop` `#btn-desktop-doc-fullscreen` | conditional: desktop only, not shown at 390px (phone: the immersive viewer) |
| `#doc-download` | Download | Full-screen viewer bar | Viewer toolbar | pdf | via `#btn-editor-overflow-desktop` `#btn-desktop-doc-fullscreen` | conditional: desktop only, not shown at 390px (phone: `#doc-immersive-share`) |
| `#doc-gallery-prev` | Previous item | Full-screen viewer bar | Viewer toolbar | pdf | conditional: note with several files | conditional: note with several files |
| `#doc-gallery-count` | Item position | Full-screen viewer bar | Viewer toolbar | pdf | conditional: note with several files | conditional: note with several files |
| `#doc-gallery-next` | Next item | Full-screen viewer bar | Viewer toolbar | pdf | conditional: note with several files | conditional: note with several files |
| `#doc-enhance-toggle` | Enhance | Full-screen viewer bar | Viewer toolbar | pdf | conditional: image files | conditional: image files |
| `#doc-share` | Share | Full-screen viewer bar | Viewer toolbar | pdf | conditional: device with share sheet | conditional: device with share sheet |
| `#doc-immersive-share` | Download | Immersive viewer (phone) | Unchanged (phone) | pdf | conditional: phone | conditional: device with share sheet or file download, immersive viewer open |
| `#doc-immersive-close` | Close preview | Immersive viewer (phone) | Unchanged (phone) | pdf | conditional: phone | via `#attachment-list .attachment-thumb` |
| `#attachment-list .attachment-thumb` | Preview <file> | Attachment row (edit view) | Attachment row | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` | visible |
| `#attachment-list button[data-preview]:not(.attachment-thumb)` | Preview | Attachment row (edit view) | Attachment row | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` | visible |
| `#attachment-list button[data-dl]` | Download | Attachment row (edit view) | Attachment row | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` | visible |
| `#attachment-list button[data-rm]` | Remove | Attachment row (edit view) | Attachment row | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` | visible |
| `#attachment-list .attachment-overflow summary` | More file actions | Attachment row (edit view) | Attachment row | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` | visible |
| `#attachment-list button[data-retry-ocr]` | Re-run OCR | Attachment row "⋯" | Attachment row "⋯" | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` `#attachment-list .attachment-overflow summary` | via `#attachment-list .attachment-overflow summary` |
| `#attachment-list button[data-server-copy]` | View on server for file | Attachment row "⋯" | Attachment row "⋯" | pdf | via `#btn-editor-overflow-desktop` `#btn-ocr-text` `#attachment-list .attachment-overflow summary` | via `#attachment-list .attachment-overflow summary` |
| `#agenda-prev` | Previous | Agenda toolbar | Content header, left | agenda | visible | visible |
| `#agenda-next` | Next | Agenda toolbar | Content header, left | agenda | visible | visible |
| `[data-agenda-goto]` | <range>. Go to date | Agenda toolbar | Content header, title | agenda | visible | visible |
| `#agenda-today` | Today | Agenda toolbar | Content header | agenda | visible | visible |
| `[data-agenda-view="month"]` | Month | Agenda view switch | Content header, view switch | agenda | visible | via `#agenda-phone-more` |
| `[data-agenda-view="week"]` | Week | Agenda view switch | Content header, view switch | agenda | visible | via `#agenda-phone-more` |
| `[data-agenda-view="3day"]` | 3 day | Agenda view switch | Content header, view switch | agenda | visible | via `#agenda-phone-more` |
| `[data-agenda-view="day"]` | Day | Agenda view switch | Content header, view switch | agenda | visible | via `#agenda-phone-more` |
| `[data-agenda-view="agenda"]` | List | Agenda view switch | Content header, view switch | agenda | visible | via `#agenda-phone-more` |
| `#agenda-search` | Search events | Agenda toolbar | Content header, right | agenda | visible | via `#agenda-phone-more` |
| `#agenda-calendar-settings-btn` | Calendar menu | Agenda toolbar | Sidebar section "Calendars" (and header button on phone) | agenda | visible | via `#agenda-phone-more` |
| `#agenda-add-task` | + Task | Agenda toolbar | Content header, right | agenda | visible | conditional: desktop only, not shown at 390px (phone: `#agenda-phone-more` `#agenda-phone-add-task`) |
| `#agenda-add-event` | + Event | Agenda toolbar | Content header, right (primary) | agenda | visible | conditional: desktop only, not shown at 390px (phone: `#agenda-fab-add`) |
| `#agenda-calendar-settings-close` | Close calendar settings | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-pref-show-tasks` | Show tasks (label) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-pref-show-completed` | Show completed (label) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-calendar-import-ics` | Import calendar (.ics) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-calendar-export-ics` | Export calendar (.ics) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-reminder-email` | E-mail reminders (label) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-reminder-push` | Push reminders (label) | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-open-app-settings` | Open app settings… | Calendar menu | Unchanged | agenda | via `#agenda-calendar-settings-btn` | via `#agenda-phone-more` `#agenda-calendar-settings-btn` |
| `#agenda-backup-restore` | Restore last local agenda backup | Calendar menu | Unchanged | agenda | conditional: local backup exists | conditional: local backup exists |
| `#agenda-reminder-enable-push` | Enable push on this device | Calendar menu | Unchanged | agenda | conditional: push not enabled yet | conditional: push not enabled yet |
| `#btn-totp-add` | Add account | 2FA header | Content header, right (primary) | 2fa | visible | visible |
| `#btn-totp-import` | Import accounts | 2FA header | Content header, right | 2fa | visible | visible |
| `#btn-totp-lock` | Lock vault | 2FA header | Sidebar: footer group (own button, same lockVault action as Notes `#btn-lock-nav`) | 2fa | visible | visible |
| `#btn-totp-settings` | Settings | 2FA header | Sidebar: footer group (same Settings as Notes) | 2fa | visible | visible |
| `#totp-search` | Search accounts (…) | 2FA header | Content header, full width | 2fa | visible | visible |
| `[data-totp-copy]` | Copy code for <account> | 2FA account row | Unchanged | 2fa | visible | visible |
| `[data-totp-edit]` | Edit <account> | 2FA account row | Unchanged | 2fa | visible | visible |
| `[data-totp-remove]` | Remove <account> | 2FA account row | Unchanged | 2fa | visible | visible |
<!-- layout-actions:end -->

Not interactive but part of the layout and kept: `#save-status`, `#note-meta`
(footer), `#backlinks` ("Linked from"), `#doc-inline` (inline viewer),
`#toast`. Hidden file inputs (`#attachment-input`, `#scan-input`,
`#scan-camera`, `#totp-qr-input`, `#totp-import-file`, `#agenda-ics-input`)
stay where they are; their visible triggers are listed above. Settings,
Secure Send, the agenda event editor and the 2FA add/import dialogs are
dialogs (section 4.3), not shell, and do not move.

### 7.3 Note list rows

One grid for every row, regardless of note type:
icon/thumbnail | title + meta line | date | "…" menu.

- Column 1 is always `--note-row-icon-col` (44px) wide; a PDF/image thumbnail
  is sized into it, so titles of plain and PDF notes start on the same x.
- Line 1: title (one line, ellipsis). Line 2 (meta line, `--text-sm`,
  `--text-muted`): type label (Note, PDF, IMG, Checklist, …), then the
  lock/read-only state as a badge (`.note-lock-badge`, text "Protected" /
  "Read only" plus `aria-label`; not a loose emoji), then tag chips; all on
  one baseline, overflow clipped with "+n".
- Compact density keeps its behaviour: the meta line (and so the badge) is
  hidden, and the small lock glyph next to the date stays as the only lock
  marker. The glyph is shown only in compact density.
- Date column: right-aligned, tabular numbers, one notation (7.4).
- Menu column: only `.note-row-more`. Its menu has "Trash"
  (`#note-row-menu-trash`, same action as the X). On rows that have the menu
  `.note-row-delete` stays in the DOM (`data-in-menu`) but is not shown;
  rows without the menu (trashed, locked) keep the X on hover/focus.
- Group headers (Today, Yesterday, This week, Older) are rendered only when
  the group has at least one row.

### 7.4 Date notation

One rule for list row dates (`listTimeLabel`): relative for the last 7 days
("just now", "5m ago", "3h ago", "2d ago"); older dates in one fixed notation,
`toLocaleDateString(undefined, { day: 'numeric', month: 'short', year:
'numeric' })` ("3 Nov 2026" in en-GB, "Nov 3, 2026" in en-US). No numeric
`dd/mm/yyyy`. The full date and time is in the `title` attribute. No new
library. Covered by `tests/test_note_list_grid.py`.

### 7.5 Note header and toolbar

- Title (`#note-title`) on its own line, `--text-xl`.
- Under it one compact meta row: folder (`#note-folder-select`, max 220px,
  `--text-sm`) and then tags (`#tag-bar-toggle`), same height (32px). A note
  without tags shows the toggle as a quiet "+ Add tag" button instead of
  "Tags None"; opening it puts the tag bar on its own line under the folder.
  Below 1000px folder and tags keep their full-width rows.
- One toolbar: every button 36x36px with `--radius-sm`, `aria-label` plus
  `title` tooltip; DOM and tab order: lock editing, note type, find, Ask AI,
  star, download, "…". The note type select is as high as the buttons and
  shows its value as text.
- Controls that do not apply to the current note type are hidden instead of
  idle: the note type control (`#note-editor-type`, on the phone
  `#btn-note-type-menu`), `#btn-undo` and `#btn-redo` while an attachment note
  shows its document view (`.editor.doc-preview-active`); they return when
  the note text is edited ("Edit" in the "…" menu). `#btn-preview`,
  `#btn-ocr-text`, `#btn-rescan-ocr` and `#btn-desktop-doc-fullscreen` are not
  shown for notes without a file. The action keeps its id and stays available
  where it applies (column "Applies to" in 7.2).
- Test: `python tests/e2e_layout_actions.py` measures both note types (title
  line, meta row, button size, tooltip, aria-label, tab order, hidden
  controls) and changes the format of a plain note through the select.

### 7.6 Attachment / PDF viewer

- Default zoom is fit-to-width of the viewer column (never cropped), page
  centred on a neutral background (`--surface-2`), no coloured edge.
- A viewer toolbar above the inline viewer (`#doc-inline`) with: zoom out,
  zoom level / reset to fit width, zoom in (reuse the behaviour of
  `#doc-zoom-out`, `#doc-zoom-reset`, `#doc-zoom-in`), page indicator
  "n / N" (`aria-live="polite"`), full screen (`#btn-desktop-doc-fullscreen`),
  download, and "Scanned text" (`#btn-ocr-text`). OCR text access stays, both
  here and in the "…" menu.
- Full screen keeps `#doc-viewer` with `#doc-close`, gallery and enhance
  controls as today; Escape closes.

**As built (inline viewer, `doc-inline-controls.js`).** The renderer is
unchanged: pdf.js paints each page to a canvas at 100% of `.doc-inline-stage`,
and decryption/OCR are untouched. That mechanism has no page-level zoom, so
the safe variant is a CSS width on the stage: fit width = 100% (the default,
never wider than the column), zoom steps x1.25 between 50% and 300% (canvases
are rendered at 2x or more, so 300% is the sharpness limit). The page
indicator is derived from the scroll position (`n / N`, `aria-live`). Full
screen uses the Fullscreen API on `.doc-inline-card` (Esc exits; the button is
omitted where the API is missing). Every button is a native `<button>` with
`title` and `aria-label`.

Root cause of the cut-off, off-centre page: the phone and desktop
`.editor.doc-preview-active .doc-inline-stage` rules made the stage a
transparent, left-aligned block with `overflow: visible`, so nothing centred
the page or scrolled a wider one. The viewer now has a neutral
`var(--doc-surface)` background on `.doc-inline-main`, which scrolls
horizontally (`overflow-x: auto`), and the stage is `margin-inline: auto`.

Object URLs: the PDF path hands bytes to pdf.js (`openPdf(bytes)` in
`preview.js`), so the viewer itself creates no blob URL (the e2e measures at most one live
URL while open: the note-list thumbnail of page 1, and none after the viewer
closes or switches). Image and thumbnail URLs go through `NotesBlobUrls`, which calls `URL.revokeObjectURL` on `revoke()`
(cache eviction, viewer close/switch) and `revokeAll()` (lock, logout). The
pdf.js worker blob URL is app-lifetime and holds no user data.

Tests: `node tests/test_doc_inline_controls.js` (controls + CSS contract),
`node tests/test_blob_urls.js` (revoke), and
`python tests/e2e_doc_inline_viewer.py [dir]` (real Chromium, desktop and
390px mobile: fit width, centring, no overflow, zoom, horizontal reach,
toolbar click does not open the full viewer, full screen open/close, no live
blob URLs; writes screenshots). The e2e script needs Chromium and is not part
of the Node test run (`tests/test_*.js`); it is run manually, and it holds the
only real layout check (page not wider than its container). The Node test only
covers the CSS contract and a DOM stub.

### 7.7 Footer and backlinks

- Status line (`#save-status` left, `#note-meta` right) uses the same left
  and right edge as the content column.
- Word count only for notes with a text body; an attachment-only note shows
  "Scanned text: n words" and the date, not "0 words".
- "Linked from" (`#backlinks`) aligns with the content; with zero backlinks
  it is collapsed to one muted line ("Linked from (0)") without the
  empty-state sentence; with one or more it is expandable and open.

**Status (footer/width task):** `#note-meta` omits "0 words" when the note has
attachments (the scanned-text count stays); `#backlinks[data-empty="true"]`
shows only the muted heading; footer and backlinks use the body's 32px edge and
`--content-max` (`--content-max-viewer` for the viewer). The `#pane-splitter`
has a visible grip and keyboard support; `#btn-list-toggle` collapses the list.
Width (`listPaneWidth`) and `listCollapsed` live in the local
`deeperguard-prefs` only, never sent to the server.

### 7.8 Breakpoints

| Width | Sidebar | List column | Content |
|---|---|---|---|
| 1920px and wider | expanded (icon + label), 240px | 360px | centred, capped at `--content-max` |
| 1440px | expanded, 220px | 320px | capped at `--content-max` |
| 1280px | collapsed to icons (56px) unless pinned | 300px | fills remaining width |
| Tablet (700-999px) | overlay drawer (`#btn-nav-menu`, `#btn-drawer-close`) | 280px | fills remaining width |
| Phone (below 700px) | overlay drawer | full width; opens the note full screen with `#btn-back` | full width; FABs and mobile toolbar as today |

The phone layout keeps working as it does now; the existing >=1000px rule
(section 1.3) stays the desktop switch.

Below 1000px "Linked from" (`.backlinks`) uses the same `--space-4` inset as
the Attachments and Version history labels. Below 600px the 2FA title and
account count take their own row above the 2FA buttons, and the PDF viewer
controls (zoom, fit width, page, full screen) use tighter gaps so they fit on
one row at 390px (they still wrap on narrower screens).

`tests/e2e_layout_no_hscroll.py` checks Notes (plain and PDF note), Agenda
and 2FA at 1280, 1440, 1920, 820 and 390 (390x844). It fails on page-level
horizontal scroll and also on shown content past the right edge that an
`overflow: hidden`/`clip` container cuts off. Without that second check the
`overflow: hidden` on html/body and `overflow-x: hidden` on the compact
`.app-root` would hide such content from the scroll check.

### 7.9 Order of the follow-up tasks

Each task ships on its own, leaves no half-converted screen, keeps
`tests/e2e_layout_actions.py` and all existing tests green, and attaches
before/after Playwright screenshots (plain note, PDF note, Agenda, 2FA;
desktop and phone; synthetic data only).

1. **Shell**: top nav + one sidebar frame for Notes, Agenda and 2FA (7.1).
2. **List**: row grid, meta line, dates, no empty group headers (7.3, 7.4).
3. **Header/toolbar**: title line, meta row, equal buttons, type-specific
   hiding (7.5).
4. **Viewer**: fit width, centred, zoom, page indicator, full screen (7.6).
5. **Footer/width**: status line, backlinks, maximum reading width (7.7).
6. **Responsive check**: 1280, 1440, 1920+, tablet, phone (7.8).

### 7.10 Screenshot suite

`tests/screenshot_layout_suite.py` produces the before/after screenshots
for the tasks above. It starts a local server, signs up a throwaway
account and creates synthetic data only (one plain note, one PDF note, a
few agenda events, three 2FA entries with made-up secrets). It then saves
full-page PNGs of Notes (plain note), Notes (PDF note), Agenda and 2FA at
five viewports: 1280x800, 1440x900, 1920x1080, 820x1180 (tablet) and
390x844 (phone).

    python tests/screenshot_layout_suite.py --out <dir>

The files are named `<screen>-<width>.png` with screen `notes-plain`,
`notes-pdf`, `agenda` or `2fa` (20 files, for example
`notes-pdf-390.png`). Without `--out` they go to `layout-screenshots/` in
the current directory, which is git-ignored. Do not commit the PNGs; attach
them to the pull request instead.

---------------------------------------------------------------------------

## 8. Inventory status (audit task 113)

Every point of section 2, marked **Resolved** or **Exception** (deliberately
left as it is, with the reason). Resolved points were fixed by the per-area
tasks of section 6 or by this audit (8.10). Contrast is measured, see 8.11.

### 8.1 Cross-cutting (2.1)

| Point | Status |
|---|---|
| Radius literals (`border-radius: Npx`) | Exception: polished rules use `--radius-*`; other literals stay so unpolished corners keep their shape. |
| `.settings-row select` 14px/8px | Resolved: `--text-md`, `min-height: var(--touch)`, `--radius-sm`. |
| `.btn` without min-height; `.note-warn-buttons .btn` 40px | Resolved: `.btn { min-height: var(--touch) }`; note-warn buttons `var(--touch)` (8.10). |
| `ghost`/`subtle` variants | Resolved: one state set for primary, secondary, danger, icon-only (4.1). |
| `.btn.danger` hard-coded red border | Resolved: `color-mix` of `--danger` (8.10). |
| Hover only on some variants, no `:active` | Resolved: shared hover and pressed states. |
| Disabled / `aria-disabled` | Resolved: shared disabled rule. |
| One-off button classes | Exception: kept for their layout; they get the ring of the shared `:where(button, ...)` rule and pass 8.11. |
| Swatches 28px, check boxes 36px | Exception: above the 24px minimum of WCAG 2.5.8 (AA). |
| Input focus ring (`--accent-soft`) | Resolved: 2px `--focus-ring` outline (8.10). |
| Focus removed without replacement | Resolved for `.label-menu` items, `.check-text`, search pill (8.10). Exception: agenda date fields and `.note-warn-field` (ring via `:focus-within` on the container), `.pane-splitter` (`::after`), sidebar sort/filter selects (accent border plus halo), `mark.search-hit-current` (not focusable). |
| Ring colours; `#4f8cff` fallback | Resolved: `--focus-ring` (8.10). |
| Four label looks | Exception: each family is consistent within itself; merging is a markup restructure. |
| Error text without `role=alert` | Resolved: six error paragraphs now have `role="alert"` (8.10). |
| No visible required marker | Exception: not added; `required`/`aria-required` stay. |
| Select chevron, date wrappers | Exception: native controls; `color-scheme` follows the theme. |
| Three checkbox implementations | Exception: kept. |
| Heading weights 650/680 | Exception: kept so headings do not visibly change; dialog titles use `--text-lg`. |
| Font sizes below 13px | Exception: 12px (`--text-xs`) for timestamps, badges, short hints; all pass 8.11. |
| Contrast table | Resolved: 8.11. |
| `#toast` without role | Resolved: 8.9. |
| Password toggle label | Resolved: switches between "Show password" and "Hide password" (`app.js`, `auth-pages.js`). |
| `#agenda-import-preview` `aria-label`; empty `#doc-viewer` body; `role="searchbox"` | Exception: valid names; the viewer is filled on open; redundant role is harmless. |

### 8.2 Sign-in, registration, recovery, unlock (2.2)

| Point | Status |
|---|---|
| Slate hard-codes on auth pages | Exception: auth pages set `data-theme` on `<html>` only and use the slate layer consistently; pass 8.11. |
| `.auth-card` radius/padding | Exception: kept recognisable. |
| Secondary actions on sign-in and unlock | Exception: one primary per form; recovery paths stay visible (section 5). |
| Long hints | Exception: protected recovery wording. |
| Register error spacing, `.consent-row` | Exception: protected form (section 5). |
| Password toggle height | Resolved: shared 44px `.btn`. |
| `totp.html` code input name | Exception: named by its wrapping `<label>`. |
| `p.error` contrast | Resolved: 8.11. |

### 8.3 Notes list and editor (2.3)

| Point | Status |
|---|---|
| Padding and gap differences | Exception: kept per component; list, attachments and empty state use `--space-*`. |
| Icon button sizes, label menu | Resolved: 44px on touch; label menu ring (8.10). |
| Three lock implementations | Exception: separate buttons with own ids. |
| Syntax token colours | Exception: syntax palette per theme. |
| Empty state | Resolved: one primary action. |

### 8.4 Attachments and OCR (2.4)

| Point | Status |
|---|---|
| Scan-sheet handle | Exception: `aria-hidden`, visual only. |
| Sheet paddings and shadows | Resolved: shared dialog parts and `--shadow-*`. |
| `.doc-viewer-tools` hidden scrollbar | Exception: every tool is a button reachable with Tab. |
| `.doc-viewer .btn.ghost` | Exception: dark viewer surface. |
| Progress dialogs | Exception: non-cancellable by design (4.3). |
| Feedback via toast | Resolved: OCR progress/error inline; toast 8.9. |

### 8.5 Agenda (2.5)

| Point | Status |
|---|---|
| Dialog builds, z-index patches | Exception: own stacking rules; focus trap and Escape come from `dialog-a11y.js`. |
| Editor heading | Resolved by the agenda editor task. |
| Scope chooser action order | Exception: stacked, primary on top (phone rule of 4.3). |
| Swatches | Exception: 8.1. |
| Date input `outline: none` | Exception: `:focus-within` on the container. |
| "Esc" shortcut | Resolved: Escape closes dialogs. |
| Editor rhythm, subscriptions | Resolved by the agenda editor task. |
| Reduced motion | Resolved: transitions off under `prefers-reduced-motion`. |

### 8.6 2FA (2.6)

| Point | Status |
|---|---|
| Sheets vs full-screen camera | Exception: the camera needs the screen. |
| 2FA-only toast style | Resolved: shared style; the pane only reserves room under the list (8.9). |
| Code and copy affordance | Resolved by the 2FA polish task. |
| Import password without toggle | Exception: a toggle needs new behaviour. |
| Implicit labels | Exception: valid names. |
| Empty state | Resolved: `#totp-empty` with `#btn-totp-add` as primary. |

### 8.7 Secure send (2.7)

| Point | Status |
|---|---|
| Rules inside the `.btn` block | Exception: source order only. |
| "×" remove glyph | Exception: named by `aria-label="Remove <file>"`. |
| Detail sheet vs panel | Exception: different purpose. |
| 12px hints with opacity | Resolved: opacity removed; passes 8.11. |
| `receive.html` | Resolved: one primary action; passes 8.11. |

### 8.8 Settings, sessions, devices (2.8)

| Point | Status |
|---|---|
| `.settings-group > h3` muted | Resolved: `--text`. |
| Rows at 360px | Resolved by the settings polish task (390px browser test). |
| `.settings-row select` | Resolved: 8.1. |
| Mixed button forms | Exception: primary marks each group's main action. |
| `#password-change-error` role | Resolved (8.10). |
| Danger zone outline | Exception: the confirm that follows uses the filled danger button. |
| `.settings-hint` roles | Exception: modifier classes kept. |
| Drawer close location | Exception: drawers keep their header close. |

### 8.9 Dialogs, toasts, confirmations (2.9)

| Point | Status |
|---|---|
| Escape, focus trap, focus restore | Resolved: `dialog-a11y.js` (4.3). |
| Header close X | Exception: only `#confirm-dialog` uses `.dialog-pattern`; others close via Escape, backdrop and Cancel/Done. |
| Action order | Exception: 8.5. |
| Transitions, reduced motion | Resolved (4.3). |
| `.confirm-dialog` max-height | Resolved for `#confirm-dialog` (`.confirm-dialog.dialog-pattern` has a max-height and a scrolling body). Exception: the other `.confirm-dialog` users keep their layout. |
| Backdrop colours | Exception: kept per family. |
| **Toast** | Resolved: one `.toast` rule set (`--radius-md`, `--shadow-lg`, `--text-base`, spacing tokens), fixed bottom-centre. `#toast` is `role="status"` `aria-live="polite"`; `toast(message, true)` switches it to `role="alert"` `aria-live="assertive"` and shows a "!" mark, so errors do not rely on colour. 2FA no longer restyles it. It still moves up, same style, to clear a dialog footer or the settings sheet, and is hidden while the agenda editor is open (behaviour of earlier tasks). |
| Confirm wording, bare "OK" | Resolved: `#account-info-close` reads "Close"; destructive callers pass a verb. The default "Confirm" stays for callers that pass none. |

### 8.10 Changed by this audit

`app.css`: filled buttons use fill tokens (`--accent-fill` `#2f6fe4` in dark,
`--danger-fill`, `--success-fill`) so white labels pass 4.5:1, while
`--accent`/`--danger`/`--success` keep their values for text and icons; light
`--muted` and `--sn-nav-muted` become `#6b6b73`; plan badges, the read-only
banner and the light `.zk-badge` get readable text colours; one toast rule
set with an error mark; focus ring on inputs, the search pill, `.label-menu`
items and `.check-text`; `.btn.danger` border; 44px note-warn buttons.
`app.html`: `role="alert"` on `#password-change-error`, `#note-lock-error`,
`#device-start-code-error`, `#attachment-repair-error`, `#scan-name-error`,
`#account-info-error`; "Close" on `#account-info-close`. `app.js`:
`setToastRole()` sets only `role`/`aria-live` on `#toast`. This is the only
JavaScript change in this audit, not a CSS, markup or text change: `role="alert"`
for error toasts needs it, and it changes no other behaviour.

### 8.11 How it is checked

`tests/test_ui_contrast_browser.py` renders the real templates (`app.html`
locked and unlocked with every `hidden` region shown, `login.html`,
`register.html`, `totp.html`, `receive.html`) with the real `app.css` in
Chromium at 390px and 1280px, light and dark, plus every `.btn` variant that
`app.js` adds at runtime. It fails on visible text or form controls below
4.5:1 (3:1 for large text and `aria-hidden` glyphs; disabled controls are
exempt), checks the toast (role, position, style; normal and error; Notes
and 2FA) and the focus ring of text fields. `python3
tests/test_ui_contrast_browser.py` lists every failing element.
