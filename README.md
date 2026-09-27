# Deeperguard

Encrypted notes in your browser.

**[Open the notes app](https://www.deeperguard.com/app)**

## What it does

Deeperguard is a notes app that runs in the browser. You write, tag, search, pin, archive, and trash notes, attach files, use checklists and markdown, and scan documents. The same vault opens on your phone or computer, including from the home screen.

Each note is encrypted on the device before it syncs. Titles, bodies, tags, attachments, and extracted document text are AES-256-GCM ciphertext. The vault key is derived locally with Argon2id. Sign-in is SRP-6a: the server stores a verifier, not your password, and it never checks the vault password. Scans are read with Tesseract in the browser, then encrypted with the note. The vault is also kept in IndexedDB, so notes stay available offline. Earlier versions stay inside the encrypted note and can be restored.

The server stores ciphertext, account email, and sync metadata. Accounts are free during the public beta.

[www.deeperguard.com](https://www.deeperguard.com)

## Source

[AGPL-3.0](LICENSE) · [Privacy](docs/PRIVACY.md) · [Self-host](docs/SELF_HOST.md)
