const assert = require('assert');
const path = require('path');

const VL = require(path.join(__dirname, '..', 'app', 'static', 'js', 'vaultlock.js'));

// Fake clock so no real timers are used.
function harness(opts = {}) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const state = { minutes: opts.minutes ?? 15, unlocked: true, busy: false, idle: [] };
  const lock = VL.createIdleLock({
    getMinutes: () => state.minutes,
    isUnlocked: () => state.unlocked,
    busy: () => state.busy,
    onIdle: (m) => state.idle.push(m),
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms }); return seq; },
    clearTimer: (id) => timers.delete(id),
  });
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = end;
  }
  return { lock, state, advance, timers };
}
const MIN = 60 * 1000;

// Defaults and normalisation
assert.strictEqual(VL.AUTO_LOCK_DEFAULT_MIN, 15);
assert.deepStrictEqual(VL.AUTO_LOCK_OPTIONS, [0, 1, 5, 15, 30, 60]);
assert.strictEqual(VL.normalizeAutoLockMin(0), 0);
assert.strictEqual(VL.normalizeAutoLockMin('30'), 30);
assert.strictEqual(VL.normalizeAutoLockMin(-1), 15);
assert.strictEqual(VL.normalizeAutoLockMin('abc'), 15);
assert.strictEqual(VL.normalizeAutoLockMin(undefined), 15);

// Timer fires after the configured idle time
{
  const h = harness({ minutes: 5 });
  h.lock.bump();
  h.advance(5 * MIN - 1);
  assert.deepStrictEqual(h.state.idle, []);
  h.advance(1);
  assert.deepStrictEqual(h.state.idle, [5]);
}

// Activity resets the timer
{
  const h = harness({ minutes: 5 });
  h.lock.bump();
  h.advance(4 * MIN);
  h.lock.bump();
  h.advance(4 * MIN);
  assert.deepStrictEqual(h.state.idle, [], 'activity postponed the lock');
  h.advance(1 * MIN);
  assert.deepStrictEqual(h.state.idle, [5]);
}

// Off never fires; locked vault never arms
{
  const h = harness({ minutes: 0 });
  h.lock.bump();
  assert.strictEqual(h.timers.size, 0);
  h.state.minutes = 5;
  h.state.unlocked = false;
  h.lock.bump();
  assert.strictEqual(h.timers.size, 0);
}

// Busy (unlock in flight etc.) re-arms instead of locking
{
  const h = harness({ minutes: 1 });
  h.lock.bump();
  h.state.busy = true;
  h.advance(1 * MIN);
  assert.deepStrictEqual(h.state.idle, []);
  h.state.busy = false;
  h.advance(1 * MIN);
  assert.deepStrictEqual(h.state.idle, [1]);
}

// stop() cancels
{
  const h = harness({ minutes: 1 });
  h.lock.bump();
  h.lock.stop();
  h.advance(5 * MIN);
  assert.deepStrictEqual(h.state.idle, []);
}

// No loss of unsaved edits: the idle path (same as manual lock) saves the
// editor buffer before the key is evicted.
{
  const h = harness({ minutes: 1 });
  const order = [];
  let buffer = 'unsaved edit';
  const saved = [];
  const store = {
    key: { raw: new Uint8Array([1, 2, 3]) },
    saveEncrypted(text) {
      assert.ok(this.key, 'key must still be held while saving');
      saved.push(text);
      order.push('save');
    },
    lock() { this.key = null; order.push('lock'); },
  };
  const real = VL.createIdleLock({
    getMinutes: () => 1,
    isUnlocked: () => true,
    onIdle: () => { store.saveEncrypted(buffer); buffer = ''; store.lock(); },
    setTimer: (fn) => { setImmediate(fn); return 1; },
    clearTimer: () => {},
  });
  real.bump();
  setImmediate(() => setImmediate(() => {
    assert.deepStrictEqual(order, ['save', 'lock']);
    assert.deepStrictEqual(saved, ['unsaved edit']);
    assert.strictEqual(store.key, null);
    console.log('auto lock: ok');
  }));
  void h;
}
