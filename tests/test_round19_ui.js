const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const authPages = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
const py = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

// 1. A dead session must not surface the raw "login required" string.
assert.ok(appJs.includes("const SESSION_EXPIRED_MESSAGE = 'Your session expired — please sign in again'"));
assert.ok(appJs.includes('function redirectToExpiredLogin'));
assert.ok(appJs.includes("params.set('email', email)"));
assert.ok(appJs.includes("params.set('reason', 'session-expired')"));
assert.ok(appJs.includes('location.assign(`/login?${params.toString()}`)'));
const prove = appJs.slice(
  appJs.indexOf('async function proveEmptyVaultWithAccountPassword'),
  appJs.indexOf('function revealAppShell'),
);
assert.ok(prove.indexOf('isLoginRequiredError(err)') < prove.indexOf('rejectWrongUnlockPassword()'));
assert.ok(prove.includes('err?.status === 401'));
const asserted = appJs.slice(
  appJs.indexOf('async function assertVaultKeyVerified'),
  appJs.indexOf('async function proveEmptyVaultWithAccountPassword'),
);
assert.ok(asserted.includes('if (isLoginRequiredError(err)) throw sessionExpiredError()'));
const abort = appJs.slice(
  appJs.indexOf('function abortUnlockAttempt'),
  appJs.indexOf('function handleVaultDecryptFailure'),
);
assert.ok(abort.indexOf('isLoginRequiredError(err)') < abort.indexOf('lockVault('));
assert.ok(abort.includes('showUnlockError(SESSION_EXPIRED_MESSAGE)'));
assert.ok(authPages.includes("params.get('email')"));
assert.ok(authPages.includes("reason === 'session-expired'"));
assert.ok(authPages.includes('Your session expired — please sign in again.'));

// 2. Zoomed PDF pages target zoomed CSS width × bitmap scale, then clamp.
const upgrade = preview.slice(
  preview.indexOf('async function upgradePdfQuality'),
  preview.indexOf('function mimeFromMeta'),
);
assert.ok(upgrade.includes('const bitmap = pageBitmapScale()'));
assert.ok(upgrade.includes('const targetWidth = Math.round(cssWidth * Math.min(zoom, 4))'));
assert.ok(upgrade.includes('targetWidth * bitmap'));
assert.ok(!upgrade.includes('Math.min(4096'));
assert.ok(upgrade.includes('maxPixels: 16000000'));
assert.ok(upgrade.includes('maxEdge: 8192'));
const pageFn = preview.slice(
  preview.indexOf('async function renderPdfPage'),
  preview.indexOf('function appendSearchExcerpt'),
);
assert.ok(pageFn.includes('limits.maxPixels'));
assert.ok(pageFn.includes('limits.maxEdge'));
assert.ok(pageFn.includes('edgeCap / longEdge'));

// 3. The unlock button stays on Checking… until the attempt finishes.
const frame = appJs.slice(
  appJs.indexOf('function renderLoginProgressFrame'),
  appJs.indexOf('function ensureLoginProgressAnimation'),
);
assert.ok(frame.includes("unlockSubmit.textContent = 'Checking…'"));
assert.ok(!frame.includes('unlockSubmit.textContent = indeterminate'));
const showUnlock = appJs.slice(
  appJs.indexOf('function showUnlock('),
  appJs.indexOf('function updateSecureContextHint'),
);
assert.ok(showUnlock.includes('if (unlockInFlight || loginProgressActive) return'));

// 4. Signed-out /app keeps the unlock card hidden until the session check.
assert.ok(html.includes('id="session-gate"'));
assert.ok(html.includes('html:not([data-notes-session]) #unlock-screen'));
assert.ok(html.includes("location.replace('/login'"));
assert.ok(html.includes("setAttribute('data-notes-session', 'ready')"));
assert.ok(html.includes("setAttribute('data-notes-session', 'boot')"));

// 5. A successful unlock clears stale status left in the hidden card.
const showApp = appJs.slice(appJs.indexOf('function showApp('), appJs.indexOf('let vaultHydrated'));
assert.ok(showApp.includes('resetUnlockCardStatus()'));
const reset = appJs.slice(
  appJs.indexOf('function resetUnlockCardStatus'),
  appJs.indexOf('function vaultKeyProven'),
);
assert.ok(reset.includes("getElementById('unlock-session-hint')"));
assert.ok(reset.includes("'login-progress-status'"));
assert.ok(reset.includes('el.textContent = \'\''));

// 6. /favicon.ico is the DG shield, and the shell links it.
assert.ok(py.includes('def favicon('));
assert.ok(py.includes('favicon-32.png'));
assert.ok(html.includes('rel="icon" href="/favicon.ico"'));

console.log('round19 ui ok');
