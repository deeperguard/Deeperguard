const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const markdown = fs.readFileSync(path.join(root, 'app/static/js/markdown.js'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

// 1. An empty server vault is not a key, and a failed local decrypt does not wipe.
const probe = storeJs.slice(storeJs.indexOf('async function probeServerKey'), storeJs.indexOf('async function loadAccount'));
const emptyAt = probe.indexOf('total === 0 && rows.length === 0');
assert.ok(emptyAt > 0);
const emptyBranch = probe.slice(emptyAt, probe.indexOf('let opened = 0'));
assert.ok(emptyBranch.includes('return { ok: false, empty: true, opened: 0 }'));
assert.ok(!emptyBranch.includes('markKeyVerified'));
assert.ok(appJs.includes("if (probe?.empty) return { via: 'empty' }"));
assert.ok(appJs.includes('await proveEmptyVaultWithAccountPassword'));
assert.ok(appJs.includes('function rejectWrongUnlockPassword('));
const localFail = appJs.slice(appJs.indexOf('if (localAllFailed)'), appJs.indexOf('const hasLocalVault'));
assert.ok(localFail.includes("if (localProof?.via !== 'decrypt') rejectWrongUnlockPassword()"));
assert.ok(localFail.indexOf("localProof?.via !== 'decrypt'") < localFail.indexOf('clearUnreadableLocalCache'));
assert.ok(appJs.includes('if (!vaultKeyProven()) rejectWrongUnlockPassword()'));
assert.ok(storeJs.includes('const secondScore = await scoreVaultKdfVersion(password, salt, second, ciphers)'));

// 2. Backup resend shares the account cooldown when the addresses match.
assert.ok(appJs.includes('function sameVerificationRecipient('));
assert.ok(appJs.includes('function armSiblingResendCooldown('));
assert.ok(appJs.includes('Math.max(emailRetry, backupRetry)'));
assert.ok(appJs.includes('startResendCooldown(buttonId, wait)'));
assert.ok(appJs.includes('startResendCooldown(buttonId, wait, { waiting: true })'));
assert.ok(appJs.includes('armSiblingResendCooldown(buttonId, wait)'));

// 3. Preview accepts a same-page hash and still refuses scheme-looking hashes.
assert.ok(markdown.includes('function safeHashHref('));
assert.ok(markdown.includes("href.includes(':')"));

// 4. Compact layout is pinned to the visual viewport width.
assert.ok(html.includes("'--vv-width'"));
assert.ok(html.includes("classList.toggle('layout-compact', width > 0 && width < 1000)"));
assert.ok(css.includes('html.layout-compact .app-root'));
assert.ok(css.includes('var(--vv-width, 100%)'));
assert.ok(css.includes('html.layout-compact .app-tabs'));
assert.ok(css.includes('html.layout-compact .search-wrap'));

// 5. Only the current sidebar section can keep its sticky header.
assert.ok(css.includes('.sidebar-nav .sidebar-scroll > #filter-section'));
assert.ok(
  css.includes('.sidebar-nav .sidebar-scroll > #folder-section')
  || css.includes('.sidebar-nav .sidebar-scroll > .nav-browse > #folder-section'),
);
const clipNeedle = css.includes('.sidebar-nav .sidebar-scroll > .nav-browse > #folder-section')
  ? '.sidebar-nav .sidebar-scroll > .nav-browse > #folder-section'
  : '.sidebar-nav .sidebar-scroll > #folder-section';
const clipRule = css.match(
  new RegExp(`${clipNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*overflow: clip`),
);
assert.ok(clipRule, 'folder section sticky clip rule must exist');
const tagOpen = css.split('.sidebar-nav .tag-section[open] {')[1].split('}')[0];
assert.ok(tagOpen.includes('overflow: visible'));

// 6. Registration hides the unlock screen before the boot password is unwrapped.
assert.ok(html.includes("sessionStorage.getItem('notes_just_registered') === '1'"));
assert.ok(appJs.includes('justRegistered'));
assert.ok(appJs.includes('suppressUnlockScreen = true'));
assert.ok(appJs.indexOf('if (freshLogin || justRegistered)') < appJs.indexOf('await NotesVaultSecrets.consumeBootPassword()'));

// 7. Signed-out boot probe is not a 401, and /api/account stays protected.
assert.ok(html.includes("fetch('/api/boot-account'"));
assert.ok(html.includes('window.__notesSignedOut = true'));
assert.ok(appPy.includes('@app.get("/api/boot-account")'));
assert.ok(appPy.includes('{"signed_out": True}'));
assert.ok(appJs.includes('if (window.__notesSignedOut) return;'));

console.log('ok');
