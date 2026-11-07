# Calendar sharing (research — not implemented)

Deeperguard Agenda today stores events in the vault as ciphertext inside the single `agenda_pack` item (`store.js`: one encrypted blob synced like notes). **There is no calendar sharing, webcal subscription, or multi-user ACL in the product today.** ICS import/export is **file handoff**, not live collaboration.

## Goal (if we add E2EE sharing later)

Let an owner share **read-only** or **read/write** access to a calendar namespace with another vault user, without the server learning titles, times, or locations.

## Architecture options (tradeoffs)

### A. Per-calendar symmetric key in the vault (recommended sketch)

- **Data model:** Introduce `calendar_id` → encrypted calendar metadata + event rows still E2EE, wrapped with a **calendar key** `K_cal` stored only in ciphertext envelopes addressed to participants.
- **Viewer vs editor:**
  - **Viewer:** receives `Wrap(K_cal, K_viewer_pub)` via an **invitation** row (out-of-band or in-app).
  - **Editor:** receives the same key with a higher ACL bit, or a child key derived `K_edit = HKDF(K_cal, "edit")` only distributed to editors.
- **Invitations:** Signed invitation objects (owner’s device signs with a long-term device key) uploaded as opaque blobs; recipient accepts → adds wrapped key to their vault.
- **Revocation:** Owner rotates `K_cal` → re-wraps only for remaining members; old envelopes invalid; clients purge on next sync.
- **Metadata:** Server sees ciphertext only; optional **private** membership index encrypted with owner key for UI.
- **Conflicts:** Last-writer-wins per event UUID with `updated_at` + optional CRDT for recurring series (high complexity); start with deterministic merge + conflict UI.

**Pros:** Fits existing vault sync. **Cons:** Invitation flow, key rotation UX, and backup when owner loses device need careful design.

### B. MLS / pairwise channels

Group key agreement per calendar — stronger membership privacy, more engineering. Likely overkill for first iteration.

## What this PR does *not* do

- No shared URLs, **webcal**, public feeds, or server-readable schedules.
- No weakening encryption or plaintext calendar index on the server.
- **ICS export** is a **plaintext file download** for the user’s own use — not a sharing protocol.

## Relation to Dennis’s question (“where are shared calendars?”)

They are **not present** yet. Scope for product agreement: which flows (invite email vs in-app only), whether Pro-only, and whether read-only sharing is enough for v1.

## ICS handoff behavior (Agenda export/import)

This matches the current client implementation in `app/static/js/agenda-ics.js` and scroll logic in `app/static/js/agenda.js`.

- **Timed events:** Export uses **UTC `Z`** `DTSTART`/`DTEND` so the absolute instant roundtrips regardless of the machine timezone. Parsing accepts both floating local and `Z` forms.
- **All-day events:** `VALUE=DATE` uses the **local calendar day** on import and export (not UTC midnight for the YYYYMMDD form), so America/Chicago/LA does not shift Christmas Eve to the prior calendar day.
- **Line folding:** RFC 5545 **75 octets per line** in UTF-8; folds never split a Unicode codepoint (emoji stay intact).
- **Time grid scroll:** `sessionStorage` stores scroll **paired with a schedule fingerprint** for the same view/period. Pure rerenders keep the user’s scroll; **navigation** (different period) or any **change to visible occurrences** (new event, edit, delete) updates the fingerprint so the grid **re-scrolls to the earliest visible timed appointment** for that period.
