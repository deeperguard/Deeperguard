/**
 * Round 53: vault lock reasons are logged; silent defer must not relock a proven vault.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');
const vaultLockJs = fs.readFileSync(path.join(jsRoot, 'vaultlock.js'), 'utf8');

assert.ok(appJs.includes("[notes-lock] reason"), 'lock reason logging required');
assert.ok(appJs.includes('auto-unlock-defer-skipped'), 'proven vault must skip defer lock');
assert.ok(appJs.includes('auto-unlock-abort-skipped'), 'proven vault must skip silent abort lock');
assert.ok(appJs.includes("reason: `idle-${minutes}min`") || appJs.includes("reason: `idle-"), 'idle lock reason');
assert.ok(appJs.includes("reason: 'unfocus-1min'") || appJs.includes('unfocus-1min'), 'unfocus lock reason');
assert.ok(storeJs.includes("localStorage.removeItem('notes_unfocused_at')"), 'sign-out clears away timestamp');

// vaultlock: 1min away lock is intentional when configured.
vm.runInThisContext(vaultLockJs);
assert.strictEqual(NotesVaultLock.normalizeMode('1min'), '1min');
assert.ok(
  NotesVaultLock.shouldLockOnReturn({
    mode: '1min',
    hiddenAt: Date.now() - 60_000,
    now: Date.now(),
    unlocked: true,
  }),
  '1min away must lock when configured',
);
assert.ok(
  !NotesVaultLock.shouldLockOnReturn({
    mode: '1min',
    hiddenAt: Date.now() - 10_000,
    now: Date.now(),
    unlocked: true,
  }),
  'under 1min away must not lock',
);
assert.ok(
  !NotesVaultLock.shouldLockOnReturn({
    mode: 'never',
    hiddenAt: Date.now() - 120_000,
    now: Date.now(),
    unlocked: true,
  }),
  'never mode must not lock on return',
);

console.log('test_round53_lock_reason ok');
