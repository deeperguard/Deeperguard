const assert = require('assert');
const { escapeAttr, safeColor, clearUnchangedDirty } = require('../app/static/js/sanitize.js');

assert.strictEqual(safeColor('#4f8cff'), '#4f8cff');
assert.strictEqual(safeColor('#fff'), '#fff');
assert.strictEqual(safeColor('red; } body { background: url(http://evil)'), '#4f8cff');
assert.strictEqual(safeColor('#4f8cff" onclick="alert(1)', ''), '');
assert.strictEqual(escapeAttr('x" onclick="alert(1)'), 'x&quot; onclick=&quot;alert(1)');

const dirty = new Set(['a', 'b']);
clearUnchangedDirty(
  dirty,
  new Map([
    ['a', 1],
    ['b', 1],
  ]),
  (uuid) => (uuid === 'b' ? 2 : 1),
);
assert.deepStrictEqual([...dirty], ['b']);

console.log('ok');
