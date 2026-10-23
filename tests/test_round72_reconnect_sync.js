/**
 * Round 72 / 72.1: online-recovery force-pull retries until success,
 * including the CHANGE_POLL_MS slow tail after the fast window.
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

// Round 72.1: slow tail keeps ownership; no early drop to change-poll-only.
assert.ok(recovery.includes('inSlowTail') || recovery.includes('CHANGE_POLL_MS'));
assert.ok(recovery.includes('clearOnlineRecoveryCaption') || appJs.includes('function clearOnlineRecoveryCaption'));
assert.ok(appJs.includes('function stopOnlineRecovery'));
assert.ok(appJs.includes("stopOnlineRecovery('pagehide')") || appJs.includes('stopOnlineRecovery("pagehide")'));
assert.ok(appJs.includes("stopOnlineRecovery('offline')") || appJs.includes('stopOnlineRecovery("offline")'));
assert.ok(appJs.includes("stopOnlineRecovery('sign-out')") || appJs.includes('stopOnlineRecovery("sign-out")'));
assert.ok(recovery.includes('syncOnRecovery: false'), 'recovery owns the pull (no parallel probe sync)');

const delaysMatch = appJs.match(/ONLINE_RECOVERY_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
assert.ok(delaysMatch);
const delays = delaysMatch[1].split(',').map((s) => Number(s.trim()));
assert.deepStrictEqual(delays, [0, 1000, 2000, 4000, 8000]);
assert.strictEqual(delays.length - 1, 4, 'four fast retries after attempt 0');

// probeNetwork: skip parallel sync while recovery owns the wave.
const probe = appJs.split('async function probeNetwork')[1].split('function markNetworkReachable')[0];
assert.ok(probe.includes('NotesStore.isUnlocked()'));
assert.ok(probe.includes('!onlineRecoveryActive') || probe.includes('onlineRecoveryActive'));
assert.ok(!probe.includes('syncOnRecovery && vaultReady'));

// Offline-watch success restarts recovery.
const offlineWatch = appJs.split('function startOfflineWatch')[1].split('let lastRecoveryAbortAt')[0];
assert.ok(offlineWatch.includes('scheduleOnlineRecovery(0)'));

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
assert.ok(offlineHandler.includes('stopOnlineRecovery'));
assert.ok(!offlineHandler.includes('syncNow('));

assert.ok(appJs.includes('const CHANGE_POLL_MS = 25000'));

// --- behavioral harness mirroring Round 72.1 scheduleOnlineRecovery ----------
(async () => {
  const FAST_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
  const CHANGE_POLL_MS = 25000;
  let attemptLog = [];
  let waitLog = [];
  let syncCalls = 0;
  let pullResults = [];
  let onlineRecoveryActive = false;
  let generation = 0;
  let changePollScheduled = false;
  let offlineWatchStarted = false;
  let caption = 'Saved on this device · will sync when online';
  let unlocked = true;
  let visible = true;
  let navigatorOnline = true;
  let networkReachable = true;
  const vaultReady = false; // must still sync when unlocked
  const NotesStore = {
    isUnlocked: () => unlocked,
    state: { dirty: new Set() },
  };
  const ui = { saveStatus: { textContent: caption, classList: { remove() {} } } };

  function scheduleChangePoll() { changePollScheduled = true; }
  function startOfflineWatch() { offlineWatchStarted = true; }
  function stopOfflineWatch() { offlineWatchStarted = false; }
  function clearOnlineRecoveryCaption() {
    if (!(NotesStore.state?.dirty?.size) && /will sync when online/.test(ui.saveStatus.textContent || '')) {
      ui.saveStatus.textContent = 'Saved';
    }
  }
  function recoveryMayContinue() {
    if (!NotesStore.isUnlocked()) return false;
    return visible || navigatorOnline;
  }
  function stopOnlineRecovery() {
    onlineRecoveryActive = false;
    generation += 1;
  }
  let lockAfterNextSync = false;
  function syncNow() {
    syncCalls += 1;
    const ok = pullResults.shift();
    if (lockAfterNextSync) unlocked = false;
    return Promise.resolve(ok === true);
  }
  function probeNetwork() {
    return Promise.resolve(networkReachable);
  }

  function scheduleOnlineRecovery(attempt = 0) {
    if (attempt > 12) {
      onlineRecoveryActive = false;
      throw new Error(`runaway recovery at attempt ${attempt}`);
    }
    if (attempt === 0) {
      stopOfflineWatch();
      onlineRecoveryActive = true;
      generation += 1;
    }
    const gen = generation;
    if (!NotesStore.isUnlocked()) {
      onlineRecoveryActive = false;
      return Promise.resolve();
    }
    if (attempt > 0 && !recoveryMayContinue()) {
      onlineRecoveryActive = false;
      if (!networkReachable || !navigatorOnline) startOfflineWatch();
      return Promise.resolve();
    }
    const inSlowTail = attempt >= FAST_DELAYS_MS.length;
    const baseDelay = inSlowTail ? CHANGE_POLL_MS : FAST_DELAYS_MS[attempt];
    waitLog.push(baseDelay);
    return Promise.resolve().then(async () => {
      if (gen !== generation) return;
      if (!NotesStore.isUnlocked()) {
        onlineRecoveryActive = false;
        return;
      }
      const ok = await probeNetwork();
      if (!ok) {
        if (!networkReachable) {
          onlineRecoveryActive = false;
          startOfflineWatch();
          return;
        }
        await scheduleOnlineRecovery(attempt + 1);
        return;
      }
      if (!NotesStore.isUnlocked()) {
        onlineRecoveryActive = false;
        return;
      }
      assert.ok(NotesStore.isUnlocked());
      void vaultReady;
      attemptLog.push(attempt);
      const synced = await syncNow({ quiet: true, force: true });
      if (gen !== generation) return;
      if (synced === true) {
        onlineRecoveryActive = false;
        clearOnlineRecoveryCaption();
        scheduleChangePoll();
        return;
      }
      // Locked during sync — stop (mirrors production isUnlocked gate).
      if (!NotesStore.isUnlocked()) {
        onlineRecoveryActive = false;
        return;
      }
      await scheduleOnlineRecovery(attempt + 1);
    });
  }

  // 1) Aborted attempt 0 → attempt 1 still force-pulls.
  pullResults = [false, true];
  attemptLog = [];
  syncCalls = 0;
  waitLog = [];
  changePollScheduled = false;
  ui.saveStatus.textContent = 'Saved on this device · will sync when online';
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.deepStrictEqual(attemptLog, [0, 1]);
  assert.strictEqual(syncCalls, 2);
  assert.ok(!onlineRecoveryActive);
  assert.ok(changePollScheduled);

  // 2) Fast wave fails, slow tail succeeds, caption clears (pending 0).
  pullResults = [false, false, false, false, false, true]; // 0..4 fail, attempt 5 (slow) ok
  attemptLog = [];
  syncCalls = 0;
  waitLog = [];
  changePollScheduled = false;
  NotesStore.state.dirty = new Set();
  ui.saveStatus.textContent = 'Saved on this device · will sync when online';
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  assert.deepStrictEqual(attemptLog, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(syncCalls, 6);
  assert.ok(waitLog.includes(CHANGE_POLL_MS), 'slow tail waits CHANGE_POLL_MS');
  assert.ok(waitLog.every((w, idx) => (idx < 5 ? w === FAST_DELAYS_MS[idx] : w === CHANGE_POLL_MS)));
  // No request storm: at most one attempt per CHANGE_POLL_MS after fast window.
  const slowWaits = waitLog.slice(FAST_DELAYS_MS.length);
  assert.ok(slowWaits.every((w) => w >= CHANGE_POLL_MS));
  assert.strictEqual(ui.saveStatus.textContent, 'Saved');
  assert.ok(!onlineRecoveryActive);
  assert.ok(changePollScheduled);

  // 3) Remote-only change (pending 0) still resyncs on success path.
  pullResults = [true];
  attemptLog = [];
  syncCalls = 0;
  NotesStore.state.dirty = new Set(); // pending 0
  ui.saveStatus.textContent = 'Saved on this device · will sync when online';
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.deepStrictEqual(attemptLog, [0]);
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(ui.saveStatus.textContent, 'Saved');

  // 4) Recovery stops on lock (vault locked after first failed pull).
  pullResults = [false, false, false];
  attemptLog = [];
  syncCalls = 0;
  unlocked = true;
  lockAfterNextSync = true;
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  lockAfterNextSync = false;
  unlocked = true;
  assert.strictEqual(attemptLog.length, 1, `expected stop on lock after 1 attempt, got ${attemptLog}`);
  assert.ok(!onlineRecoveryActive);

  // 5) Recovery stops on sign-out (same as lock for harness) / pagehide.
  unlocked = true;
  pullResults = [false, false, false, false];
  attemptLog = [];
  onlineRecoveryActive = true;
  const genBefore = generation;
  stopOnlineRecovery('pagehide');
  assert.ok(!onlineRecoveryActive);
  assert.ok(generation > genBefore);

  // 6) Offline hands back to offline watch.
  unlocked = true;
  navigatorOnline = false;
  networkReachable = false;
  offlineWatchStarted = false;
  pullResults = [false];
  attemptLog = [];
  waitLog = [];
  // Start a wave; first probe fails offline → watch.
  networkReachable = false;
  await scheduleOnlineRecovery(0);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.ok(offlineWatchStarted, 'offline probe failure starts offline watch');
  assert.ok(!onlineRecoveryActive);

  // Reset navigator for cleanliness.
  navigatorOnline = true;
  networkReachable = true;
  unlocked = true;
  visible = true;

  console.log('test_round72_reconnect_sync ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
