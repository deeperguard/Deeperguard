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
