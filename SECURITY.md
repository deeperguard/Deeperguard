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

## What this file is not

- No third-party penetration test or SOC 2 status is implied.
- Listing an item here does **not** mean it is accepted as safe — only that it is **known** and awaiting an owner decision before change.
- Production operators should still follow [deploy/PRODUCTION.md](deploy/PRODUCTION.md) and keep secrets out of git (`config/deeperguard.env`, `keys/`, `data/`).

For privacy and data handling, see [docs/PRIVACY.md](docs/PRIVACY.md). For client integrity verification, see [https://www.deeperguard.com/verify](https://www.deeperguard.com/verify).
