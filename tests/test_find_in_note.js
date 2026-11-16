// Find in note: literal, case- and accent-insensitive matching, and (in a real
// Chromium DOM, tests/find_in_note_browser.py) that hostile search terms run no
// script, mark text only, and cause no network request.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { findMatches } = require('../app/static/js/search.js');

const opts = { literal: true, foldAccents: true };

assert.deepStrictEqual(findMatches('Eén café', 'EEN', opts), [{ start: 0, end: 3 }], 'case and accents are ignored');
assert.deepStrictEqual(findMatches('Eén café', 'CAFÉ', opts), [{ start: 4, end: 8 }]);
assert.deepStrictEqual(findMatches('Eén café', 'een', { literal: true }), [], 'accents count unless folding is asked for');
assert.deepStrictEqual(findMatches('Eén café', 'een', { literal: true, foldAccents: true, caseSensitive: true }), [], 'match case wins');
assert.deepStrictEqual(findMatches('a.*b a.*b', '.*', opts), [{ start: 1, end: 3 }, { start: 6, end: 8 }], 'regex characters are literal');
assert.deepStrictEqual(findMatches('abc', '.*', opts), []);
assert.deepStrictEqual(findMatches('x <img src=x onerror=alert(1)> y', '<img src=x onerror=alert(1)>', opts), [{ start: 2, end: 30 }]);
assert.deepStrictEqual(findMatches('abab', 'ab', opts), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
assert.deepStrictEqual(findMatches('abc', '', opts), []);

const run = spawnSync('python3', [path.join(__dirname, 'find_in_note_browser.py')], { encoding: 'utf8' });
if (run.status === 77) {
  console.log('skipped real-DOM run: ' + run.stdout.trim());
} else {
  assert.strictEqual(run.status, 0, `real-DOM find run failed:\n${run.stdout}\n${run.stderr}`);
}
console.log('ok');
