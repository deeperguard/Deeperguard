(function (root) {
  const NotesVaultLock = (() => {
  const UNFOCUS_MS = 60 * 1000;
  const UNFOCUS_AT_KEY = 'notes_unfocused_at';
  const VISIBLE_CLEAR_MS = 2000;

  function normalizeMode(value) {
    const v = String(value || '');
    if (v === 'immediate' || v === '1min') return v;
    return 'never';
  }

  function isTransientUnfocus({ scanOpen = false, pickerOpen = false, updating = false } = {}) {
    return !!(scanOpen || pickerOpen || updating);
  }

  function readHiddenAt(sessionVal, localVal) {
    const a = Number(sessionVal || 0);
    const b = Number(localVal || 0);
    const n = Math.max(a, b);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function shouldLockOnReturn({ mode, hiddenAt, now, unlocked } = {}) {
    if (!unlocked || normalizeMode(mode) !== '1min') return false;
    const at = Number(hiddenAt || 0);
    const ts = Number(now || 0);
    return at > 0 && ts - at >= UNFOCUS_MS;
  }

  function shouldShowLockScreenOnBoot({
    requireUpdate = false,
    requireTyped = false,
    lockMode = 'never',
    unfocusedAt = 0,
    now = 0,
  } = {}) {
    if (requireUpdate || requireTyped) return true;
    const mode = normalizeMode(lockMode);
    const at = Number(unfocusedAt || 0);
    const ts = Number(now || 0);
    if (mode === 'immediate' && at > 0) return true;
    if (mode === '1min' && at > 0 && ts - at >= UNFOCUS_MS) return true;
    return false;
  }

  function shouldFullSyncAfterUnlock({ needsReload = false, localNoteCount = 0 } = {}) {
    return !!needsReload || Number(localNoteCount || 0) === 0;
  }

  function filterAfterLeavingFiles(previous) {
    const next = String(previous || '').trim();
    if (!next || next === 'documents') return 'all';
    return next;
  }

  function defaultLockOnUnfocus(savedPrefs) {
    if (savedPrefs && Object.prototype.hasOwnProperty.call(savedPrefs, 'lockOnUnfocus')) {
      return normalizeMode(savedPrefs.lockOnUnfocus);
    }
    return '1min';
  }

  function pageshowAction({
    unlocked = false,
    transient = false,
    requireTyped = false,
    requireUpdate = false,
    mode = 'never',
    hiddenAt = 0,
    now = 0,
  } = {}) {
    if (transient) return 'ignore';
    if (shouldLockOnReturn({ mode, hiddenAt, now, unlocked })) return 'lock';
    if (requireTyped || requireUpdate) return unlocked ? 'lock' : 'unlock-screen';
    return unlocked ? 'stay-app' : 'continue-boot';
  }

  function vaultIsLocked(body) {
    return !!(body && body.classList && body.classList.contains('locked'));
  }

  function isAppUpdating(body, inFlight) {
    return !!(inFlight || (body && body.classList && body.classList.contains('app-updating')));
  }

  function lockedUpdateUi({ locked = false, stale = false, dismissed = '', serverBuild = '' } = {}) {
    const persistPending = !!(stale && serverBuild);
    return {
      persistPending,
      revealBanner: persistPending && !locked && dismissed !== serverBuild,
      markStale: persistPending && !locked,
    };
  }

  function mayStartAppUpdate({ locked = false } = {}) {
    return !locked;
  }

  function mayLockVault({ updating = false, syncing = false } = {}) {
    return !updating && !syncing;
  }

  function hideProgressWhenLocking({ updating = false } = {}) {
    return !updating;
  }

  function isBackgroundSyncToast(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    return /^(syncing|synced|downloading|saving|checking for changes|waiting)\b/i.test(text);
  }

  function shouldShowLockScreenToast({ locked = false, isError = false, message = '' } = {}) {
    if (!locked) return true;
    if (isBackgroundSyncToast(message)) return false;
    return !!isError;
  }

  const AUTO_LOCK_DEFAULT_MIN = 15;
  const AUTO_LOCK_OPTIONS = [0, 1, 5, 15, 30, 60];

  /** Minutes as a number; 0 = off. Invalid or negative values fall back to the default. */
  function normalizeAutoLockMin(value) {
    if (value === '' || value === null || value === undefined) return AUTO_LOCK_DEFAULT_MIN;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return AUTO_LOCK_DEFAULT_MIN;
    return n;
  }

  /**
   * Idle timer. bump() (call on user input) restarts it; when it fires it calls
   * onIdle(minutes), the same path as the manual Lock. If busy() is true it
   * re-arms instead of locking.
   */
  function createIdleLock({ getMinutes, isUnlocked, busy, onIdle, setTimer, clearTimer } = {}) {
    const set = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clear = clearTimer || ((t) => clearTimeout(t));
    let timer = null;
    function stop() {
      if (timer !== null) clear(timer);
      timer = null;
    }
    function bump() {
      stop();
      const minutes = normalizeAutoLockMin(getMinutes());
      if (!minutes || !isUnlocked()) return;
      timer = set(() => {
        timer = null;
        if (busy && busy()) {
          bump();
          return;
        }
        onIdle(minutes);
      }, minutes * 60 * 1000);
    }
    return { bump, stop };
  }

  return {
    AUTO_LOCK_DEFAULT_MIN,
    AUTO_LOCK_OPTIONS,
    normalizeAutoLockMin,
    createIdleLock,
    UNFOCUS_MS,
    UNFOCUS_AT_KEY,
    VISIBLE_CLEAR_MS,
    normalizeMode,
    isTransientUnfocus,
    readHiddenAt,
    shouldLockOnReturn,
    shouldShowLockScreenOnBoot,
    shouldFullSyncAfterUnlock,
    filterAfterLeavingFiles,
    defaultLockOnUnfocus,
    pageshowAction,
    vaultIsLocked,
    isAppUpdating,
    lockedUpdateUi,
    mayStartAppUpdate,
    mayLockVault,
    hideProgressWhenLocking,
    isBackgroundSyncToast,
    shouldShowLockScreenToast,
  };
})();
  root.NotesVaultLock = NotesVaultLock;
  if (typeof module !== 'undefined' && module.exports) module.exports = NotesVaultLock;
})(typeof window !== 'undefined' ? window : globalThis);
