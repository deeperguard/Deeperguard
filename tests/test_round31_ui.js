const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const registerHtml = fs.readFileSync(path.join(root, 'app/templates/register.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const historyJs = fs.readFileSync(path.join(root, 'app/static/js/note-history.js'), 'utf8');

// 1. Unlock / login / register use novalidate so custom alerts can show.
assert.ok(appHtml.includes('id="unlock-form" class="stack" novalidate'));
assert.ok(loginHtml.includes('id="login-form" class="stack" novalidate'));
assert.ok(registerHtml.includes('id="register-form" class="stack" novalidate'));
assert.ok(appJs.includes("showUnlockError('Enter your password')"));
assert.ok(authJs.includes("showError('login-error', 'Enter your email')"));
assert.ok(authJs.includes("showError('login-error', 'Enter your password')"));

// 2. Untitled — never use the date as the version title.
assert.ok(historyJs.includes("Untitled (first save)") || historyJs.includes("return 'Untitled'"));
assert.ok(!/if \(at\) \{\s*return new Date\(at\)/.test(historyJs));

const { revisionLabel } = require('../app/static/js/note-history.js');
assert.strictEqual(
  revisionLabel({ at: '2024-06-01T12:30:00.000Z', title: '', content: '' }),
  'Untitled (first save)',
);

// 3. Files summary no longer claims "All files" when some are missing.
const filesFn = appJs.split('async function refreshLocalFilesSummary')[1].split('function enqueueOcrJob')[0];
assert.ok(filesFn.includes('Missing files download when you open their note'));
assert.ok(filesFn.includes('Remaining files download when you open their note'));
assert.ok(filesFn.includes('local >= atts.length'));

// 4. Public HTTPS: "Server reachable" (LAN wording only for self-host).
assert.ok(appJs.includes('function serverReachableCopy'));
assert.ok(appJs.includes("selfHostNotes() ? 'Server reachable on LAN' : 'Server reachable'"));
assert.ok(appJs.includes('serverReachableCopy()'));

// 5. Tag / folder delete Undo.
assert.ok(appJs.includes("toastWithUndo('Tag deleted'"));
assert.ok(appJs.includes("toastWithUndo('Folder removed'"));
assert.ok(appJs.includes("toast('Tag restored')"));
assert.ok(appJs.includes("toast('Folder restored')"));

// 6. Quiet sync failures do not show Failed-to-fetch banner.
const syncCatch = appJs.split("console.warn('sync failed', err)")[1].split('.finally(() =>')[0];
assert.ok(syncCatch.includes('quiet sync failed'));
assert.ok(storeJs.includes('Fetch/network wording wins'));

console.log('test_round31_ui ok');
