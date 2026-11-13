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
| Source | Open (AGPL) | Source available for review ([BSL 1.1](../LICENSE); production use requires permission) |

## What never leaves your device (default config)

- Vault password
- Note titles and bodies (plaintext)
- Attachment bytes (images, PDFs)
- OCR text and search hit boxes

All of the above are encrypted with AES-256-GCM in the browser before sync.

## Calendar (.ics) import

Calendar files you import are parsed in your browser. The file and its events are encrypted before storage, the same as your other Agenda data, so the server stores only ciphertext. Imported files are treated as untrusted: they are capped at 10 MB and 10,000 events, recurrence expansion is capped, and no remote content is loaded. Deeperguard does not subscribe to calendar feeds and does not fetch feed URLs on the server. If you only have a feed link, download the .ics file from your provider yourself and import it. See [SECURITY.md](../SECURITY.md#calendar-ics-import).

### Calendar subscriptions (planned, not yet available)

**Status: not implemented in this build.** The statements above (no feed subscription, no server-side fetching) are what the code does today. This section records what is specified in `docs/ICS_SUBSCRIBE_SPEC.md` so that the app's texts and behaviour can be checked against it when the feature ships. Nothing here describes current behaviour.

- **Link storage:** the feed link is stored only inside the encrypted vault pack. It is never written to logs, error messages (only fixed error codes), toasts, analytics, `localStorage` or exports.
- **Direct fetch (default):** the browser fetches the feed itself, from a dedicated worker with a narrow CSP (`connect-src https:` only, for that worker). It uses GET only, no credentials, no referrer, no custom headers, a 2 MB limit and a 10 s limit. The calendar provider sees your IP address and the time of each refresh.
- **Relay (opt-in per subscription):** if the provider blocks direct fetching (CORS), you may choose, per subscription, to fetch through the Deeperguard server. This is an exception to "the server only sees ciphertext": during the fetch the server sees the link and the calendar content. Nothing is stored or logged (no link, host, content or error details). The relay requires login, accepts only `https` on port 443, allows 30 requests per hour per user, 2 MB and 10 s.
- **SSRF protection (relay):** the host is resolved once and every address must be public (loopback, private, link-local/metadata, CGNAT, reserved, multicast and mapped IPv6 are refused); the connection is pinned to the validated IP; redirects are followed manually (max 3) and re-checked at each hop.
- **Refresh only with an open vault:** there is no background, service-worker or server-side refresh. Timers stop when the vault locks, in-flight fetches are aborted, and automatic refreshes are at least 30 minutes apart.
- **Untrusted content:** fetched ICS data goes through the same parser and caps as file import, is shown only as text, and nothing it references is loaded automatically.
- **Known trade-off:** with direct fetching, an XSS in the app could use the worker to send data to any https host; the page-wide CSP stays narrow and the page itself cannot connect elsewhere.

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
| Someone at your unlocked device, after Lock or idle lock | Lock is best effort (see below) |

### Locking

Lock drops the vault key and decrypted notes from the browser tab, as far as the browser allows, and unlocking requires your vault password again. JavaScript cannot fully clear memory, so Lock does not guarantee that the key or notes are gone from memory. A remembered password on this device, if you turned that option on, stays in local storage after Lock. Details and limits: [SECURITY.md](../SECURITY.md#locking-the-vault).

## Further reading

- [README.md](../README.md) — features and security model
- [deploy/PRODUCTION.md](../deploy/PRODUCTION.md) — WAN deployment
