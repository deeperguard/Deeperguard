# Use-time revocation: share links and collaborator access

Scope: any grant that lets someone other than the owner read data or act on it:
Secure Send links (shipped), and collaborator or calendar-sharing access (not
shipped; see `docs/CALENDAR_SHARING_DESIGN.md`). This is a spec and an audit; no
code changes come with it. Line numbers refer to the tree at the time of
writing; re-check them when those paths change.

## 1. The rule

A grant is valid at the moment of use only if a revocation check, made at that
moment against the server's current record, does not show it revoked, expired,
or used up. Verifying a signature, a token, or a link key proves that the grant
was issued. It does not prove that it is still live.

Consequences:

1. Every use point checks the record. "Use" means: releasing ciphertext, accepting
   a write, honouring a key or invitation, and rendering a shell that reveals
   status. Checking once when the grant is created is not enough.
2. The check is server-side. A client-side check is advisory and must never be
   the only gate.
3. The check fails closed. If the record cannot be read, the use is denied. An
   error must not fall through to "not revoked".
4. The decision and the consumption happen in one transaction (or an equivalent
   compare-and-set), so a revoke that lands between the check and the release
   cannot be missed.
5. Revocation is final for the grant. A revoked grant is not reactivated by
   re-verifying its signature or by a new client trying again. A new grant is a
   new record.

## 2. Audit: what exists today

### 2.1 Secure Send (shipped)

| Item | Where | Behaviour |
|---|---|---|
| Revocation record | `secure_sends.canceled_at` (`db.py` ~407) | Set by `cancel_secure_send` (`db.py` ~3115), only for the sender (`sender_user_id` match). Also sets the ciphertext purge. |
| Use-time check on open | `db.py` `open_secure_send` (~3019) | Inside `tx()`, the row is read and `canceled_at`, `locked_out_at`, `expires_at` and `views_used` are checked before the view is counted and the ciphertext read. This is the gate. |
| Ciphertext removal | `cancel_secure_send` calls `purge_ciphertext` after commit | Revoke also removes the data, so a missed check still returns nothing. There is a short window between commit and purge; see gap G1. |
| Shell status check | `app.py` `receive_secure_send` (~3778) | Reads the row and renders the same "stopped" page for any inactive state. This is a read only and never reveals a view. The decision that matters is in `open_secure_send`. |
| Expiry | `secure_send.status_label`, `open_secure_send` | Checked at use. Expired rows are purged on touch and pruned by `prune_secure_sends`. |
| Lockout | `locked_out_at` | A stop state separate from revoke. Checked at use. |

### 2.2 Sessions (shipped; same pattern)

`user_sessions.revoked_at` and `revoke_reason` (`db.py` ~266). The row is looked up
on each authenticated request, and a set `revoked_at` ends the session
(`auth.py` ~553; `app.py` ~670-690 returns `session_revoked`). Revocation is
therefore use-time, not a signature check. Reasons are recorded
(`user`, `password`, `totp`, `passkey`, `duplicate`, ...).

### 2.3 Collaborator and calendar access (not shipped)

There is no multi-user ACL, no invitation object, and no signed grant in the
product today (`CALENDAR_SHARING_DESIGN.md` says so). The design sketch there
mentions signed invitations and key rotation as revocation. Key rotation is a
cryptographic revocation for future data. It does not, by itself, stop a
recipient who already holds the old key or old ciphertext. This spec adds the
server-side use-time check that such a design also needs.

### 2.4 Gaps

- **G1. Cancel commits, then purges.** `cancel_secure_send` commits the
  `canceled_at` update before `purge_ciphertext` runs. A concurrent open that
  reads the row after the commit is refused by `open_secure_send`, so the window
  is only about leftover blob files, not a served view. Keep it that way: the
  open path must keep checking `canceled_at` before it reads the blob.
- **G2. Shell and open disagree on wording only.** The shell returns the same
  "stopped" page for all inactive states, which is intended. Do not make the
  shell say "revoked" to a visitor; that would confirm the link existed.
- **G3. Revocation does not reach copies.** A recipient who opened a link already
  has the plaintext. Secure Send already says this (`docs/SHARE_LINK_CRYPTO.md`,
  "Recipient keeps/copies content").

## 3. Target: a revocation record for any grant

Any new grant type (collaborator, invitation, calendar share) must have:

| Field | Meaning |
|---|---|
| `grant_id` | Opaque, random, unique. The grant's signed payload must include it. |
| `owner_user_id` | Who may revoke. Revoke must check ownership like `cancel_secure_send` does. |
| `created_at`, `expires_at` | Bounded lifetime. No open-ended grants by default. |
| `revoked_at`, `revoke_reason` | Set once; never cleared. `revoke_reason` is one of a fixed list. |
| `use_count`, `max_uses` | Optional, for one-shot or limited links. Counted in the same transaction as the use. |

Revoke is an owner action, written as a single `UPDATE ... WHERE owner = ? AND
revoked_at = 0`. It must also remove or make unreadable any ciphertext the
grant released, when the server holds it.

### 3.1 Check points

Each of these must call the same check function:

1. Fetch or decrypt of shared ciphertext.
2. Any write made under the grant (for read/write access).
3. Accepting an invitation or redeeming a link.
4. Any key delivery to a recipient (for example a wrapped calendar key).
5. Background sync or pull that a grant made possible.

### 3.2 Caching

Do not cache a grant's status across requests on the server. If a cache is ever
added for speed, it must have a stated maximum staleness, and a revoke must
evict the cache entry. The spec default is no cache.

## 4. Limits (say these in the UI and docs)

- Revocation stops new uses. It does not reach plaintext already seen or saved.
- A server that is malicious or compromised can ignore its own revocation table.
  This is the same limit as in `docs/SHARE_LINK_CRYPTO.md`.
- Key rotation (cryptographic) and use-time checks (server gate) are separate
  mechanisms. A design that only does one of them does not get the other's
  guarantee.
- Signed grants prove who issued them. They do not expire or revoke themselves.

## 5. Tests the implementing task must add

- Revoked grant: open, fetch and key release all refused, with no ciphertext
  returned.
- Revoke racing an open: the open either wins before the revoke committed, or is
  refused. It never returns data after the revoke has committed.
- Record read failure (simulated DB error): the use is denied, not allowed.
- Signature or token still verifies after revoke: use is still refused.
- Non-owner revoke: refused, no change to the record.
- Revoke is final: a second grant request with the same `grant_id` does not
  reactivate it.

## 6. Files a later task must change

For the shipped Secure Send path, the existing tests to extend are
`tests/test_round_d2_secure_send.py` and the secure-send tests named in
`tests/test_app.py`. For a new grant type:

- `app/db.py`: schema (`CREATE TABLE`, guarded `ALTER`), the revoke function, and
  the check inside each use transaction.
- `app/secure_send.py` and `app/app.py`: the use endpoints (`/receive`, open,
  cancel) if Secure Send changes.
- `app/auth.py`: only if a grant is also a session or token.
- `app/static/js/` (secure-send and any new collaborator client): the client must
  handle the denied and revoked responses without a retry loop. Any change there
  requires regenerating the client manifest with `scripts/build-client-manifest.py`.
- `SECURITY.md` and `docs/SHARE_LINK_CRYPTO.md`: the limits in section 4.
