const assert = require('assert');
const { clampOffset, decide, axisLock, snapOffset, ACTION_WIDTH } = require('../app/static/js/swipe.js');

assert.strictEqual(clampOffset(24), 0);
assert.strictEqual(clampOffset(-40), -40);
assert.strictEqual(clampOffset(-200), Math.round(-ACTION_WIDTH * 1.15));
assert.strictEqual(clampOffset(Number.NaN), 0);

assert.strictEqual(decide(-20), 'close');
assert.strictEqual(decide(-48), 'open');
assert.strictEqual(decide(-140), 'commit');
assert.strictEqual(decide(-47), 'close');

assert.strictEqual(axisLock(2, 2), null);
assert.strictEqual(axisLock(-20, 4), 'h');
assert.strictEqual(axisLock(3, 20), 'v');

assert.strictEqual(snapOffset('close'), 0);
assert.strictEqual(snapOffset('open'), -ACTION_WIDTH);
assert.strictEqual(snapOffset('commit'), -ACTION_WIDTH);

console.log('ok');
