const assert = require('assert');
const L = require('../app/static/js/vaultlock.js');

assert.strictEqual(L.normalizeMode('immediate'), 'immediate');
assert.strictEqual(L.normalizeMode('1min'), '1min');
assert.strictEqual(L.normalizeMode('never'), 'never');
assert.strictEqual(L.normalizeMode(''), 'never');
assert.strictEqual(L.normalizeMode('bogus'), 'never');

assert.strictEqual(L.isTransientUnfocus({}), false);
assert.strictEqual(L.isTransientUnfocus({ scanOpen: true }), true);
assert.strictEqual(L.isTransientUnfocus({ pickerOpen: true }), true);
assert.strictEqual(L.isTransientUnfocus({ updating: true }), true);
assert.strictEqual(L.isTransientUnfocus({ scanOpen: false, pickerOpen: false, updating: false }), false);

assert.strictEqual(L.readHiddenAt('100', '50'), 100);
assert.strictEqual(L.readHiddenAt('', '80'), 80);
assert.strictEqual(L.readHiddenAt('nope', ''), 0);

const now = 1_000_000;
assert.strictEqual(L.shouldLockOnReturn({
  mode: '1min', hiddenAt: now - L.UNFOCUS_MS, now, unlocked: true,
}), true);
assert.strictEqual(L.shouldLockOnReturn({
  mode: '1min', hiddenAt: now - L.UNFOCUS_MS + 1, now, unlocked: true,
}), false);
assert.strictEqual(L.shouldLockOnReturn({
  mode: 'immediate', hiddenAt: now - L.UNFOCUS_MS, now, unlocked: true,
}), false);
assert.strictEqual(L.shouldLockOnReturn({
  mode: '1min', hiddenAt: now - L.UNFOCUS_MS, now, unlocked: false,
}), false);

assert.strictEqual(L.shouldShowLockScreenOnBoot({ requireUpdate: true }), true);
assert.strictEqual(L.shouldShowLockScreenOnBoot({ requireTyped: true }), true);
assert.strictEqual(L.shouldShowLockScreenOnBoot({
  lockMode: 'immediate', unfocusedAt: 10, now,
}), true);
assert.strictEqual(L.shouldShowLockScreenOnBoot({
  lockMode: '1min', unfocusedAt: now - L.UNFOCUS_MS, now,
}), true);
assert.strictEqual(L.shouldShowLockScreenOnBoot({
  lockMode: '1min', unfocusedAt: now - 1000, now,
}), false);
assert.strictEqual(L.shouldShowLockScreenOnBoot({
  lockMode: 'never', unfocusedAt: now - L.UNFOCUS_MS, now,
}), false);

assert.strictEqual(L.shouldFullSyncAfterUnlock({ needsReload: true, localNoteCount: 12 }), true);
assert.strictEqual(L.shouldFullSyncAfterUnlock({ needsReload: false, localNoteCount: 0 }), true);
assert.strictEqual(L.shouldFullSyncAfterUnlock({ needsReload: false, localNoteCount: 12 }), false);

assert.strictEqual(L.filterAfterLeavingFiles('pinned'), 'pinned');
assert.strictEqual(L.filterAfterLeavingFiles('trash'), 'trash');
assert.strictEqual(L.filterAfterLeavingFiles('documents'), 'all');
assert.strictEqual(L.filterAfterLeavingFiles(''), 'all');

assert.strictEqual(L.defaultLockOnUnfocus(null), '1min');
assert.strictEqual(L.defaultLockOnUnfocus({}), '1min');
assert.strictEqual(L.defaultLockOnUnfocus({ theme: 'light' }), '1min');
assert.strictEqual(L.defaultLockOnUnfocus({ lockOnUnfocus: 'immediate' }), 'immediate');
assert.strictEqual(L.defaultLockOnUnfocus({ lockOnUnfocus: 'never' }), 'never');

