const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const authPages = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const srp = fs.readFileSync(path.join(root, 'app/static/js/srp-auth.js'), 'utf8');
const py = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

// 1. Empty-vault unlock proves the typed password. A session cookie is not enough.
const prove = appJs.slice(
  appJs.indexOf('async function proveEmptyVaultWithAccountPassword'),
  appJs.indexOf('function revealAppShell'),
);
assert.ok(prove.includes('NotesSrpAuth.accountUnlock'));
assert.ok(prove.includes('err?.status === 401'));
assert.ok(prove.includes('rejectWrongUnlockPassword()'));
assert.ok(prove.indexOf('data.ok === false') < prove.indexOf('markKeyVerified'));
assert.ok(!prove.includes('repairUnlockWithPassword'));
const asserted = appJs.slice(
  appJs.indexOf('async function assertVaultKeyVerified'),
  appJs.indexOf('async function proveEmptyVaultWithAccountPassword'),
);
assert.ok(!asserted.includes("if (vaultKeyProven()) return { via: 'decrypt' }"));
assert.ok(asserted.includes('Number(probe.opened) > 0'));
assert.ok(asserted.includes("if (probe?.empty) return { via: 'empty' }"));
assert.ok(appJs.includes('await proveEmptyVaultWithAccountPassword(cached.email, clean)'));
assert.ok(!appJs.includes("body: JSON.stringify({})"));
assert.ok(srp.includes("postJson('/api/account/unlock'"));
assert.ok(srp.includes("'/api/account/unlock/challenge'"));
assert.ok(py.includes('def api_account_unlock'));
assert.ok(py.includes('missing srp proof'));
assert.ok(py.includes('SRP_PURPOSE_UNLOCK'));
const unlockFn = py.slice(py.indexOf('def api_account_unlock('), py.indexOf('def _password_rotation_seconds'));
assert.ok(unlockFn.includes('_verify_stored_srp_proof'));
assert.ok(unlockFn.indexOf('_verify_stored_srp_proof') < unlockFn.lastIndexOf('_unlock_payload'));

// 2. First Escape in the search field clears the query before the sidebar eats it.
const searchEsc = appJs.indexOf('event.target === ui.search || document.activeElement === ui.search');
const viewsEsc = appJs.indexOf('if (!editorOpen && filterSection?.open)');
assert.ok(searchEsc > 0 && viewsEsc > searchEsc);
const searchBlock = appJs.slice(searchEsc, viewsEsc);
assert.ok(searchBlock.includes('clearSearch({ blur: false })'));
assert.ok(searchBlock.includes('ui.search.blur()'));

// 3. Registration derives once, paints before that derive, and stashes the
//    key so /app adoptDerivedVaultKey skips a second Argon2.
const creating = authPages.indexOf("submitBtn.textContent = 'Creating account…'");
const goApp = authPages.indexOf('location.replace(afterAuthUrl', creating);
const registerSlice = authPages.slice(creating, goApp);
assert.ok(registerSlice.includes("notes_just_registered"));
assert.ok(registerSlice.includes('stashBootDerivedKey'));
assert.ok(registerSlice.includes("Preparing your vault…"));
assert.ok(registerSlice.includes('requestAnimationFrame'));
assert.ok(registerSlice.indexOf("Preparing your vault…") < registerSlice.indexOf('deriveKeyInWorker'));
assert.ok(registerSlice.indexOf('requestAnimationFrame') < registerSlice.indexOf('deriveKeyInWorker'));
assert.ok(appJs.includes('adoptDerivedVaultKey'));
assert.ok(html.includes("sessionStorage.getItem('notes_just_registered') === '1'"));

// 4. Signed-out /app shares one health read instead of a fan-out.
assert.ok(html.includes('window.__notesFetchHealth'));
assert.ok(appJs.includes('function fetchHealthJson('));
assert.ok(appJs.includes('window.__notesFetchHealth('));
const bootAt = appJs.indexOf('async function boot(');
const boot = appJs.slice(bootAt, bootAt + 2200);
assert.ok(boot.includes('fetchHealthJson('));
assert.ok(!boot.includes("fetch('/api/health'"));

console.log('ok');
