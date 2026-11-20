# Vault-keys write token lost to a concurrent session write (follow-up of task 396)

## Status: open, needs investigation (app issue, not a test issue)

The vault-keys write token from `POST /api/account/vault-keys/prove`
(`app/app.py:2378-2395`, `auth.issue_vault_keys_token()`) is stored only in the
Flask session cookie. Another request that started before the proof and finishes
after it sends back the session as it was when it started, so the token is gone.
The next wrap write (`_vault_keys_write_gate`, `app/app.py:2398-2407`) then gets
`401 invalid or expired token`, and the client has to run a new (slow) password proof.

`should_set_cookie` (`app/app.py:108-119`) already stops the health poll GET from
rewriting the cookie. Any other request in flight at that moment (account refresh,
sync and other writes) can still overwrite it.

`tests/test_e2e_passkey_vault_unlock.py` (task 396) works around this with `_settle`,
which waits until no request is in flight before each passkey step. A fast user who
starts a passkey action while sync is running can hit the same 401 in the app.

## To investigate

- Keep the token somewhere that a stale session write cannot overwrite, for example
  server-side keyed by session/user with an expiry, or return it to the client only
  and check it against a server-side record.
- Or have the client retry the proof once on a 401 from the write endpoints.
- After a fix, check whether `_settle` in the e2e test is still needed.
