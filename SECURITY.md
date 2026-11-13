# Security

Deeperguard is designed as a zero-knowledge notes app: note bodies are encrypted on your device before sync, and the server stores only ciphertext. **Exception:** when you use Ask AI, the text you choose to send is decrypted on your device and sent for processing (see [Privacy](docs/PRIVACY.md)). This file describes how to report issues and lists **known gaps** we track openly. It is not a certification, audit report, or claim that the deployment is fully hardened.

## Reporting a vulnerability

Please report suspected security issues by **responsible disclosure** so we can investigate before public detail.

- **Email:** [notes@deeperguard.com](mailto:notes@deeperguard.com?subject=Vulnerability%20report) with subject **“Vulnerability report”**
- **Also:** the site footer and [Contact](https://www.deeperguard.com/contact) page use the same address

Include a short description, affected URLs or components, and steps to reproduce if you can. We do not run a formal bug bounty program; good-faith reports are welcome and we will respond when we can.

## Known open items

The items below are known gaps from internal reviews (October 2026). They describe current behavior, not fixes in progress. Changes are made only after a decision by the project owner.

| Rank | Area | Item | Status |
|------|------|------|--------|
| **Medium** | Ops / host | **systemd unit runs as root** — the shipped `deploy/systemd/deeperguard.service` has no dedicated `User=` / privilege drop; the app process typically runs as root on the VPS unless operators change the unit locally. | Open — owner decision |
| **Medium** | Auth / 2FA | **TOTP turn-off without a second factor for SRP accounts** — disabling account 2FA requires the current TOTP code (and an active session) but does **not** require re-proving the account password for SRP (zero-knowledge login) users. Legacy hash-based accounts still require the account password. | Open — owner decision |
| **Medium** | Auth storage | **Leftover legacy password hashes** — accounts on SRP login may still have an old `password_hash` row used for migration, repair-login, and some password-change paths until explicitly cleared. Purging hashes needs a careful migration plan. | Open — owner decision |

Ranks reflect our current view of **risk and user impact**, not CVSS scores. Wording may be updated as the product changes.

## What deleting a note does

Deleting a note reaches some copies and not others. The delete dialog says the same:

- **This device:** removed as soon as you confirm.
- **Server:** on the next successful sync, the stored note is replaced by a small encrypted marker (a tombstone) so your other devices learn of the delete. The marker is kept while the account exists; it is not erased.
- **Other signed-in devices:** removed when each next syncs. Offline devices keep the note until then, and a newer edit on another device can bring it back.
- **Backups:** not changed. New backups omit the note; existing ones age out (pCloud: 7 days by default; newest 14 local archives). Backup emails already in your inbox stay until you delete them.
- **Secure Send links:** keep working until revoked or expired.
- **Exports, and anything a recipient saved:** we cannot delete these.

We do not claim a delete is permanent or complete everywhere. Details: [docs/DELETE_SPEC.md](docs/DELETE_SPEC.md).

## Locking the vault

Lock runs from the **Lock vault now** button, from the idle timer (**Lock after idle**, default 15 minutes, can be turned off), and from **Lock when leaving the app**. Locking is **best effort**. It reduces what a later script or a person at this browser can read, but it does not guarantee that the key or your notes are gone from memory.

What Lock does in the browser, as far as the app can reach:

- Writes unsaved edits to this device's local store, encrypted, before it drops the key. A push to the server is time-limited and may wait until the next unlock.
- Drops the vault key and decrypted notes from the app's state, overwrites the key bytes the app holds, clears the search index, and stops the crypto worker.
- Requires the **vault password** to unlock again. Unlocking runs the full key derivation (Argon2id) from the password you type.

Known gaps in the current build:

- **Remembered password.** If **Remember password on this device** is on, the password and its decryption key stay in this browser's local storage after Lock. Notes can unlock from them on a later page load. Turn the option off on shared devices, and use **Clear saved password**.
- **Key type.** The vault key is a JavaScript byte array, not a non-extractable `CryptoKey`. While the vault is unlocked, page script can read it.
- **Some UI state.** Text in open editor fields, and some document workers and object URLs, may not be cleared yet. Plan and tracking: [docs/LOCK_SPEC.md](docs/LOCK_SPEC.md).

Limits of clearing memory in JavaScript:

- JavaScript gives no way to clear memory. The engine can copy values (JIT, string conversion, `postMessage`), and the garbage collector decides when unused objects are freed and reused.
- Strings, such as the password and note text, cannot be overwritten. They are freed only when collected and may remain in freed heap pages, swap, hibernation files, or crash dumps.
- Lock protects an unattended device and later script access in the same tab. It does **not** protect against malware, a compromised browser, malicious script while the vault is unlocked, or copies already made (clipboard, screenshots, exports, downloaded attachments).
- Idle lock depends on timers. Browsers may delay timers in background tabs and on phones. Leaving-the-app lock covers part of that.
- Closing or reloading the tab drops the key from memory. The next open needs the vault password, unless a remembered password applies (see above).

### Sleep and hibernation

Lock does not run just because the device sleeps. Hiding the tab or putting the device to sleep flushes pending edits and releases some preview data, but the vault key stays in memory until Lock runs (idle timer, **Lock when leaving the app**, or **Lock vault now**). Suspend-to-RAM keeps that memory powered, so a key still held at sleep time is still in RAM. Hibernation writes RAM to disk, including the key and any decrypted text still in memory. The browser cannot reliably detect hibernation or clear the key before it happens.

So protection of a locked or hibernated device depends on **OS full-disk encryption**: FileVault (macOS), BitLocker (Windows), LUKS or similar (Linux), or device encryption (iOS and Android). With full-disk encryption on, a hibernation file or swap is encrypted at rest. Without it, a lost or stolen device may expose the key and recent notes to anyone who can read the disk. Practical steps:

- Turn on full-disk encryption on every device where you use the vault, and check that it is active.
- Lock manually (**Lock vault now**) before you close the lid on a shared or public device, and set a short idle timer.
- Turn off **Remember password on this device** on shared devices, since the remembered password is also stored on disk.

## Logging out, revoking devices, and changing your password

Logging out, revoking a device from the session list, and changing your password stop the server from giving that device new data. None of them takes back data the device already holds. A device that has the vault key or password and a copy of the ciphertext can keep reading that copy while offline, and no server-side action stops it. There is no offline lease. Full details and practical steps: [docs/REVOCATION_LIMITS.md](docs/REVOCATION_LIMITS.md).

## Secure Send links and the limits of fragment-key sharing

Secure Send encrypts in your browser and puts the key in the URL fragment (after `#`). Browsers do not send the fragment to the server, so the server stores only ciphertext. That is weaker than normal vault use, and the app says so when you make a link:

- **The link is the key.** Anyone who has the full link can read the content, and we cannot tell who they are. Without a passphrase, the link alone is enough.
- **Links leak in ordinary ways:** browser history, chat and email apps that store or preview links, screenshots, shared screens.
- **Trust in our served code.** The recipient's browser runs JavaScript we serve to decrypt. A compromised or malicious server could serve code that reads the fragment. Fragment keys protect against a passive server, not an active one.
- **Recipients keep what they see.** Once opened, content can be copied or saved. Revoking or expiry stops new opens only.
- **Limits help but do not fix this:** a passphrase (combined with the fragment key via Argon2id), expiry (max 7 days) and an open count (max 10) reduce exposure.
- **Not end-to-end between known parties.** There is no recipient identity or key verification.

Related: deleting a note does not revoke its links (see above).

## Calendar (.ics) import

Importing a calendar file is processed entirely in the browser. The file and its events are encrypted before storage, like other Agenda data. Imported files are treated as untrusted: they are capped in size (10 MB) and event count (10,000), recurrence expansion is capped, and no remote content (attachments, images, URLs, conferencing links, timezone data) is loaded. Calendar feed subscriptions are fetched directly by your browser (see below); the app does not use server-side fetching of calendar files or feed URLs. You can also download the .ics file from your provider yourself and import it.

### Calendar subscriptions (direct fetch available; relay planned)

**Status: direct fetch is available in this build; the relay is not yet available.** The bullets below follow `docs/ICS_SUBSCRIBE_SPEC.md`. Until the relay ships in the app, a feed whose provider blocks direct fetching shows an error, and you can still download the .ics file yourself and import it.

- **Link storage:** the feed link is stored only inside the encrypted vault pack. It is never written to logs, error messages (only fixed error codes), toasts, analytics, `localStorage` or exports.
- **Direct fetch (default):** the browser fetches the feed itself, from a dedicated worker with a narrow CSP (`connect-src https:` only, for that worker). It uses GET only, no credentials, no referrer, no custom headers, a 2 MB limit and a 10 s limit. The calendar provider sees your IP address and the time of each refresh.
- **Relay (opt-in per subscription):** if the provider blocks direct fetching (CORS), you may choose, per subscription, to fetch through the Deeperguard server. This is an exception to "the server only sees ciphertext": during the fetch the server sees the link and the calendar content. Nothing is stored or logged (no link, host, content or error details). The relay requires login, accepts only `https` on port 443, allows 30 requests per hour per user, 2 MB and 10 s.
- **SSRF protection (relay):** the host is resolved once and every address must be public (loopback, private, link-local/metadata, CGNAT, reserved, multicast and mapped IPv6 are refused); the connection is pinned to the validated IP; redirects are followed manually (max 3) and re-checked at each hop.
- **Refresh only with an open vault:** there is no background, service-worker or server-side refresh. Timers stop when the vault locks, in-flight fetches are aborted, and automatic refreshes are at least 30 minutes apart.
- **Untrusted content:** fetched ICS data goes through the same parser and caps as file import, is shown only as text, and nothing it references is loaded automatically.
- **Known trade-off:** with direct fetching, an XSS in the app could use the worker to send data to any https host; the page-wide CSP stays narrow and the page itself cannot connect elsewhere.

## Synced settings (encrypted record)

**Status: the client module (`settings-sync.js`) is in this build; migrating the existing preference code to it is not finished.** The rules follow `docs/SETTINGS_SPEC.md`. Allowlisted settings (for example the Agenda view, theme, font size) are stored as one vault item, encrypted in the browser with AES-256-GCM using the vault key, a fresh random IV per save, and the record type and account bound in as authenticated data. The record is padded to a fixed size (1024 bytes) before encryption. It travels through the normal encrypted sync; there is no separate endpoint. Secrets (API keys, tokens), free text and device-only settings never enter this record. After decrypting, unknown keys and invalid values are ignored and defaults apply; if decryption fails, the server copy is not overwritten until you change a setting yourself. Settings are held in memory only and cleared when the vault locks; the module writes nothing to `localStorage`, `sessionStorage`, cookies or the URL.

**Metadata the server can still see:** that a record exists for your account (a stable, opaque item id, rewritten on each change); when it changed and how often (timestamps, sync log of counts and bytes); its size, which is constant (so the number of settings and their values stay hidden) while the record is under 1024 bytes; a content hash that changes on every save; and your IP address and request time. It cannot see key names, values or which setting changed. The older plain `deeperguard-prefs` entry in `localStorage` still holds these settings until the existing preference code is moved to this module.

## What this file is not

- No third-party penetration test or SOC 2 status is implied.
- Listing an item here does **not** mean it is accepted as safe — only that it is **known** and awaiting an owner decision before change.
- Production operators should still follow [deploy/PRODUCTION.md](deploy/PRODUCTION.md) and keep secrets out of git (`config/deeperguard.env`, `keys/`, `data/`).

For privacy and data handling, see [docs/PRIVACY.md](docs/PRIVACY.md). For client integrity verification, see [https://www.deeperguard.com/verify](https://www.deeperguard.com/verify).
