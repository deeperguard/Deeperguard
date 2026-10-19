const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const marketing = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const limit = fs.readFileSync(path.join(root, 'app/verification_send_limit.py'), 'utf8');

// 1. Compact layout follows the visual viewport, not only the layout media query.
assert.ok(html.includes("classList.toggle('layout-compact', width > 0 && width < 1000)"));
assert.ok(html.includes('visualViewport'));
assert.ok(css.includes('html.layout-compact .shell'));
assert.ok(css.includes('display: block !important'));
assert.ok(appJs.includes('function compactLayoutActive('));
assert.ok(appJs.includes('function cssViewportWidth('));

// 2. Explicit resend reports the cooldown instead of a fake success.
assert.ok(limit.includes('strict: bool = False'));
assert.ok(limit.includes('Please wait'));
assert.ok(limit.includes('retry_after=wait'));
assert.ok(appJs.includes('function startResendCooldown('));
assert.ok(appJs.includes('Please wait ${Math.ceil(wait)} s before requesting another code'));
assert.ok(appJs.includes('Resend in ${left}s'));
assert.ok(storeJs.includes('err.retryAfter'));

// 3. Saved password is for offline unlock; the clear button only shows when one is stored.
assert.ok(html.includes('id="unlock-clear-saved"'));
assert.ok(html.includes('id="unlock-saved-hint"'));
assert.ok(html.includes('You still enter it each time Notes opens'));
assert.ok(html.includes('it is not filled in for you'));
assert.ok(appJs.includes('function refreshClearSavedButton('));
assert.ok(appJs.includes('NotesVaultSecrets.clearDevicePassword'));
assert.ok(appJs.includes('never auto-unlocks on app start'));

// 4. PDF list thumbs crop ink; the tile is larger than the old ~40px box.
assert.ok(appJs.includes('cropInk: true'));
assert.ok(appJs.includes('Math.max(720, thumbOutputPx() * 2)'));
assert.ok(appJs.includes('Math.min(side / sw, side / sh)'));
assert.ok(css.includes('width: 72px'));
assert.ok(css.includes('height: 72px'));
assert.ok(!css.includes('.note-list-thumb {\n  position: relative;\n  width: 44px;'));

// 5. Signed-out shell does not keep calling /api/account, and marketing inline scripts are nonced.
assert.ok(html.includes('window.__notesSignedOut = true'));
assert.ok(html.includes('window.__notesAccountPromise'));
assert.ok(storeJs.includes('window.__notesSignedOut'));
assert.ok(appJs.includes('if (window.__notesSignedOut) return;'));
assert.ok(marketing.includes('<script nonce="{{ csp_nonce }}">'));
assert.ok(marketing.includes('<script type="application/ld+json" nonce="{{ csp_nonce }}">'));
assert.ok(!/\son[a-z]+\s*=/i.test(html));

// 6. Duplicate upload can attach anyway or cancel.
assert.ok(html.includes('id="confirm-extra"'));
assert.ok(appJs.includes("extraLabel: 'Attach anyway'"));
assert.ok(appJs.includes("if (choice !== 'keep')"));
assert.ok(appJs.includes('intentionalCopy: !!allowDuplicate'));
assert.ok(appJs.includes("cancelLabel: 'Cancel'"));

// 7. Folder rows match the desktop Views font size.
const folderIdx = css.indexOf('.sidebar-nav .folder-select');
assert.ok(folderIdx > css.indexOf('@media (min-width: 1000px)'));
assert.ok(css.includes('.sidebar-nav .folder-note'));
assert.ok(/\.sidebar-nav \.folder-note \{\s*font-size: 14px;/.test(css));

// 8. Hidden file inputs stay on-screen at 1px and clicks restore scroll.
const fileRule = css.split('input[type="file"].sr-file')[1].split('}')[0];
assert.ok(fileRule.includes('position: fixed'));
assert.ok(fileRule.includes('left: 0'));
assert.ok(fileRule.includes('top: 0'));
assert.ok(!fileRule.includes('display: none'));
assert.ok(!fileRule.includes('left: -9999'));
assert.ok(appJs.includes('function openHiddenFileInput('));
assert.ok(appJs.includes('openHiddenFileInput(ui.attachmentInput)'));
assert.ok(appJs.includes("openHiddenFileInput(document.getElementById('scan-input'))"));
assert.ok(appJs.includes("openHiddenFileInput(document.getElementById('scan-camera'))"));

const start = appJs.indexOf('function openHiddenFileInput(input) {');
const end = appJs.indexOf('\n  function ', start + 10);
const src = appJs.slice(start, end);
const scrolls = [];
const sandbox = {
  window: {
    scrollX: 12,
    scrollY: 240,
    scrollTo(x, y) {
      this.scrollX = x;
      this.scrollY = y;
      scrolls.push([x, y]);
    },
  },
  requestAnimationFrame(fn) { fn(); },
};
sandbox.input = {
  click() { sandbox.window.scrollY = 900; },
};
vm.runInNewContext(`${src}\nopenHiddenFileInput(input);`, sandbox);
assert.deepStrictEqual(scrolls[0], [12, 240]);
assert.strictEqual(sandbox.window.scrollY, 240);
assert.ok(scrolls.length >= 2);

console.log('ok');
