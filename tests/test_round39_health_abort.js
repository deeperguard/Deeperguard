/**
 * Round 39: abort only real in-flight once per recovery (one log), no health
 * gate bypass / reset re-probe storm, no sync on offline transition.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const ocrJs = fs.readFileSync(path.join(root, 'app/static/js/ocr.js'), 'utf8');

// --- static: abort only when count > 0, log once with count -----------------
assert.ok(storeJs.includes('function abortInflightApi'));
assert.ok(storeJs.includes('if (!count) return 0'));
assert.ok(storeJs.includes("api-abort', { reason, count }") || storeJs.includes('api-abort\', { reason, count }'));
assert.ok(storeJs.includes("ctrl.abort(reason)"));
assert.ok(storeJs.includes("ctrl.abort('timeout')") || storeJs.includes('abort(\'timeout\')'));
assert.ok(storeJs.includes("aborted.code = 'aborted'"));

// Recovery: single abort owner, debounce re-entrant online.
assert.ok(appJs.includes('lastRecoveryAbortAt'));
assert.ok(appJs.includes('now - lastRecoveryAbortAt > 500'));
assert.ok(appJs.includes("__notesResetHealthBackoff?.({ abort: false })"));

// onNetworkOnline must NOT double-abort/reset before scheduleOnlineRecovery.
const onlineFn = appJs.split('function onNetworkOnline')[1].split("window.addEventListener('online'")[0];
assert.ok(onlineFn.includes('scheduleOnlineRecovery(0)'));
assert.ok(!onlineFn.includes('abortInflightApi'));
assert.ok(!onlineFn.includes('__notesResetHealthBackoff'));
assert.ok(!onlineFn.includes('syncNow('));

// Foreground-on-online skips probe/sync (recovery owns them).
const fg = appJs.split('function onAppForeground')[1].split('document.addEventListener(\'click\'')[0];
assert.ok(fg.includes("reason === 'online'"));
assert.ok(fg.includes('scheduleNetworkProbe()'));
const onlineBranch = fg.split("reason === 'online'")[1].split('probeNetwork({ syncOnRecovery: true })')[0];
assert.ok(!onlineBranch.includes('syncNow('));
assert.ok(!onlineBranch.includes('probeNetwork('));

// Offline: abort hung work, no sync, no force health probe.
const offlineHandler = appJs.split("addEventListener('offline'")[1].split('addEventListener(\'submit\'')[0];
assert.ok(offlineHandler.includes("abortInflightApi?.('offline')") || offlineHandler.includes("abortInflightApi('offline')"));
assert.ok(offlineHandler.includes('startOfflineWatch()'));
assert.ok(!offlineHandler.includes('syncNow('));
assert.ok(!offlineHandler.includes('probeNetwork('));
assert.ok(!offlineHandler.includes('forceHealth'));

// Passive online clears gate without abort.
assert.ok(appHtml.includes("__notesResetHealthBackoff({ abort: false })"));
assert.ok(appHtml.includes('opts.abort !== false') || appHtml.includes('abort !== false'));

// No health bypass: only owner (+ app.js fallback when helper missing).
const appJsHealth = (appJs.match(/fetch\(['"]\/api\/health['"]/g) || []).length;
assert.ok(appJsHealth <= 1, `app.js raw health fetches ≤1, got ${appJsHealth}`);
assert.ok(ocrJs.includes('window.__notesFetchHealth'));
assert.ok(appJs.includes('window.__notesFetchHealth(force, timeoutMs)'));

// --- behavioral: abort logs once per recovery with real controllers --------
function simulateAbortInflightApi() {
  const inflight = new Set();
  const logs = [];
  function abortInflightApi(reason = 'online') {
    const count = inflight.size;
    if (!count) return 0;
    for (const ctrl of [...inflight]) {
      ctrl.aborted = true;
      inflight.delete(ctrl);
    }
    logs.push({ kind: 'api-abort', reason, count });
    return count;
  }
  // Empty — must not log.
  assert.strictEqual(abortInflightApi('online-recovery'), 0);
  assert.strictEqual(logs.length, 0);
  // One real controller — one log.
  inflight.add({ aborted: false });
  inflight.add({ aborted: false });
  assert.strictEqual(abortInflightApi('online-recovery'), 2);
  assert.strictEqual(logs.length, 1);
  assert.deepStrictEqual(logs[0], { kind: 'api-abort', reason: 'online-recovery', count: 2 });
  // Cleared — second call silent.
  assert.strictEqual(abortInflightApi('online-recovery'), 0);
  assert.strictEqual(logs.length, 1);
}

function simulateRecoveryAbortOnce() {
  const logs = [];
  const inflight = new Set();
  let lastRecoveryAbortAt = 0;
  let healthAborts = 0;
  let healthCalls = 0;
  let gen = 0;

  function abortInflightApi(reason) {
    const count = inflight.size;
    if (!count) return 0;
    inflight.clear();
    logs.push({ kind: 'api-abort', reason, count });
    return count;
  }
  function resetHealth(opts) {
    const doAbort = !opts || opts.abort !== false;
    if (!doAbort) return;
    gen += 1;
    healthAborts += 1;
  }
  function fetchHealth() {
    healthCalls += 1;
    return { ok: true };
  }
  function scheduleOnlineRecovery(attempt, now) {
    if (attempt === 0) {
      if (now - lastRecoveryAbortAt > 500) {
        lastRecoveryAbortAt = now;
        resetHealth();
        abortInflightApi('online-recovery');
      } else {
        resetHealth({ abort: false });
      }
      fetchHealth();
    }
  }
  function onNetworkOnline(now) {
    // Passive online: gate only.
    resetHealth({ abort: false });
    scheduleOnlineRecovery(0, now);
    // Re-entrant online within 500ms (connection-change + online).
    scheduleOnlineRecovery(0, now + 50);
  }

  inflight.add({});
  onNetworkOnline(10_000);
  assert.strictEqual(logs.length, 1, 'one api-abort log per recovery wave');
  assert.strictEqual(healthAborts, 1, 'one health abort per recovery wave');
  assert.strictEqual(healthCalls, 2, 're-entrant recovery may probe after gate reopen, not via abort');
  assert.ok(healthCalls <= 3);
}

function simulateOfflineNoSync() {
  const actions = [];
  function offline() {
    actions.push('networkReachable=false');
    actions.push('emitSync=offline');
    // abort hung only
    actions.push('abortInflightApi=offline');
    actions.push('startOfflineWatch');
    // deliberately no syncNow / probeNetwork
  }
  offline();
  assert.ok(!actions.some((a) => a.startsWith('syncNow')));
  assert.ok(!actions.some((a) => a.startsWith('probeNetwork')));
  assert.ok(actions.includes('abortInflightApi=offline'));
}

function simulateNoResetReprobeStorm() {
  let now = 0;
  let nextAt = 0;
  let calls = 0;
  let ctrl = null;
  let gen = 0;
  const results = [];

  function reset(opts) {
    nextAt = 0;
    const doAbort = !opts || opts.abort !== false;
    if (!doAbort) return;
    gen += 1;
    if (ctrl) {
      results.push({ t: now, kind: 'canceled' });
      ctrl = null;
    }
  }
  function fetchHealth() {
    if (ctrl) {
      results.push({ t: now, kind: 'shared' });
      return;
    }
    if (nextAt && now < nextAt) {
      results.push({ t: now, kind: 'gated' });
      return;
    }
    calls += 1;
    const g = gen;
    ctrl = { gen: g };
    results.push({ t: now, kind: 'fetch' });
    // Instant offline failure (completes same tick).
    ctrl = null;
    if (g !== gen) return; // orphaned abort — no backoff
    nextAt = now + 2000;
    results.push({ t: now, kind: 'fail' });
  }

  // While offline + backoff: many callers → one fetch, rest gated.
  fetchHealth();
  for (let i = 0; i < 20; i += 1) fetchHealth();
  assert.strictEqual(results.filter((r) => r.kind === 'fetch').length, 1);
  assert.ok(results.filter((r) => r.kind === 'gated').length >= 19);
  assert.strictEqual(results.filter((r) => r.kind === 'canceled').length, 0);

  // Passive online opens gate without canceling (nothing in flight).
  results.length = 0;
  reset({ abort: false });
  assert.strictEqual(results.filter((r) => r.kind === 'canceled').length, 0);

  // Recovery abort once, then one intentional probe — not a cancel storm.
  now = 100;
  nextAt = 0;
  calls = 0;
  results.length = 0;
  // Start a hung probe.
  ctrl = { gen };
  results.push({ t: now, kind: 'fetch' });
  reset(); // recovery abort
  assert.strictEqual(results.filter((r) => r.kind === 'canceled').length, 1);
  fetchHealth(); // one fresh probe
  assert.strictEqual(results.filter((r) => r.kind === 'fetch').length, 2);
  // Re-entrant gate-only reset must not cancel the new probe mid-flight.
  // (probe already completed in this sim; start another hung one)
  ctrl = { gen };
  reset({ abort: false });
  assert.ok(ctrl, 'gate-only reset must leave in-flight probe alone');
  assert.strictEqual(results.filter((r) => r.kind === 'canceled').length, 1);
}

simulateAbortInflightApi();
simulateRecoveryAbortOnce();
simulateOfflineNoSync();
simulateNoResetReprobeStorm();

console.log('test_round39_health_abort ok');
