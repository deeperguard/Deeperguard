# Share-link crypto and threat model

Status: describes the shipped Secure Send design (`app/static/js/secure-send.js`, `app/secure_send.py`). User-facing limits are in [SECURITY.md](../SECURITY.md#secure-send-links-and-the-limits-of-fragment-key-sharing).

## Design

- **Per-share random key.** Every share draws a fresh 32-byte key from `crypto.getRandomValues`. Keys are never derived from the vault key and never reused across shares, so a leaked link exposes only that share.
- **Cipher.** AES-256-GCM (`NotesCrypto.encryptObject`), fresh random 12-byte IV per encryption, stored as `{v, iv, data}`. Title, body, and file name/MIME/size are inside the plaintext; the server sees only ciphertext and its length.
- **Fragment encoding.** The key goes after `#`, base64url without padding. Browsers do not send the fragment in requests.
  - `v1.<key>`: link alone decrypts.
  - `v1p.<salt>.<fragKey>`: content key = SHA-256(`fragKey` || Argon2id(passphrase, salt)). Both the link and the passphrase are required.
- **Open verifier (passphrase links only).** HMAC-SHA256(content key, `dg-secure-send-verify-v1`) lets the server reject wrong guesses without burning an open. It is keyed by a value that includes `fragKey`, so the server cannot forge it, and it does not reveal the key.
- **Leak guard.** `assertNoFragmentLeak` refuses to send any request whose URL or body contains the fragment.
- **Limits.** Expiry max 7 days, open count max 10 (default 1), file max 50 MB.

## Assets

1. Shared content (title, body, file). 2. The link key. 3. The passphrase (if used).

## Threats

| Threat | Result | Notes |
|---|---|---|
| Passive server / DB or backup leak | Protected | Ciphertext only; key never leaves the client. |
| Active server (malicious or compromised) | **Not protected** | Served JS can read the fragment on create or open. Same limit applies to the whole web client; see the client integrity checks. |
| Link leaked (history, chat preview, screenshot, referrer-free logs elsewhere) | **Not protected** without passphrase | The link is the key. Passphrase, expiry, and open count reduce but do not remove this. |
| Link leaked + weak passphrase | Partly protected | Argon2id slows guessing; the attacker needs the link and the ciphertext. |
| Server-side passphrase guessing | Protected | Server has no key material; the verifier cannot be forged without `fragKey`. |
| Offline guessing without the link | Protected | 256-bit `fragKey` is also mixed into the key. |
| Ciphertext tampering | Detected | GCM authentication fails on open. |
| IV reuse | Negligible | Random 96-bit IV with a single-use key per share. |
| Recipient keeps/copies content | **Not protected** | Expiry and open limits stop new opens only. |
| Wrong recipient | **Not protected** | No recipient identity or key verification. |
| Deleting the source note | Does not revoke | See `docs/DELETE_SPEC.md`. |

## Out of scope / non-goals

Forward secrecy, recipient authentication, revocation of already-opened content, and protecting against a malicious served client.

## Required UX

Creating a link must show `SHARING_WARNING` (sharing weakens end-to-end protection) before the link is produced.
