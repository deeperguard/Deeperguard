# False "You're offline" banner after reload (idea #199)

Status: investigated and **fixed** (see "Applied fix"). The findings below were measured before the fix. Checked on `main` at 44e834d with
`tests/e2e_offline_banner_after_reload.py` (Playwright, `/usr/bin/chromium`, a real
local server started by the same helper the other e2e tests use).

## Summary

| Question | Answer |
| --- | --- |
| Reproducible with the tester's steps on a healthy server? | **No.** Three runs, banner never shown. |
| Can the banner appear while the server is up? | **Sometimes, briefly.** One failed `/api/health` request is enough. |
| Is `#btn-network-retry` clickable? | **Yes** whenever the banner is really shown. It is visible, enabled and not covered. |
| Why did the tester's click time out (6000 ms)? | Most likely the banner had already hidden itself again. Not reproduced as a timeout, see below. |

## Steps run

Register, create the parent label `boodschappen` and the sub-label `winkel`
(`NotesStore.createTag`), a note `Lijstje` with the sub-label, `pushDirty`, reload,
unlock, expand the sidebar, click the parent label `boodschappen` in the label tree
(one note row remained). After every step the script reads `#network-status-banner`
and `#btn-network-retry` (hidden attribute, computed style, `disabled`,
`document.elementFromPoint` at the centre of the button).

Results, run without options: banner hidden after create, after reload (locked), after
unlock and after the filter; `navigator.onLine` true and `notesNetworkReachable()` true
throughout; four `/api/health` responses, all 200. So the steps themselves do not
produce the banner.

## Where the offline state is set

`networkReachable` in `app/static/js/app.js:3429` drives the banner
(`updateNetworkStatusBanner`, `app/static/js/app.js:2501`). It becomes false at:

1. `probeNetwork` catch, `app/static/js/app.js:10597-10603`: any failed or
   non-`ok` `/api/health` (1500 ms timeout, line 10564).
2. The `offline` window event, `app/static/js/app.js:26529` (real offline only).
3. A failed sync that `NotesStore.isProbablyOffline` classifies as offline,
   `app/static/js/app.js:26240` (message matches `failed to fetch|timed out|offline`,
   `app/static/js/store.js:1219-1226`).

It becomes true again in `probeNetwork` success (`app.js:10568`) and
`markNetworkReachable` (`app.js:10613`), which a successful sync calls at
`app.js:26188`.

Not involved: the service worker only serves an "You're offline" page with a
**Reload** button (`app/static/sw.js:297`), a different element without the
`#btn-network-retry` id. A session refresh does not touch `networkReachable`.

## Cause of the false banner

`/api/health` is the only probe, and a failure of that single request flips the
whole app to offline, even though other requests (the vault sync) work.
`window.__notesFetchHealth` (`app/templates/app.html:165-168`) also returns `null`
for every non-forced caller during the 2 s / 5 s / 10 s backoff after one failure, and
`probeNetwork` turns `null` into "offline" (`app.js:10565`). Foreground (`app.js:26376`,
on `visibilitychange`), the 30 s probe (`app.js:10640`) and the offline watch all use
that path.

Reproduced by aborting one `/api/health` request after unlock and then firing
`visibilitychange` (`--fail-after-unlock 1`). Observed twice: the banner became visible
(`hidden=false`) at about 2115 ms and hidden again 25-26 ms later, when the sync that
the same foreground event started finished and called `markNetworkReachable`
(`app.js:26188`). The stack at the show was `probeNetwork` (10603), at the hide
`markNetworkReachable` (26188). The server never went down.

On a real slow or busy server (health slower than 1.5 s, sync slower still) the same
sequence keeps the banner visible for the length of the sync. I did **not** reproduce
that long variant; the 25 ms figure is for this tiny vault.

A failed health probe while still **locked** (`--fail-health 1`) leaves
`notesNetworkReachable()` false after the reload, but the banner is hidden while locked
(`app.js:2505`) and the unlock path re-probes, so it was true again after unlock.

## Why Retry was not clickable

Measured with the browser really offline (`--offline`): the banner is shown, the
button is visible, not disabled, and `elementFromPoint` at its centre is the button
itself (no overlay). `page.click('#btn-network-retry', {timeout: 6000})` succeeded in
under 0.1 s. Its handler is attached at `app.js:26671`.

So the button is not hidden, covered or disabled while the banner exists. The banner
(`#network-status-banner[hidden]`) is hidden whenever `networkReachable` is true,
and Playwright's `click` waits for a visible element. With the flash above, the
banner is gone by the time a script reaches it, and the click waits until the 6000 ms
timeout. This matches the tester's report, but it is an inference: I could not
reproduce a 6000 ms timeout itself.

## Applied fix

`probeNetwork` (`app/static/js/app.js`, catch block) no longer flips the app to
offline on the first failed health check. While the app thinks it is reachable and
`navigator.onLine` is not `false`, it clears the health failure backoff gate
(`__notesResetHealthBackoff({ abort: false })`, without aborting anything in flight)
and probes once more (`confirming: true`). Only when that second probe also fails
does `networkReachable` become false and the banner show. One extra
request of at most 1.5 s is the cost.

Unchanged: the `offline` window event and sync failures classified by
`isProbablyOffline` still set the offline state immediately, `#btn-network-retry` and
the banner markup are untouched, and no crypto, auth or sync-format code changed.

The backoff gate had to be cleared because `window.__notesFetchHealth` (`force`) only
bypasses the success cache, not the failure backoff; a forced probe alone would have
returned `null` again right after the first failure.

Tests (`tests/test_e2e_offline_banner.py`, Playwright against a local server):

- Reload, unlock, filter on the parent label `boodschappen` while one `/api/health`
  request is aborted by a foreground event: the banner never gets shown.
- With the whole `/api/**` unreachable: the banner appears and `#btn-network-retry` is
  visible, enabled, not covered, and a click reaches its handler. (Only `/api/health`
  failing is not enough here: a successful sync correctly clears the banner again.)

`tests/e2e_offline_banner_after_reload.py` remains as the manual reproduction script.
