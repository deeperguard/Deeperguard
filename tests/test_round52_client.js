const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

assert.ok(storeJs.includes('Tombstones sort first'));
assert.ok(storeJs.includes('probe-no-sample'));
assert.ok(appJs.includes('[notes-unlock] build'));
assert.ok(appJs.includes('PROBE_NO_SAMPLE'));
assert.ok(appJs.includes('deferAutoUnlock'));
assert.ok(appJs.includes('notes_post_login_unlock'));

console.log('test_round52_client ok');
