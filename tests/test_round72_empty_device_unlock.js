/**
 * Round 72 Part A: false-offline unlock + empty-device fetch retry UI.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// --- static: force health + bootstrap-before-offline -----------------------
assert.ok(appJs.includes('async function serverUnreachableNow({ force = false } = {})'));
assert.ok(appJs.includes('timeoutMs: force ? 3000 : 1500'));
assert.ok(appJs.includes('await serverUnreachableNow({ force: true })'));
assert.ok(appJs.includes('isRealNetworkFailure(err)'));
assert.ok(appJs.includes('if (isRealNetworkFailure(err)) return { offline: true, err }'));

// Empty-device retry UI
assert.ok(appJs.includes('Getting your notes from the server…'));
assert.ok(appJs.includes("Can't reach the server right now. We'll keep trying in the background."));
assert.ok(appJs.includes('EMPTY_DEVICE_RETRY_DELAYS_MS'));
assert.ok(appJs.includes('fetchEmptyDeviceProofWithRetry'));
assert.ok(appJs.includes("err.code = 'EMPTY_DEVICE_FETCH_PENDING'"));
assert.ok(appJs.includes('unlock-empty-retry'));
assert.ok(appHtml.includes('id="unlock-empty-retry"'));
assert.ok(appHtml.includes('Try again'));
assert.ok(appCss.includes('.unlock-status.is-fetching::before'));

// Old immediate offline throw must not short-circuit empty-device unlock.
const emptyBlock = appJs.split('No local ciphertext and no repaired server row')[1]
  .split('if (serverResult.offline)')[0];
assert.ok(emptyBlock.includes('fetchEmptyDeviceProofWithRetry'));
assert.ok(!emptyBlock.includes('Connect once online while signed in to unlock an empty device'));

// --- behavioral: serverUnreachableNow with forced health -------------------
function makeServerUnreachableNow({ fetchHealthJson, notesNetworkReachable, navigatorOnline = true }) {
  return async function serverUnreachableNow({ force = false } = {}) {
    if (!force && navigatorOnline === false) return true;
    if (!force && typeof notesNetworkReachable === 'function' && !notesNetworkReachable()) {
      return true;
    }
    try {
      const data = await fetchHealthJson({
        force,
        timeoutMs: force ? 3000 : 1500,
      });
      return !(data && data.ok);
    } catch (err) {
      return true;
    }
  };
}

(async () => {
  let forced = false;
  const serverUnreachableNow = makeServerUnreachableNow({
    navigatorOnline: true,
    notesNetworkReachable: () => false,
    fetchHealthJson: async ({ force }) => {
      forced = !!force;
      if (!force) return null; // backoff
      return { ok: true };
    },
  });
  // Without force, stale networkReachable short-circuits.
  assert.strictEqual(await serverUnreachableNow(), true);
  assert.strictEqual(forced, false);
  // With force, health is probed even when networkReachable is false.
  assert.strictEqual(await serverUnreachableNow({ force: true }), false);
  assert.strictEqual(forced, true);

  // Backoff null without force → unreachable; with force → real probe.
  let calls = 0;
  const withBackoff = makeServerUnreachableNow({
    navigatorOnline: true,
    notesNetworkReachable: () => true,
    fetchHealthJson: async ({ force }) => {
      calls += 1;
      if (!force) return null;
      return { ok: true };
    },
  });
  assert.strictEqual(await withBackoff(), true);
  assert.strictEqual(await withBackoff({ force: true }), false);
  assert.ok(calls >= 2);

  // Unlock while __notesHealthNextAt is in the future still force-probes.
  const healthNextAt = Date.now() + 60_000;
  let forceArg = null;
  const duringBackoff = makeServerUnreachableNow({
    navigatorOnline: true,
    notesNetworkReachable: () => true,
    fetchHealthJson: async ({ force }) => {
      forceArg = force;
      if (!force && Date.now() < healthNextAt) return null;
      return { ok: true };
    },
  });
  assert.strictEqual(await duringBackoff(), true);
  assert.strictEqual(await duringBackoff({ force: true }), false);
  assert.strictEqual(forceArg, true);

  // --- UI: fetching → fallback + Try again ---------------------------------
  function el(init) {
    const state = {
      hidden: !!init.hidden,
      textContent: '',
      className: init.className || '',
      classList: {
        _set: new Set(String(init.className || '').split(/\s+/).filter(Boolean)),
        add(...names) { names.forEach((n) => this._set.add(n)); state.className = [...this._set].join(' '); },
        remove(...names) { names.forEach((n) => this._set.delete(n)); state.className = [...this._set].join(' '); },
        contains(name) { return this._set.has(name); },
      },
    };
    return state;
  }
  const status = el({ hidden: true, className: 'unlock-status muted' });
  const progress = el({ hidden: true, className: 'unlock-progress' });
  const retryBtn = el({ hidden: true });
  function setEmptyDeviceUnlockUi(mode) {
    if (mode === 'fetching') {
      status.hidden = false;
      status.classList.add('is-fetching');
      status.classList.remove('is-fallback');
      status.textContent = 'Getting your notes from the server…';
      progress.hidden = false;
      progress.classList.add('is-indeterminate');
      retryBtn.hidden = true;
      return;
    }
    if (mode === 'fallback') {
      status.hidden = false;
      status.classList.remove('is-fetching');
      status.classList.add('is-fallback');
      status.textContent = "Can't reach the server right now. We'll keep trying in the background.";
      progress.hidden = true;
      progress.classList.remove('is-indeterminate');
      retryBtn.hidden = false;
      return;
    }
    status.hidden = true;
    status.classList.remove('is-fetching', 'is-fallback');
    status.textContent = '';
    progress.hidden = true;
    retryBtn.hidden = true;
  }

  setEmptyDeviceUnlockUi('fetching');
  assert.strictEqual(status.textContent, 'Getting your notes from the server…');
  assert.ok(status.classList.contains('is-fetching'));
  assert.ok(retryBtn.hidden);

  setEmptyDeviceUnlockUi('fallback');
  assert.strictEqual(
    status.textContent,
    "Can't reach the server right now. We'll keep trying in the background.",
  );
  assert.ok(status.classList.contains('is-fallback'));
  assert.ok(!retryBtn.hidden);
  assert.ok(progress.hidden);

  // Retry delays: 0 + four fast retries (1/2/4/8s), then stop.
  const delaysMatch = appJs.match(/EMPTY_DEVICE_RETRY_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
  assert.ok(delaysMatch);
  const delays = delaysMatch[1].split(',').map((s) => Number(s.trim()));
  assert.deepStrictEqual(delays, [0, 1000, 2000, 4000, 8000]);

  // --- Background retry: no password capture, no verifyAndUnlock ------------
  const bgFn = appJs.split('function scheduleEmptyDeviceBackgroundRetry')[1]
    .split('async function fetchEmptyDeviceProofWithRetry')[0];
  assert.ok(bgFn.includes('probeEmptyDeviceServerReachable'));
  assert.ok(bgFn.includes('EMPTY_DEVICE_BG_PROBE_MS') || bgFn.includes('CHANGE_POLL_MS'));
  assert.ok(!/\bpassword\b/i.test(bgFn), 'background retry must not capture a password');
  assert.ok(!bgFn.includes('verifyAndUnlock'), 'background path must not call verifyAndUnlock');
  assert.ok(!bgFn.includes('NotesStore.unlock'), 'background path must not unlock');

  const probeFn = appJs.split('async function probeEmptyDeviceServerReachable')[1]
    .split('function scheduleEmptyDeviceBackgroundRetry')[0];
  assert.ok(probeFn.includes('fetchHealthJson'));
  assert.ok(probeFn.includes('loadAccount'));
  assert.ok(!probeFn.includes('verifyAndUnlock'));
  assert.ok(!/\bpassword\b/i.test(probeFn));

  // Timer cleared on lock, sign-out, successful unlock, pagehide.
  const lockFn = appJs.split('async function lockVault(')[1].split('async function ')[0];
  assert.ok(lockFn.includes('stopEmptyDeviceBackgroundRetry()'));
  const leaveFn = appJs.split('async function clearLocalVaultAndLeave')[1]
    .split('async function refreshCsrfFromAccount')[0];
  assert.ok(leaveFn.includes('stopEmptyDeviceBackgroundRetry()'));
  const pagehide = appJs.split("addEventListener('pagehide'")[1].split("addEventListener('pageshow'")[0];
  assert.ok(pagehide.includes('stopEmptyDeviceBackgroundRetry()'));
  const submitOk = appJs.split('async function submitUnlockForm')[1]
    .split("addEventListener('submit'")[0];
  assert.ok(submitOk.includes('stopEmptyDeviceBackgroundRetry()'));

  // Behavioral: stop clears timer; schedule does not take a password arg.
  let timer = 0;
  let generation = 0;
  let verifyCalls = 0;
  function clearEmptyDeviceBgRetry() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }
  function stopEmptyDeviceBackgroundRetry() {
    generation += 1;
    clearEmptyDeviceBgRetry();
  }
  function scheduleEmptyDeviceBackgroundRetry() {
    // Signature: zero args — no password closure.
    assert.strictEqual(arguments.length, 0);
    clearEmptyDeviceBgRetry();
    const gen = generation;
    timer = setTimeout(() => {
      timer = 0;
      if (gen !== generation) return;
      verifyCalls += 1; // must never run if stopped
    }, 20);
  }
  scheduleEmptyDeviceBackgroundRetry();
  assert.ok(timer);
  stopEmptyDeviceBackgroundRetry(); // lock / sign-out path
  assert.strictEqual(timer, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(verifyCalls, 0, 'stopped timer must not fire verifyAndUnlock');

  console.log('test_round72_empty_device_unlock ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
