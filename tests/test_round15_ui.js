const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');
const limit = fs.readFileSync(path.join(root, 'app/verification_send_limit.py'), 'utf8');

// 1. Unlock and login wrong-password errors are assertive alerts, re-announced.
assert.ok(html.includes('id="unlock-error"'));
assert.ok(html.includes('role="alert"'));
assert.ok(html.includes('aria-live="assertive"'));
const unlockError = html.split('id="unlock-error"')[1].split('>')[0];
assert.ok(unlockError.includes('role="alert"'));
assert.ok(unlockError.includes('aria-live="assertive"'));
assert.ok(appJs.includes('function showUnlockError('));
assert.ok(login.includes('id="login-error"'));
assert.ok(login.includes('role="alert"'));
assert.ok(login.includes('aria-live="assertive"'));
assert.ok(authJs.includes('el.hidden = true'));
assert.ok(authJs.includes('el.textContent = \'\''));

// 2. The wait sentence counts down with the button, then clears.
assert.ok(appJs.includes('Please wait ${left} s before requesting another code'));
assert.ok(appJs.includes('startResendCooldown(buttonId, wait, { waiting: true })'));
assert.ok(appJs.includes('status.textContent = \'\''));

// 3. Unlock Sign out confirm is modal: backdrop, focus, Escape.
assert.ok(appJs.includes("document.body.classList.add('confirm-open')"));
assert.ok(appJs.includes('confirm-over-unlock'));
assert.ok(appJs.includes("document.addEventListener('keydown', onKey, true)"));
assert.ok(appJs.includes('cancelBtn.focus()'));
assert.ok(css.includes('body.confirm-open #confirm-backdrop'));
assert.ok(css.includes('body.confirm-over-unlock #confirm-dialog'));

// 4. Cooldown is known before Resend is clicked, so the client does not POST a 429.
assert.ok(limit.includes('def verification_cooldown_remaining('));
assert.ok(appPy.includes('email_verify_retry_after'));
assert.ok(appJs.includes('email_verify_retry_after'));
assert.ok(appJs.includes('Do not console.error'));

// 5. One sidebar scroller; section headers stay opaque above the rows.
assert.ok(html.includes('id="sidebar-scroll"'));
assert.ok(css.includes('.sidebar-nav .sidebar-scroll'));
assert.ok(css.includes('position: sticky'));
assert.ok(css.includes('background: var(--sn-nav-bg)'));
const tagOpen = css.split('.sidebar-nav .tag-section[open] {')[1].split('}')[0];
assert.ok(tagOpen.includes('overflow: visible'));

// 6. A note opened from All Notes marks its folder without selecting that view.
assert.ok(appJs.includes('is-current'));
assert.ok(appJs.includes('has-open-note'));
assert.ok(appJs.includes('currentFolder === folder.uuid'));
assert.ok(css.includes('.folder-note.is-current'));

// 7. Escape clears search, then blurs.
assert.ok(appJs.includes("clearSearch({ blur: false })"));
assert.ok(appJs.includes('ui.search.blur()'));

// 8. A failed KDF probe does not derive the key a third time.
const unlockFn = storeJs.slice(storeJs.indexOf('async function unlock('), storeJs.indexOf('async function unlock(') + 700);
assert.ok(unlockFn.includes('if (state.kdfFastReject)'));
assert.ok(unlockFn.indexOf('if (state.kdfFastReject)') < unlockFn.indexOf('deriveVaultKey(password, salt, kdfVersion)'));

console.log('ok');
