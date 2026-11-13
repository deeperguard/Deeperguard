# Crypto key-validation audit

Status: audit written against commit `ebdb064`; line references are to that tree. See "Implementation status" below for what has since been fixed.

## Implementation status

SRP-6a degenerate-value checks (A, B, u):

| Check | Where | Status |
|---|---|---|
| `A mod N == 0` (A = 0, N, 2N) | server `SrpServerSession.step2` | Already present; table-driven test in `tests/test_srp_auth.py` |
| `u == 0` | server `step2` | Already present; test added (monkeypatched `_h`) |
| `B mod N == 0` | client `SrpClient.step2` | Already present; test added in `tests/test_srp_client_degenerate.js` (B = 0, N, 2N) |
| `B` not hex / empty | client `step2` | **Done**: rejected with the generic error |
| `u == 0` | client `step2` | **Done**: rejected with the generic error (an empty/zero hash counts as 0) |

All of these fail with a single generic message (`bad client credentials` on the server, `Invalid server public value` on the client), so the failing check is not revealed. The protocol flow and data formats are unchanged.

Still open (not part of this change): length/canonical bounds on A and B, verifier `v` validation, `S` checks, Secure Send key length, WebAuthn algorithm list (recommendations 1, 2, 3 in part, 4, 5, 6, 8 below).

Motivation: a node-forge Ed25519 flaw let attackers forge signatures by supplying a weak public key. This audit checks whether Deeperguard has the same exposure. It also records which degenerate-input checks exist on each key, signature and SRP-6a path, and which are missing.

## 1. Crypto dependencies

### Package manifests and lockfiles

