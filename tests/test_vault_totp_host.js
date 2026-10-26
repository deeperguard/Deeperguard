const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

assert.ok(appHtml.includes('id="totp-add-host"'));
assert.ok(appHtml.includes('Site hostname'));
assert.ok(/advisory label/i.test(appHtml));
assert.ok(!/phishing/i.test(appHtml.split('totp-add-host')[1].slice(0, 800)));

assert.ok(appJs.includes('totpCopyLabelForEntry'));
assert.ok(appJs.includes('Code · no site set'));
assert.ok(appJs.includes('totp-add-host'));
assert.ok(appJs.includes('readTotpDialogHost'));
assert.ok(appJs.includes('totp-bound-host'));

assert.ok(storeJs.includes('host: boundHost'));
assert.ok(storeJs.includes('host !== undefined'));

console.log('test_vault_totp_host ok');
