# Security

Deeperguard is designed as a zero-knowledge notes app: note bodies stay encrypted on the client. This file describes how to report issues and lists **known gaps** we are tracking openly. It is not a certification, audit report, or claim that the deployment is fully hardened.

## Reporting a vulnerability

Please report suspected security issues by **responsible disclosure** so we can investigate before public detail.

- **Email:** [notes@deeperguard.com](mailto:notes@deeperguard.com?subject=Vulnerability%20report) with subject **“Vulnerability report”**
- **Also:** the site footer and [Contact](https://www.deeperguard.com/contact) page use the same address

Include a short description, affected URLs or components, and steps to reproduce if you can. We do not offer a bug bounty; we will acknowledge good-faith reports and work on fixes when appropriate.

## Known open items

The items below are **owner-tracked decisions** left from internal report-only reviews (GitHub PRs #48–#95, October 2026). They describe current behavior or ops choices, not fixes in flight. **Any code or ops change needs an explicit “yes” from Dennis (project owner) before work starts.**

| Rank | Area | Item | Owner approval before fix |
|------|------|------|---------------------------|
| **High / Medium** | Ops / credentials | **Plaintext pCloud passwords** — optional Pro pCloud backup stores the user’s pCloud WebDAV password on the server filesystem (`keys/pcloud-password-*`) so scheduled rclone sync can run. OAuth tokens are an alternative; passwords are not encrypted at rest on disk. | **Yes — Dennis** |
| **Medium** | Ops / host | **systemd unit runs as root** — the shipped `deploy/systemd/deeperguard.service` has no dedicated `User=` / privilege drop; the app process typically runs as root on the VPS unless operators change the unit locally. | **Yes — Dennis** |
| **Medium** | Auth / 2FA | **TOTP turn-off without a second factor for SRP accounts** — disabling account 2FA requires the current TOTP code (and an active session) but does **not** require re-proving the account password for SRP (zero-knowledge login) users. Legacy hash-based accounts still require the account password. | **Yes — Dennis** (touches login / 2FA) |
| **Low / Medium** | Auth storage | **Leftover legacy password hashes** — accounts on SRP login may still have an old `password_hash` row used for migration, repair-login, and some password-change paths until explicitly cleared. Purging hashes needs a careful migration plan. | **Yes — Dennis** (before any purge) |

Ranks are our current prioritization for **risk and user impact**, not CVSS scores. Wording may be updated as the tree changes.

## What this file is not

- No third-party penetration test or SOC 2 status is implied.
- Listing an item here does **not** mean it is accepted as safe — only that it is **known** and gated on owner decisions.
- Production operators should still follow [deploy/PRODUCTION.md](deploy/PRODUCTION.md) and keep secrets out of git (`config/deeperguard.env`, `keys/`, `data/`).

For privacy and data handling, see [docs/PRIVACY.md](docs/PRIVACY.md). For client integrity verification, see [https://www.deeperguard.com/verify](https://www.deeperguard.com/verify).
