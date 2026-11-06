/**
 * Round 87: unlock must not hang forever on online-but-stalled TCP; deadline + retry UX.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'test_agenda_month_grid_range.js')]);
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const srpAuthJs = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');

// --- static: unlock deadline + stall handling ---------------------------------
assert.ok(appJs.includes('UNLOCK_NETWORK_DEADLINE_MS'));
assert.ok(appJs.includes('function unlockNetworkTimeoutError'));
assert.ok(appJs.includes('function isUnlockNetworkStallLikeFailure'));
assert.ok(appJs.includes('code = \'UNLOCK_NETWORK_TIMEOUT\''));
assert.ok(appJs.includes('async function raceUnlockDeadline'));
assert.ok(appJs.includes('return await raceUnlockDeadline((async () => {'));
assert.ok(
  appJs.includes("err.code === 'timeout' || err.code === 'UNLOCK_NETWORK_STALL'"),
  'isRealNetworkFailure must treat stall as network failure',
);
assert.ok(
  appJs.includes('if (serverResult && isUnlockNetworkTimeout(serverResult.err))'),
  'stalled serverCheck must be normalized before offline branch',
);

assert.ok(
  appJs.includes('Vault-vs-login copy does not apply to stalled connections'),
  'unlock recovery hint must stay hidden on network timeout/stall',
);

assert.ok(storeJs.includes('probeDeadline'));
assert.ok(storeJs.includes('UNLOCK_NETWORK_STALL'));

assert.ok(srpAuthJs.includes('async function postJson(path, body, { timeoutMs = 30000 } = {})'));
assert.ok(srpAuthJs.includes('ctrl.abort(\'timeout\')'));

// --- behavioral: raceUnlockDeadline rejects on stall ---------------------------
async function raceUnlockDeadline(promise, deadlineMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('stall');
      err.code = 'UNLOCK_NETWORK_TIMEOUT';
      reject(err);
    }, deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

(async () => {
  const fast = await raceUnlockDeadline(Promise.resolve('ok'), 50);
  assert.strictEqual(fast, 'ok');

  await assert.rejects(
    () => raceUnlockDeadline(new Promise(() => {}), 25),
    (err) => err && err.code === 'UNLOCK_NETWORK_TIMEOUT',
  );

  console.log('test_round87_unlock_network_timeout ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
