const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

assert.ok(appJs.includes('[notes-lock] reason'));
assert.ok(appJs.includes('auto-unlock-defer-skipped'));
assert.ok(appJs.includes('clearUnfocusedAt()'));
assert.ok(storeJs.includes("removeItem('notes_unfocused_at')"));
// Round 52 unlock fix must remain.
assert.ok(storeJs.includes('Tombstones sort first'));
assert.ok(appJs.includes('deferAutoUnlock'));
assert.ok(appJs.includes('[notes-unlock] build'));

console.log('test_round53_client ok');
