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

## Secure Send links and the limits of fragment-key sharing

Secure Send encrypts in your browser and puts the key in the URL fragment (after `#`). Browsers do not send the fragment to the server, so the server stores only ciphertext. That is weaker than normal vault use, and the app says so when you make a link:

- **The link is the key.** Anyone who has the full link can read the content, and we cannot tell who they are. Without a passphrase, the link alone is enough.
- **Links leak in ordinary ways:** browser history, chat and email apps that store or preview links, screenshots, shared screens.
- **Trust in our served code.** The recipient's browser runs JavaScript we serve to decrypt. A compromised or malicious server could serve code that reads the fragment. Fragment keys protect against a passive server, not an active one.
- **Recipients keep what they see.** Once opened, content can be copied or saved. Revoking or expiry stops new opens only.
- **Limits help but do not fix this:** a passphrase (combined with the fragment key via Argon2id), expiry (max 7 days) and an open count (max 10) reduce exposure.
- **Not end-to-end between known parties.** There is no recipient identity or key verification.

Related: deleting a note does not revoke its links (see above).

## What this file is not

- No third-party penetration test or SOC 2 status is implied.
- Listing an item here does **not** mean it is accepted as safe — only that it is **known** and awaiting an owner decision before change.
- Production operators should still follow [deploy/PRODUCTION.md](deploy/PRODUCTION.md) and keep secrets out of git (`config/deeperguard.env`, `keys/`, `data/`).

For privacy and data handling, see [docs/PRIVACY.md](docs/PRIVACY.md). For client integrity verification, see [https://www.deeperguard.com/verify](https://www.deeperguard.com/verify).
