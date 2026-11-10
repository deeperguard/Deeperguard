# Security Phase 1 (pending release)

## User-visible changes

- Removed a legacy fallback that could send your account password to the server if SRP repair failed. Legacy password login and SRP resync endpoints now return HTTP 410.
- As of 2026-11-10, **0** production accounts used legacy login (non-SRP count on Vienna).
- This device remembers the strongest SRP and vault KDF versions it has seen and refuses weaker server challenges.
- Account 2FA setup, enable, disable, and verify share one per-user attempt limit; after repeated failures, 2FA changes are blocked for an hour.
- Disabling 2FA (SRP accounts) requires proving your password via the same rotation-token flow as vault password change.

**No action needed** for typical SRP users on current builds.
