const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

// 1. Compact layout must not keep the notes shell visible on the 2FA tab.
assert.ok(css.includes('html.layout-compact .shell[hidden]'));
const shellHidden = css.split('html.layout-compact .shell[hidden]')[1].split('}')[0];
assert.ok(shellHidden.includes('display: none !important'));
assert.ok(appJs.includes("ui.shell.hidden = appTab === '2fa'"));

// 2. A background sync toast must not cover live OTP codes.
const toastFn = appJs.slice(appJs.indexOf('function toast('), appJs.indexOf('const totpUi'));
assert.ok(toastFn.includes('isBackgroundSyncToast'));
assert.ok(toastFn.includes("currentAppTab() === '2fa'"));
assert.ok(toastFn.includes("document.documentElement.classList.remove('totp-toast-open')"));
assert.ok(css.includes('html.totp-toast-open .totp-pane'));
assert.ok(css.includes('html.totp-toast-open #toast'));
const totpToast = css.split('html.totp-toast-open #toast')[1].split('}')[0];
assert.ok(totpToast.includes('transform: none'));

// 3. Hover tooltips stay off touch screens and inside the viewport.
assert.ok(css.includes('@media (hover: hover) and (pointer: fine)'));
const tip = css.split('@media (hover: hover) and (pointer: fine)')[1].split('@media')[0];
assert.ok(tip.includes('.btn.icon[aria-label]:hover::after'));
assert.ok(tip.includes('left: 0'));
assert.ok(tip.includes('transform: none'));
assert.ok(!css.includes('.btn.icon[aria-label]:hover::after {\n  content: attr(aria-label);\n  position: absolute;\n  top: calc(100% + 6px);\n  left: 50%;'));

// 4. The phone toolbar keeps the full count and 44px controls.
assert.ok(css.includes('min-height: 44px'));
assert.ok(appJs.includes("cycleBtn.setAttribute('aria-label', sortName)"));
assert.ok(css.includes('html.layout-compact .list-pane #btn-list-sort'));
assert.ok(appJs.includes('collapseMobileNavOnce();'));
const countRule = css.split('html.layout-compact .note-list-count')[1].split('}')[0];
assert.ok(countRule.includes('min-width: max-content'));

// 5. Tags and Folders rows are 44px and start collapsed on a phone.
const summary = css.split('html.layout-compact .tag-section summary.section-label')[1].split('}')[0];
assert.ok(summary.includes('min-height: 44px'));
assert.ok(summary.includes('justify-content: flex-start'));
assert.ok(appJs.includes('function collapseMobileNavOnce'));
assert.ok(appJs.includes('prefs.mobileNavCollapsed'));
assert.ok(appJs.includes('prefs.tagsCollapsed = true'));
assert.ok(appJs.includes('prefs.foldersCollapsed = true'));

// 6. Sync and lock controls have names, and sync has a visible caption.
assert.ok(html.includes('id="sync-caption"'));
assert.ok(appJs.includes("caption.textContent = captions[phase] || 'Sync'"));
assert.ok(appJs.includes("'Vault unlocked. Tap to lock.'"));
assert.ok(appJs.includes("'Vault locked. Tap after you unlock.'"));
assert.ok(css.includes('html.layout-compact .sidebar-actions .sync-caption'));

console.log('round 20 ui ok');
