/**
 * Device-local copy counts and last-used times for vault secrets (not synced).
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'notes_vault_sensitive_copy_v1';
  const MAX_ENTRIES = 400;

  function loadStore() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveStore(data) {
    try {
      global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      /* quota / private mode */
    }
  }

  function entryKey(scope, id) {
    const s = String(scope || '').trim();
    const i = String(id || '').trim();
    if (!s || !i) return '';
    return `${s}:${i}`;
  }

  function prune(data) {
    const keys = Object.keys(data);
    if (keys.length <= MAX_ENTRIES) return data;
    keys.sort((a, b) => (Number(data[a]?.lastUsedAt) || 0) - (Number(data[b]?.lastUsedAt) || 0));
    const next = { ...data };
    for (let i = 0; i < keys.length - MAX_ENTRIES; i += 1) {
      delete next[keys[i]];
    }
    return next;
  }

  function getMeta(scope, id) {
    const key = entryKey(scope, id);
    if (!key) return { count: 0, lastUsedAt: 0 };
    const row = loadStore()[key];
    const count = Number(row?.count) || 0;
    const lastUsedAt = Number(row?.lastUsedAt) || 0;
    return { count: count > 0 ? count : 0, lastUsedAt: lastUsedAt > 0 ? lastUsedAt : 0 };
  }

  function recordCopy(scope, id) {
    const key = entryKey(scope, id);
    if (!key) return { count: 0, lastUsedAt: 0 };
    const data = loadStore();
    const prev = data[key] || {};
    const count = (Number(prev.count) || 0) + 1;
    const lastUsedAt = Date.now();
    data[key] = { count, lastUsedAt };
    saveStore(prune(data));
    return { count, lastUsedAt };
  }

  /**
   * Claim-safe nudge after repeated copies on this device only.
   * @param {number} count
   */
  function rotateHint(count) {
    const n = Number(count) || 0;
    if (n < 2) return '';
    const times = n === 2 ? 'twice' : `${n} times`;
    return `Copied ${times} on this device — if the clipboard could have been seen, consider rotating this secret where you use it.`;
  }

  const api = {
    STORAGE_KEY,
    getMeta,
    recordCopy,
    rotateHint,
    entryKey,
  };

  global.NotesVaultCopyMeta = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
