# Privacy model

Deeperguard is a **zero-knowledge** encrypted notes app at [www.deeperguard.com](https://www.deeperguard.com). The server is a sync and auth broker — not a reader of your notes.

## Compared to Standard Notes

Standard Notes is open source and encrypts notes end-to-end. Deeperguard aims to be **stricter and more transparent**:

| Topic | Standard Notes (typical) | Deeperguard |
|-------|--------------------------|---------------|
| Hosting | Their cloud or self-host | **You** host everything |
| Account login | E2E encrypted account | **SRP-6a** — password never sent |
| Vault unlock | Client-side | Client-side; server **never** verifies vault password (`NOTES_STRICT_ZK=1`) |
| OCR / PDF text | Varies by client | **Browser-only** by default; server OCR disabled |
| Reminder emails | May include titles | **No note titles** in reminder mail (ZK metadata) |
| Source | Open (AGPL) | Open (AGPL-3.0) |

## What never leaves your device (default config)

- Vault password
- Note titles and bodies (plaintext)
- Attachment bytes (images, PDFs)
- OCR text and search hit boxes

All of the above are encrypted with AES-256-GCM in the browser before sync.

## What the server stores

- SRP verifier (not your password)
- Encrypted vault blobs (notes, tags, attachments)
- Account email, session tokens, optional TOTP secret
- Sync metadata (timestamps, item IDs, ciphertext sizes)

## What the server can still learn (metadata)

Even in strict zero-knowledge mode:

- Your email address
- When you sync and how much data you store
- Your IP address (for rate limiting and logs)
- That a reminder was scheduled (not the note title)

## Configuration knobs

| Variable | Default | Effect |
|----------|---------|--------|
| `NOTES_STRICT_ZK` | `1` | Vault password never sent to server |
| `NOTES_SERVER_OCR` | `0` | No document plaintext on server for OCR |
| `NOTES_OCR_EPHEMERAL` | `1` | OCR plaintext not persisted on disk |

Set `NOTES_STRICT_ZK=0` or `NOTES_SERVER_OCR=1` only for local debugging — not on a public instance.

## Threat model summary

| Attacker | Can they read your notes? |
|----------|---------------------------|
| Server operator (you) | No, without vault password |
| Network eavesdropper (HTTPS) | No |
| Compromised server disk | No (ciphertext only) |
| Compromised server + live RAM | Unlikely for bulk vault; sessions may be active |
| Stolen device + weak password | Yes — use a strong vault password and device lock |

## Further reading

- [README.md](../README.md) — features and security model
- [deploy/PRODUCTION.md](../deploy/PRODUCTION.md) — WAN deployment
