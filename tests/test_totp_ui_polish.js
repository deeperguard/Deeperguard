// 2FA list, add, import and QR scan polish (docs/UI_POLISH.md 2.6): markup and CSS only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const camJs = fs.readFileSync(path.join(root, 'app/static/js/totp-qr-camera.js'), 'utf8');

// Copy control: labelled button with a visible copy icon next to the code and timer.
assert.ok(/class="totp-item-main" data-totp-copy title="Copy code" aria-label="Copy code for /.test(appJs));
assert.ok(appJs.includes('<span class="totp-copy-icon" aria-hidden="true">'));
assert.ok(css.includes('.totp-copy-icon {'));

// Empty state points at the existing + button (no extra button for search/error states).
assert.ok(appJs.includes('Use the + button (Add account) at the top'));
assert.ok(!html.includes('totp-empty-action'));
assert.ok(css.includes('#totp-empty:not([hidden])):has(#totp-search:placeholder-shown) #btn-totp-add'));

// Add / import sheets: numbered steps and errors announced as alerts.
assert.strictEqual((html.match(/<ol class="totp-steps"/g) || []).length, 2);
assert.ok(html.includes('id="totp-add-error" class="error totp-dialog-error" role="alert"'));
assert.ok(html.includes('id="totp-import-error" class="error totp-dialog-error" role="alert"'));
assert.ok(css.includes('.totp-dialog-error[hidden] { display: none; }'));

// QR camera: denied access has a clear message and a readable error style.
assert.ok(camJs.includes('Camera access was denied.'));
assert.ok(css.includes('.totp-cam-status.error {'));

console.log('test_totp_ui_polish ok');
