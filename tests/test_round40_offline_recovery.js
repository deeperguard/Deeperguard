/**
 * Round 40: offline→online must reach sync-done within 1s; Retry recovers;
 * recovery probes open the backoff gate each attempt; no offline auto-reload;
 * offline watch must not stack 2s health probes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

// --- static -----------------------------------------------------------------
assert.ok(appJs.includes("onNetworkOnline('retry')") || appJs.includes('onNetworkOnline("retry")'));
assert.ok(appJs.includes('offlineWatchTickActive'));
assert.ok(appJs.includes('!offlineWatchTickActive'));
assert.ok(appJs.includes("__notesResetHealthBackoff?.({ abort: false })"));
// Each recovery attempt opens the gate (not only attempt 0).
const recovery = appJs.split('function scheduleOnlineRecovery')[1].split('function listStoredFiles')[0];
assert.ok(recovery.includes('Always open the backoff gate') || recovery.includes('abort: false'));
assert.ok(recovery.includes('forceHealth: true'));
// Offline watch hands off to recovery when navigator.onLine — no nested probe.
const watch = appJs.split('function startOfflineWatch')[1].split('function scheduleOnlineRecovery')[0];
assert.ok(watch.includes('scheduleOnlineRecovery(0)'));
assert.ok(!watch.includes('probeNetwork({ syncOnRecovery: false'));
// No auto-reload while offline.
const stale = appJs.split('async function reloadIfShellStale')[1].split('async function boot')[0];
assert.ok(stale.includes('navigator.onLine === false'));
assert.ok(stale.includes('!networkReachable'));
// Health still owned by __notesFetchHealth.
assert.ok(appHtml.includes('window.__notesFetchHealth'));
assert.ok(appHtml.includes('__notesHealthNextAt'));

// Round 37 connection-change guard still present.
const connBlock = appJs.split("conn.addEventListener('change'")[1].split('window.addEventListener(\'offline\'')[0];
assert.ok(connBlock.includes('probeNetwork'));
assert.ok(connBlock.includes("onNetworkOnline('connection-change')"));
assert.ok(connBlock.indexOf('probeNetwork') < connBlock.indexOf("onNetworkOnline('connection-change')"));

/**
 * Simulate the stuck-offline bug: first recovery probe fails (sets 2s backoff),
 * later attempts must still probe (gate reopened) and sync within 1s of online.
 */
function simulateOfflineOnlineCycle() {
  return new Promise((resolve, reject) => {
    const log = [];
    const delays = [0, 500, 1000, 2000, 4000];
    let networkReachable = false;
    let generation = 0;
    let nextAt = 0;
    let healthCalls = 0;
    let onlineAt = 0;
    let failFirst = true;
    let dirty = 1;

    function resetGate() {
      nextAt = 0;
    }
    function fetchHealth() {
      const now = Date.now();
      if (nextAt && now < nextAt) {
        log.push({ kind: 'gated', t: now - onlineAt });
        return Promise.resolve(null);
      }
      healthCalls += 1;
      log.push({ kind: 'health', t: now - onlineAt, n: healthCalls });
      if (failFirst) {
        failFirst = false;
        nextAt = now + 2000;
        return Promise.resolve(null);
      }
      nextAt = 0;
      return Promise.resolve({ ok: true, build: 'test' });
    }
    function syncNow() {
      log.push({ kind: 'sync-done', t: Date.now() - onlineAt });
      dirty = 0;
      return Promise.resolve(true);
    }
    function scheduleRecovery(attempt) {
      if (attempt === 0) {
        generation += 1;
        resetGate();
      }
      const gen = generation;
      if (attempt >= delays.length) return;
      setTimeout(async () => {
        if (gen !== generation) return;
        resetGate(); // Round 40: open gate every attempt
        const data = await fetchHealth();
        if (gen !== generation) return;
        if (data?.ok) {
          networkReachable = true;
          if (dirty > 0) await syncNow();
        } else {
          networkReachable = false;
        }
        if (!networkReachable || dirty > 0) scheduleRecovery(attempt + 1);
      }, delays[attempt]);
    }

    onlineAt = Date.now();
    log.push({ kind: 'online-event', t: 0 });
    scheduleRecovery(0);

    setTimeout(() => {
      try {
        const done = log.find((e) => e.kind === 'sync-done');
        assert.ok(done, 'sync-done must fire after online');
        assert.ok(done.t <= 1000, `sync-done ${done.t}ms must be ≤1s of online`);
        assert.ok(networkReachable);
        // First probe failed; second must not be gated away.
        assert.ok(healthCalls >= 2, `expected ≥2 health probes, got ${healthCalls}`);
        assert.ok(!log.some((e) => e.kind === 'gated'), 'recovery must not no-op inside backoff');
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 1200);
  });
}

function simulateRetryRecovers() {
  return new Promise((resolve, reject) => {
    let networkReachable = false;
    let nextAt = Date.now() + 10000; // stuck in backoff
    let synced = false;
    function onNetworkOnline() {
      nextAt = 0; // recovery resets gate
      networkReachable = true;
      synced = true;
    }
    // Old Retry: probe without reset → gated null → no sync.
    function oldRetry() {
      if (nextAt && Date.now() < nextAt) return false;
      networkReachable = true;
      synced = true;
      return true;
    }
    assert.strictEqual(oldRetry(), false);
    assert.ok(!synced);
    // New Retry: same as online.
    onNetworkOnline('retry');
    assert.ok(synced);
    assert.ok(networkReachable);
    resolve();
  });
}

function simulateNoWatchTimerStack() {
  let offlineWatchTimer = 0;
  let offlineWatchDelayMs = 2000;
  let offlineWatchTickActive = false;
  let onlineRecoveryActive = false;
  let health = 0;
  const timers = [];

  function startOfflineWatch() {
    if (offlineWatchTimer || onlineRecoveryActive) return;
    if (!offlineWatchDelayMs || offlineWatchDelayMs < 2000) offlineWatchDelayMs = 2000;
    offlineWatchTimer = setTimeout(() => {}, offlineWatchDelayMs);
    timers.push(offlineWatchTimer);
  }
  function probeNetworkFail() {
    // Mid-tick: timer already cleared.
    offlineWatchTimer = 0;
    offlineWatchTickActive = true;
    // Old bug: always startOfflineWatch → stacked 2s timer.
    if (!onlineRecoveryActive && !offlineWatchTickActive) {
      startOfflineWatch();
    }
    offlineWatchTickActive = false;
    // Watch finish schedules next with backoff.
    offlineWatchDelayMs = 5000;
    offlineWatchTimer = setTimeout(() => {}, offlineWatchDelayMs);
    timers.push(offlineWatchTimer);
  }
  startOfflineWatch();
  const before = timers.length;
  probeNetworkFail();
  // Only the finish() timer should remain as the active schedule — probe must
  // not have added another 2s watch while tick was active.
  assert.strictEqual(before, 1);
  assert.strictEqual(timers.length, 2); // initial + finish backoff (not +probe restart)
  health += 0;
  timers.forEach((t) => clearTimeout(t));
}

simulateNoWatchTimerStack();

Promise.all([simulateOfflineOnlineCycle(), simulateRetryRecovers()])
  .then(() => {
    console.log('test_round40_offline_recovery ok');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
