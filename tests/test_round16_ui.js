const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const superJs = fs.readFileSync(path.join(root, 'app/static/js/superscript.js'), 'utf8');
const overlayJs = fs.readFileSync(path.join(root, 'app/static/js/link-overlay.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// 1. Edit mode uses the same scheme check as preview: javascript: is not a link.
const safeHref = superJs.slice(superJs.indexOf('function safeHref('), superJs.indexOf('function trimUrl('));
assert.ok(safeHref.includes("/^[a-z][a-z0-9+.-]*:/i.test(href)) return ''"));
assert.ok(safeHref.indexOf('https?:\\/\\/') < safeHref.indexOf('return \'\''));
assert.ok(overlayJs.includes('function overlayHrefKind('));
assert.ok(overlayJs.includes("if (!kind)"));

// 2. Resend disables and says Sending… before the request, for both buttons.
const resend = appJs.slice(appJs.indexOf('async function resendVerificationCode('), appJs.indexOf('async function resendVerificationCode(') + 1800);
assert.ok(resend.includes("btn.textContent = 'Sending…'"));
assert.ok(resend.indexOf("btn.textContent = 'Sending…'") < resend.indexOf('await NotesStore.api'));
assert.ok(resend.includes('btn.disabled = true'));
assert.ok(appJs.includes("resendVerificationCode('/api/account/email/resend'"));
assert.ok(appJs.includes("resendVerificationCode('/api/backup/email/resend'"));

// 3. The cooldown sentence is a hint, not a red error.
const cooldown = appJs.slice(appJs.indexOf('function startResendCooldown('), appJs.indexOf('function resendStatusElement('));
assert.ok(cooldown.includes('Please wait ${left} s before requesting another code'));
assert.ok(cooldown.includes("status.classList.remove('error')"));
assert.ok(!cooldown.includes("status.classList.add('error')"));
assert.ok(resend.includes('showResendStatus(buttonId, msg, false)'));
assert.ok(resend.includes('showResendStatus(buttonId, msg, true)'));

// 4. Unlock shows Checking… and yields a paint before Argon2.
assert.ok(appJs.includes("unlockSubmit.textContent = 'Checking…'"));
assert.ok(appJs.includes("unlockSubmit.classList.add('is-checking')"));
const verify = appJs.slice(appJs.indexOf('async function verifyAndUnlock('), appJs.indexOf('async function verifyAndUnlock(') + 1200);
assert.ok(verify.includes('await yieldToPaint()'));
assert.ok(verify.indexOf('await yieldToPaint()') < verify.indexOf('await NotesStore.unlock'));
assert.ok(css.includes('#unlock-submit.is-checking::before'));
assert.ok(css.includes('@keyframes unlock-checking-spin'));

// 5. Sticky folder headers have a taller opaque band so rows clip under them.
const sticky = css.split('.sidebar-nav .sidebar-scroll summary.section-label {')[1].split('}')[0];
assert.ok(sticky.includes('padding:'));
assert.ok(sticky.includes('border-bottom:'));
assert.ok(sticky.includes('box-shadow:'));
assert.ok(sticky.includes('background: var(--sn-nav-bg)'));

console.log('ok');
