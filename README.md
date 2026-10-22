# Deeperguard

Encrypted notes in your browser.

**[Open the notes app](https://www.deeperguard.com/app)**

<img src="docs/images/login.png" alt="Deeperguard sign-in screen" width="420">

## What it does

Deeperguard is a notes app that runs in the browser. You write, tag, search, pin, archive, and trash notes, attach files, use checklists and markdown, and scan documents. The same vault opens on your phone or computer, including from the home screen.

## Sign-in

The screen above takes an email and an account password. The password stays in the browser. Sign-in is SRP-6a over SHA-256 and the RFC 5054 2048-bit group: the client sends a proof, and the server stores only a salt and a verifier. A passkey (WebAuthn) can take the place of that step.

The next screen unlocks the vault on the device. The server never checks the vault password. A passkey signs you in only; the vault still unlocks with the password.

## Vault

New vaults derive a 32-byte key with Argon2id: 3 iterations, 64 MiB of memory, parallelism 2, from the password and a per-account salt. Older vaults still open with the legacy SHA-256 derivation.

Titles, bodies, tags, attachments, extracted document text, and version history are encrypted as JSON with AES-256-GCM and a random 12-byte IV before anything is uploaded. Decryption runs in the browser after unlock.

## On the device

The ciphertext is cached in IndexedDB, so notes open offline and the site can be added to the home screen as a PWA. Scans and PDFs are read with Tesseract and pdf.js in the browser; the text is encrypted into the note, and search runs on the decrypted copy locally. Each edit keeps the previous copy inside the encrypted note, so an older version can be restored.

## What the server holds

Ciphertext blobs, the SRP verifier, the account email, sessions, and sync metadata: item ids, timestamps, and sizes. Reminder email does not include note titles.

Accounts are free during the public beta.

[www.deeperguard.com](https://www.deeperguard.com)

## Build from source (client integrity)

The browser app is plain static JS/CSS (no bundler). A deterministic manifest
hashes every shipped script and stylesheet so you can verify what the origin
serves.

**Toolchain pins**

- Python: `.python-version` (`3.11`) and `requirements.lock` (from `requirements.txt`)
- Node: `.nvmrc` (`18`) — used for the JS test suite only; there is no frontend npm build

**Reproduce the client manifest**

```bash
git clone https://github.com/deeperguard/Deeperguard.git
cd Deeperguard
git checkout <tag-or-commit>
export SOURCE_DATE_EPOCH=0
python3 scripts/build-client-manifest.py --print-hash
```

Two runs with the same tree and `SOURCE_DATE_EPOCH` must print the same
`manifest_sha256`. That value is exposed in the app (Settings → About), in
`GET /api/health` as `client_hash`, and in the signed `client-manifest.json`
attached to each GitHub Release (`v*` tags). Releases are signed with Sigstore
Cosign keyless (Rekor). See [/verify](https://www.deeperguard.com/verify) for
the full check (in-app hash → release manifest → `cosign verify-blob` → rebuild).

A pinned build (browser extension or desktop app) is the strongest integrity
option if one is published later — a normal web origin can always change what
it serves next.

**GitHub Actions**

Workflow YAML lives in `deploy/github-workflows/` (`client-integrity.yml` dual
build check, `release-client.yml` Cosign keyless release on `v*` tags). Copy
both into `.github/workflows/` on a machine whose GitHub token has the
`workflow` scope (the default OAuth app used by some agents cannot create
workflow files):

```bash
mkdir -p .github/workflows
cp deploy/github-workflows/*.yml .github/workflows/
git add .github/workflows && git commit -m "Enable client integrity GitHub Actions" && git push
```

## Source

[AGPL-3.0](LICENSE) · [Privacy](docs/PRIVACY.md) · [Self-host](docs/SELF_HOST.md) · [Verify](https://www.deeperguard.com/verify)
