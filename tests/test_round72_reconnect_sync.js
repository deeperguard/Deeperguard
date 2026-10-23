/**
 * Round 72 Part B: online-recovery force-pull retries until success.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

const recovery = appJs.split('function scheduleOnlineRecovery')[1].split('function listStoredFiles')[0];

assert.ok(appJs.includes('ONLINE_RECOVERY_DELAYS_MS'));
assert.ok(recovery.includes('NotesStore.isUnlocked()'));
assert.ok(recovery.includes('syncNow({ quiet: true, force: true })'));
assert.ok(recovery.includes('synced === true') || recovery.includes('synced: synced === true'));
assert.ok(recovery.includes('scheduleChangePoll()'));
assert.ok(!recovery.includes('attempt === 0 && vaultReady'));
assert.ok(!recovery.includes('stillDirty > 0'));

const delaysMatch = appJs.match(/ONLINE_RECOVERY_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
assert.ok(delaysMatch);
const delays = delaysMatch[1].split(',').map((s) => Number(s.trim()));
assert.deepStrictEqual(delays, [0, 1000, 2000, 4000, 8000]);
assert.strictEqual(delays.length - 1, 4, 'four fast retries after attempt 0');

// probeNetwork quiet recovery also gates on unlocked (not only vaultReady).
const probe = appJs.split('async function probeNetwork')[1].split('function markNetworkReachable')[0];
assert.ok(probe.includes('syncOnRecovery && NotesStore.isUnlocked()'));
assert.ok(!probe.includes('syncOnRecovery && vaultReady'));

// syncNow reports true/false so recovery can distinguish abort from success.
assert.ok(appJs.includes('return true;'));
assert.ok(appJs.includes("err?.code === 'aborted'"));
assert.ok(appJs.includes('return false;'));

// R39: still one abort owner, no sync on offline, no foreground-online syncNow.
const onlineFn = appJs.split('function onNetworkOnline')[1].split("window.addEventListener('online'")[0];
assert.ok(onlineFn.includes('scheduleOnlineRecovery(0)'));
assert.ok(!onlineFn.includes('abortInflightApi'));
assert.ok(!onlineFn.includes('syncNow('));

const offlineHandler = appJs.split("addEventListener('offline'")[1].split("addEventListener('submit'")[0];
assert.ok(offlineHandler.includes("abortInflightApi?.('offline')") || offlineHandler.includes("abortInflightApi('offline')"));
assert.ok(!offlineHandler.includes('syncNow('));

// --- behavioral: aborted attempt 0 → attempt 1 still force-pulls ------------
(async () => {
  const delaysMs = [0, 1000, 2000, 4000, 8000];
  let attemptLog = [];
  let syncCalls = 0;
  let pullResults = [false, true]; // attempt 0 aborted/failed, attempt 1 ok
  let networkReachable = true;
  let onlineRecoveryActive = false;
  let generation = 0;
  let changePollScheduled = false;
  const vaultReady = false; // must still sync when unlocked
  const NotesStore = {
    isUnlocked: () => true,
    state: { dirty: new Set() },
  };
  function scheduleChangePoll() { changePollScheduled = true; }
  function syncNow() {
    syncCalls += 1;
    const ok = pullResults.shift();
    return Promise.resolve(ok === true);
  }
  function probeNetwork() {
    return Promise.resolve(true);
  }

  function scheduleOnlineRecovery(attempt = 0) {
    if (attempt === 0) {
      onlineRecoveryActive = true;
      generation += 1;
    }
    const gen = generation;
    if (attempt >= delaysMs.length) {
      onlineRecoveryActive = false;
      scheduleChangePoll();
      return;
    }
    // Use 0 wait in the test harness (delays only constrain attempt count).
    return Promise.resolve().then(async () => {
      if (gen !== generation) return;
      const ok = await probeNetwork();
      if (!ok) {
        scheduleOnlineRecovery(attempt + 1);
        return;
      }
      if (!NotesStore.isUnlocked()) {
        onlineRecoveryActive = false;
        return;
      }
      // Gate must not require vaultReady.
      assert.ok(NotesStore.isUnlocked());
      void vaultReady;
      attemptLog.push(attempt);
      const synced = await syncNow({ quiet: true, force: true });
      if (synced === true) {
        onlineRecoveryActive = false;
        scheduleChangePoll();
        return;
      }
      scheduleOnlineRecovery(attempt + 1);
    });
  }

  await scheduleOnlineRecovery(0);
  // Drain microtasks for the chained retries.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  assert.deepStrictEqual(attemptLog, [0, 1]);
  assert.strictEqual(syncCalls, 2);
  assert.ok(!onlineRecoveryActive);
  assert.ok(changePollScheduled);

  // Retry limit: at most 5 attempts (0 + 4), then CHANGE_POLL fallback.
  attemptLog = [];
  syncCalls = 0;
  pullResults = [false, false, false, false, false];
  changePollScheduled = false;
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.ok(attemptLog.length <= 5, `expected ≤5 fast attempts, got ${attemptLog.length}`);
  assert.deepStrictEqual(attemptLog, [0, 1, 2, 3, 4]);
  assert.strictEqual(syncCalls, 5);
  assert.ok(changePollScheduled, 'exhausted fast retries fall back to change poll');

  // CHANGE_POLL_MS remains 25s.
  assert.ok(appJs.includes('const CHANGE_POLL_MS = 25000'));

  console.log('test_round72_reconnect_sync ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