assert.strictEqual(L.pageshowAction({
  unlocked: true, transient: true, mode: 'immediate', hiddenAt: 1, now,
}), 'ignore');
assert.strictEqual(L.pageshowAction({
  unlocked: true, mode: '1min', hiddenAt: now - L.UNFOCUS_MS, now,
}), 'lock');
assert.strictEqual(L.pageshowAction({
  unlocked: true, requireTyped: true, mode: 'never', now,
}), 'lock');
assert.strictEqual(L.pageshowAction({
  unlocked: false, requireTyped: true, mode: 'never', now,
}), 'unlock-screen');
assert.strictEqual(L.pageshowAction({
  unlocked: true, mode: '1min', hiddenAt: now - 1000, now,
}), 'stay-app');
assert.strictEqual(L.pageshowAction({
  unlocked: false, mode: 'never', now,
}), 'continue-boot');

function fakeBody(classes) {
  const set = new Set(classes);
  return { classList: { contains: (name) => set.has(name) } };
}

assert.strictEqual(L.vaultIsLocked(null), false);
assert.strictEqual(L.vaultIsLocked(fakeBody([])), false);
assert.strictEqual(L.vaultIsLocked(fakeBody(['locked'])), true);
assert.strictEqual(L.isAppUpdating(fakeBody([]), false), false);
assert.strictEqual(L.isAppUpdating(fakeBody(['app-updating']), false), true);
assert.strictEqual(L.isAppUpdating(fakeBody([]), true), true);

assert.deepStrictEqual(L.lockedUpdateUi({
  locked: true, stale: true, dismissed: '', serverBuild: 'abc',
}), { persistPending: true, revealBanner: false, markStale: false });
assert.deepStrictEqual(L.lockedUpdateUi({
  locked: false, stale: true, dismissed: '', serverBuild: 'abc',
}), { persistPending: true, revealBanner: true, markStale: true });
assert.deepStrictEqual(L.lockedUpdateUi({
  locked: false, stale: true, dismissed: 'abc', serverBuild: 'abc',
}), { persistPending: true, revealBanner: false, markStale: true });
assert.deepStrictEqual(L.lockedUpdateUi({
  locked: true, stale: false, dismissed: '', serverBuild: 'abc',
}), { persistPending: false, revealBanner: false, markStale: false });
assert.deepStrictEqual(L.lockedUpdateUi({
  locked: false, stale: true, dismissed: '', serverBuild: '',
}), { persistPending: false, revealBanner: false, markStale: false });

assert.strictEqual(L.mayStartAppUpdate({ locked: true }), false);
assert.strictEqual(L.mayStartAppUpdate({ locked: false }), true);
assert.strictEqual(L.mayLockVault({ updating: true }), false);
assert.strictEqual(L.mayLockVault({ updating: false }), true);
assert.strictEqual(L.mayLockVault({ syncing: true }), false);
assert.strictEqual(L.mayLockVault({ updating: false, syncing: false }), true);
assert.strictEqual(L.hideProgressWhenLocking({ updating: true }), false);
assert.strictEqual(L.hideProgressWhenLocking({ updating: false }), true);

assert.strictEqual(L.isBackgroundSyncToast('Syncing…'), true);
assert.strictEqual(L.isBackgroundSyncToast('Downloading… 40%'), true);
assert.strictEqual(L.isBackgroundSyncToast('Synced · 12 notes'), true);
assert.strictEqual(L.isBackgroundSyncToast('Vault locked.'), false);
assert.strictEqual(L.shouldShowLockScreenToast({
  locked: true, isError: false, message: 'Syncing…',
}), false);
assert.strictEqual(L.shouldShowLockScreenToast({
  locked: false, isError: false, message: 'Syncing…',
}), true);
assert.strictEqual(L.shouldShowLockScreenToast({
  locked: true, isError: true, message: 'Could not sign in',
}), true);

console.log('test_vaultlock.js ok');
