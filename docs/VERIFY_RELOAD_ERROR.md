# /verify: `Failed to load resource: net::ERR_FAILED` on reload

Idea #192, found by the beta tester at commit `08f7d5b`. This is diagnosis
only. No app code was changed.

## Summary

| Question | Answer |
| --- | --- |
| Which resource fails? | `https://api.github.com/repos/deeperguard/Deeperguard/releases/tags/<RELEASE_TAG>` (for example `.../releases/tags/v0.65.132`). It is a `fetch` request. |
| `requestfailed` failure text | `net::ERR_FAILED` (resource type `fetch`) |
| Which code makes the request? | `fetchReleaseJson()` in `app/static/js/release-integrity.js`. It uses `mode: 'cors'`, `cache: 'no-store'` and `credentials: 'omit'`. |
| Where does the console line come from? | Chromium prints `Failed to load resource: net::ERR_FAILED` when that fetch fails at the network level. |
| When does the status line `Could not check (offline / rate-limited)` appear? | When `STATUS.unavailable` is returned. That happens when the GitHub request throws, or when GitHub answers 403/429 (the `rate_limited` path). See `formatMessage()` in `release-integrity.js`. |
| Product problem or test artefact? | See "Production or test artefact?" below. |

The same-origin assets are not the cause. `marketing.js` with its `integrity`
attribute, the same-origin `/static/client-manifest.json`, the CSS and the
service worker produced no failed request in any run. The service worker does
not handle `/verify` at all, because `isMarketingPage()` makes it return early
in `app/static/sw.js` (fetch handler).

## Reproduce

From the repo root, with Playwright and Chromium installed:

```
python3 tests/repro_verify_reload.py                    # normal network
python3 tests/repro_verify_reload.py --block-external   # simulates a sandbox without network
```

The script starts the app from this checkout through the existing
`tests/e2e_signup_autounlock.py` helpers. It opens `/verify` and reloads it 4
times. For each step it prints every `requestfailed` event (resource type, URL,
failure), every console message, page errors, requests to `api.github.com` and
the release status line. /verify is a public page, so no unlocked vault is
needed.

### Observed output

With `--block-external` (all non-local requests aborted), on the first load and
on each of the 4 reloads:

```
[reloadN] requestfailed fetch https://api.github.com/repos/deeperguard/Deeperguard/releases/tags/v0.65.132 -> net::ERR_FAILED
[reloadN] console.error: Failed to load resource: net::ERR_FAILED
[reloadN] status: Status: Could not check (offline / rate-limited)
```

This is exactly the signature the tester reported: one console line per
reload, no script error, no failed same-origin request, plus the "Could not
check" status line.

With normal network access in this environment, the load did not fail:

```
[goto]    request https://api.github.com/repos/deeperguard/Deeperguard/releases/tags/v0.65.132
[goto]    request https://api.github.com/repos/deeperguard/Deeperguard/releases/latest
[goto]    status: Matches signed release v0.65.132
[reload1..4] no GitHub request, no failure, status: Matches signed release v0.65.132
```

The result of a match is stored in `localStorage` (`notes_release_hash_check_v3`,
TTL 6 h), so reloads then make no GitHub request at all. A result of
`unavailable` is deliberately not treated as fresh (`cacheLooksFresh()`), so
every reload retries GitHub and fails again while the network stays down.

## Cause

`release-integrity.js` on /verify asks the GitHub release API for the signed
release. When that cross-origin request cannot complete (no network or DNS,
a blocking proxy or extension, or a CORS-less error response such as one
produced by a rate limiter), Chromium reports `net::ERR_FAILED` and logs it to
the console. The code handles the failure and shows "Could not check
(offline / rate-limited)". The console line is therefore the browser's own
log of an error the page already handles, not an uncaught error.

CSP is not involved. `connect-src` includes `https://api.github.com` on
/verify (`_csp_allows_github_api()` in `app/auth.py`). A CSP block would be
reported as a CSP violation, not `ERR_FAILED`. SRI is not involved either. An
SRI mismatch is reported as an integrity error on the script or stylesheet,
and `marketing.js` loaded every time.

## What is not established

The tester saw no error on the first open and an error on each reload. I did
**not** reproduce that "first load clean, reloads failing" pattern. A match is
cached, so reloads normally make no GitHub request. Two consistent
explanations remain, and neither could be confirmed here:

1. The first load did not use the cached match path (for example the tag or
   local hash differed from the cache, or the cache was cleared) and
   succeeded. A later check returned `unavailable` (network loss or
   rate limit), and `unavailable` is never cached, so each following reload
   retried and failed.
2. The tester's browser or network blocks `api.github.com` intermittently.
   The first load may have shown the error in a console that was not yet
   open.

The tester's step log does not contain the status line, which is why the two
could not be told apart. Next time, capture the `requestfailed` URL in
DevTools (Network, filter on `api.github.com`) and read
`localStorage['notes_release_hash_check_v3']`.

## Production or test artefact?

- **Test artefact (partly):** the error requires `api.github.com` to be
  unreachable. In a sandbox without external network it appears on every load
  and reload (reproduced above). No same-origin resource, SRI check or CSP rule
  is at fault.
- **Product observation:** in production the same line appears for any visitor
  whose network blocks or rate-limits `api.github.com`. It is harmless because
  the page handles it. It is still noisy, and a rate-limited response that
  lacks CORS headers shows up as `ERR_FAILED` rather than the 403/429 branch.
  So it is a minor product wart, not a break in the integrity check.

## Proposed fix (SRI and CSP unchanged)

The browser always logs a failed `fetch`, and page script cannot silence it.
So the fix is to avoid repeating the request, not to hide the log:

1. Cache an `unavailable` result for a short time, for example 5 to 10
   minutes, in `localStorage`, with a `retryAt` timestamp. Reloads inside that
   window should show the cached "Could not check (offline / rate-limited)"
   line and make no GitHub request. A manual "Check again" action (or expiry)
   would retry. `cacheLooksFresh()` currently refuses to cache `unavailable`
   so that About can retry. That would need a separate, short TTL for the
   /verify page.
2. Skip the GitHub call when `navigator.onLine === false` and show the same
   status line.
3. Add an e2e test that routes `https://api.github.com/**` to abort, reloads
   `/verify` 4 times and asserts that the number of GitHub requests is
   smaller than the number of loads. A second test should assert that the
   status line shows the offline text. `tests/repro_verify_reload.py` is a
   starting point.

No change to the `integrity` attributes, the signed manifest or the CSP is
needed.
