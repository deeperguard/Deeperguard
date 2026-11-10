# Security Phase 1 (pending release)

## User-visible changes

- Sign-in no longer falls back to sending your account password to the server when SRP repair fails; legacy password login and SRP resync endpoints return HTTP 410.
- This device remembers the strongest SRP and vault KDF versions it has seen and refuses weaker server challenges.
- Account 2FA setup, enable, disable, and verify share one per-user attempt limit; after repeated failures, 2FA changes are blocked for an hour and a sign-in alert email may be sent.
- Disabling 2FA (SRP accounts) requires proving your password via the same rotation-token flow as vault password change.

**No action needed** for typical SRP users on current builds.