| File | Crypto-relevant entries |
|---|---|
| `requirements.txt` | `argon2-cffi==23.1.0`, `cryptography==50.0.1`, `pyotp==2.9.0`, `webauthn==2.5.0`, `pyOpenSSL==26.4.0`, `argon2-cffi-bindings==26.1.0` (others are non-crypto: Flask, Werkzeug, gunicorn, stripe, qrcode, Pillow, pillow-heif) |
| `requirements.lock` | pinned set including `argon2-cffi`, `argon2-cffi-bindings`, `asn1crypto==1.5.1`, `cffi==2.1.1`, `cryptography==50.0.1`, `pyotp==2.9.0` |
| `package.json` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` | **None exist.** There is no npm manifest. |

Client JavaScript has no package manager. Libraries are vendored under `app/static/js/vendor/`:

- `noble-crypto.js`: `@noble/hashes` and `@noble/ciphers`. It exports only `sha256`, `pbkdf2Async` and AES-`gcm`. It contains no signature or curve code.
- `noble-argon2.js`: Argon2id.
- `jsQR.js`, `qrcode-generator.js`, `pdfjs`, `jspdf`, `tesseract`, `heic2any`: non-crypto.

### Explicit answers

- **node-forge: not used.** It is not in any manifest, lockfile or vendored file. The only `forge` matches are the English word "forge" in comments, in `app/static/js/secure-send.js:85` and `docs/SHARE_LINK_CRYPTO.md:12,28`, and in a test variable in `tests/test_round_d2_secure_send.js:253-261`.
- **Ed25519: not used directly.** No Ed25519 signing or verification code exists in `app/`. The only Ed25519 exposure is indirect: `webauthn==2.5.0` may verify EdDSA (COSE alg -8) assertions through `cryptography` (see 2.5).
- **X25519 / any Diffie-Hellman over an elliptic curve: not used.** There is no ECDH, X25519 or `deriveBits` with ECDH anywhere. The only key agreement is SRP-6a over the RFC 5054 2048-bit group (section 2.1).
- **Web Crypto use:** AES-GCM `importKey('raw', ...)` and HKDF/HMAC. No asymmetric `importKey`, and no `subtle.verify`.

## 2. Code paths

Legend: present / **MISSING** / n/a.

### 2.1 SRP-6a, server side (`app/srp_auth.py`)

Group: N is the RFC 5054 2048-bit prime and G = 2 (`srp_auth.py:20-31`). k is a hard-coded constant K (`:32`), taken from the thinbus implementation.

**B (server public value), `SrpServerSession.step1`, `:167-179`**
- b is drawn non-zero mod N by `_random_nonzero_mod_n` (`:75`, used at `:174`).
- `B % N == 0` is rejected at `:176`. This is present.
- The verifier `v` (client-supplied at registration) is not validated. See 2.1a.

**A, `step2`, `:181-212`**
- Hex syntax is checked in `_client_hex_int` (`:67-72`). Empty or non-hex input is rejected.
- `A % N == 0` is rejected at `:192`. This covers 0, N, 2N and so on. Present.
- **Missing: bound on A.** `A >= N` is accepted as long as `A % N != 0`. The hex length is unbounded, which is a DoS and malleability concern: `pow` runs on an arbitrarily large integer, and `a_hex` is hashed verbatim into u and M1.
- **Missing: canonical encoding.** Leading zeros and upper case are tolerated. `a_hex` is lower-cased but not canonicalised, and the raw string feeds `_h(a_hex + b_hex)` at `:196`. The protocol already strips leading zeros inside `_h`, but A itself is not normalised.

**u, `:196-200`**
- `u == 0` is rejected at `:199`. Present. The probability is negligible, but the check exists.

**S, M1, M2, `:202-210`**
- **Missing: S == 0 check.** If A is a non-zero value for which `(v^u * A)^b mod N == 0`, S is 0. This cannot happen for a prime N when A % N != 0, so it is theoretical. A defensive `S % N == 0` check is still cheap.
- M1 uses a constant-time comparison, `hmac.compare_digest` (`:206`). Present. The values are stripped of leading zeros first (`:205`). The comparison is on strings with no length pre-check, which is fine for `compare_digest`.
- M2 is derived at `:209`.

**2.1a Verifier (client-controlled v)**
- Stored at registration and upgrade: `app/app.py:1106,1119` (`/register`), `:1489-1515`, `:1559-1570`, `:2167-2208`. All of these only check that the value is non-empty.
- **Missing: any validation of `v`.** There is no hex check, no `0 < v < N` check, and no length bound. `v = 0` makes `B = g^b mod N`. That is harmless to other users, since it only weakens the account owner's own login. Non-hex input raises `ValueError` inside `step1` (`:172` via `int(.., 16)`), which `app.py:1170-1182` turns into a generic 401, so a malformed verifier can lock the owner out of their own account.
- Recommendation: validate `v` at all five write sites through a single helper, for example `validate_srp_verifier_hex()` in `srp_auth.py`. It should require lowercase hex of at most 512 characters with `1 < v < N`.

**2.1b Other server paths**
- `from_private_state` (`:155-165`) rebuilds B from the stored b and v. It does not re-run the `B % N` check. This is low risk, because the state is server-generated.
- `fake_srp_challenge` (`:231-249`) builds B from a non-zero b. It has no zero check, but `x` is forced non-zero and B is not attacker-controlled.
- Callers: `app/app.py:229,255` (stored-credential proofs), `:1171-1172,1208-1209` (login), plus the repair and recovery paths at `:1370` and `:1512`.
- **A is not length-capped at the HTTP layer.** `A` and `M1` are only `strip().lower()`-ed in `api_auth_srp_verify` (`app.py:1192`; the same pattern is at `:1265,1331,1491,2055,2121,2168`). There is no size cap before they reach `int(.., 16)`.

### 2.2 SRP-6a, client side (`app/static/js/srp-auth.js`)

**B, `SrpClient.step2`, `:150-172`**
- `B % N == 0` is rejected at `:157`. Present.
- **Missing: hex syntax check.** `BigInt('0x' + bHex)` throws a `SyntaxError` on garbage. This fails safe, but the error is unhelpful. An empty string gives `BigInt('0x')`, which also throws.
- **Missing: bound on B, and canonical form.** `B >= N` is accepted. `bHex` is used verbatim in `u` and M1 (`:163,168`), which is the same issue as for A on the server.
- **Missing: u == 0 check.** `u` is computed at `:163` and used without checking for zero. Per RFC 5054, the client must abort if `u == 0`. Because `u` is a SHA-256 output, the risk is negligible, but the check is trivial.
- **Missing: S check.** There is no `S == 0` or `S == 1` check at `:166`. If B is a non-zero value in a degenerate subgroup, S is predictable. B's range check does not cover B ≡ 1 or B ≡ N−1 (the low-order elements 1 and −1 of the group). With B = 1, `(1 − kv) ^ exp` is not fully attacker-determined, but with `B = N − 1` or `B = kv + 1` there are variants worth testing. Recommendation: reject `S % N` in `{0, 1, N−1}`.
- A (`:161`) is generated locally from a non-zero `a`, so it is trusted.
- **M2 verification, `step3` (`:174-182`):** compares with `!==` (not constant-time). The values are server-supplied public proofs, so the risk is low. Using a constant-time compare is optional.

**Callers** at `srp-auth.js:298,317,404,430,529,546` pass the server-supplied `challenge.B` straight in. All of them go through `step2`, so a single fix covers them.

### 2.3 Share-link / Secure Send (`app/static/js/secure-send.js`)

- There are no public keys or signatures. Share links use symmetric keys: a 32-byte `fragKey` in the URL fragment (`:157-159`), an optional Argon2id passphrase, and AES-GCM. The design is documented in `docs/SHARE_LINK_CRYPTO.md`.
- The open verifier is HMAC-SHA256 (`:109-117`), compared server-side in `app/db.py:3067-3070`. The comparison is constant-time and has a length pre-check. Present.
- **Key import** (`resolveContentKey`, `:180-195`): `fromB64url` decodes the fragment. **Missing: length validation.** `fragKey` and the raw key at `:182` are not checked for 32 bytes, and there is no all-zero check. A wrong length fails later in AES-GCM, which is acceptable. An all-zero key is a valid AES key, so it would decrypt, but only data that was encrypted under it. That is not an attack on a link with a random key. **Recommendation:** add `length === 32` checks for clearer errors. An all-zero rejection is optional hardening.
- `importKey('raw', ..., 'AES-GCM')` in `vault-secrets.js:49,82,147,183,244` imports symmetric keys from local storage. No asymmetric keys. The same length-check recommendation applies, at low priority.

### 2.4 Collaborator access / revocation

`docs/REVOCATION_SPEC.md` describes use-time checks. No asymmetric crypto or key exchange is involved in collaborator access today. Any future per-recipient key wrapping must add the validations from section 3.

### 2.5 WebAuthn / passkeys (`app/webauthn_helper.py`)

- `verify_registration` (`:104-120`) calls `webauthn.verify_registration_response`. It stores the COSE public key as returned (`:118`).
- `verify_authentication` (`:145-162`) calls `webauthn.verify_authentication_response` with the stored key.
- All signature verification is delegated to `webauthn` 2.5.0 and `cryptography` 50.0.1. Those libraries do the COSE key parsing and the point validation. They are OpenSSL-backed, not node-forge. This repo does no key validation of its own, and has none to bypass.
- **Missing (defence in depth):** no allow-list of COSE algorithms. Recommendation: pass `supported_pub_key_algs` (ES256, RS256 and optionally EdDSA) explicitly in `registration_options`. This removes any ambiguity about which curve paths are reachable.
- Client side (`auth-pages.js:1117`, `passkeys.js:25`) only calls `navigator.credentials`. It never verifies a signature.

### 2.6 Non-key crypto comparisons (for completeness)

- `app/auth.py:690,975`, `app/email_verify.py:84` and `app/db.py:3070` use `hmac.compare_digest`. Present.
- `app/totp.py` and `app/static/js/totp.js` implement HMAC-based OTP. There are no keys to validate beyond Base32 decoding.
- `app/passwords.py:26` is Argon2 verification via `argon2-cffi`.

## 3. Summary matrix

| Path | Length | Canonical | All-zero | Identity / low-order | A mod N | B mod N | u == 0 |
|---|---|---|---|---|---|---|---|
| Server `step2` (`srp_auth.py:181`) | **missing** (unbounded) | **missing** | present (A) | n/a | present (`:192`) | n/a | present (`:199`) |
| Server `step1` (`:167`) | n/a | n/a | present (b non-zero) | n/a | n/a | present (`:176`) | n/a |
| Server verifier `v` (`app.py` write sites) | **missing** | **missing** | **missing** | **missing** | n/a | n/a | n/a |
| Client `step2` (`srp-auth.js:150`) | **missing** | **missing** | present (B ≡ 0) | **missing** (B ≡ 1, N−1, S) | n/a | present (`:157`) | **missing** |
| Secure Send fragment key (`secure-send.js:182,192`) | **missing** | n/a | **missing** | n/a | n/a | n/a | n/a |
| WebAuthn (`webauthn_helper.py`) | delegated | delegated | delegated | delegated | n/a | n/a | n/a |

## 4. Recommendations (not implemented here)

Priority order:

1. **Server: bound and canonicalise A.** In `_client_hex_int`, cap the length at 512 hex characters. Require `0 < A < N`, and reject values that are not in canonical form (no leading zeros, lowercase). Hash the canonical form.
2. **Server: validate the verifier `v`** at every write site (see 2.1a) through a single helper.
3. **Client: harden `SrpClient.step2`.** Validate that `bHex` is hex of at most 512 characters, with `0 < B < N`. Reject `u == 0`. Reject `S % N` in `{0, 1, N−1}`. Run `scripts/build-client-manifest.py` after editing `app/static`.
4. **Server: add `S % N == 0` as a defence-in-depth check** before computing M1.
5. **Secure Send:** enforce a 32-byte length on decoded keys and fragments (optional: reject all-zero).
6. **WebAuthn:** pass an explicit `supported_pub_key_algs` list.
7. **Tests.** Server tests in `tests/test_srp_auth.py` for `A` = 0, N, 2N, N+1 and over-long hex, `u == 0` (by monkeypatching `_h`), and a degenerate `v`. Client tests alongside `tests/test_srp_m2_e2e.js` for `B` = 0, N, 1, N−1, garbage and over-long hex. Secure Send tests for wrong-length keys in `tests/test_round_d2_secure_send.js`.
8. **Dependency hygiene.** Keep the manifests node-forge-free. A CI grep for `node-forge`, `forge.ed25519` and `tweetnacl` would catch a future regression.

## 5. Out of scope

- Any code, test, manifest or workflow change. This document is the only deliverable.
- Auditing the internals of `cryptography`, OpenSSL, `webauthn`, `argon2-cffi` and `pyotp`, beyond noting how they are called.
- The vendored third-party bundles (`pdfjs`, `jspdf`, `tesseract`, `heic2any`, `jsQR`, `qrcode-generator`), none of which perform key validation.
- TLS and certificate handling in `deploy/` and the reverse proxy.
- Cryptographic soundness of the SRP parameters (the choice of k, SHA-256 and the thinbus-compatible hex framing), of Argon2id/HKDF parameters, and of AES-GCM nonce management.
- Vault-key derivation and the lock behaviour (`docs/LOCK_SPEC.md`), the Stripe integration, and secrets in the environment.
- Side-channel analysis of the Python `pow` and JavaScript `BigInt` modular exponentiation (neither is constant-time).
- Dynamic testing or fuzzing. The findings come from reading the code.
