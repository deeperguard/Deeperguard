/**
 * Sync freshness: per-item versions, high-water marks, vault head chain.
 *
 * Detects rollback (older version), byte-flip (decrypt failure handled by store),
 * freeze (older vault head), and fork (same head counter, divergent tip that
 * cannot be explained by concurrent max-merge).
 *
 * Zero-knowledge: versions and vault heads live inside ciphertext (or local
 * vault-key-encrypted meta). No new plaintext metadata is sent to the server.
 */
(function (global) {
  const META_KEY = 'freshness';
  const HEAD_UUID = '00000000-0063-4000-8000-000000000063';
  const HEADS_SEEN_MAX = 48;
  const WARN_TYPES = {
    rollback: 'rollback',
    fork: 'fork',
    freeze: 'freeze',
    integrity: 'integrity',
    bind: 'bind',
  };

  function emptyState() {
    return {
      hwm: Object.create(null), // uuid -> { v, hash }
      head: null, // { counter, tip, prev_tip, prev_counter }
      headsSeen: [], // [{ counter, tip }]
      warnings: [], // recent warnings for UI
      trustedBootstrap: true, // first head on empty device is trusted
    };
  }

  let state = emptyState();
  let persistTimer = 0;
  let listeners = [];

  function isTestHookEnabled() {
    try {
      if (global.localStorage && global.localStorage.getItem('notes_freshness_test') === '1') return true;
    } catch (err) { /* ignore */ }
    try {
      return typeof global.location !== 'undefined'
        && /(?:^|[?&])freshness_test=1(?:&|$)/.test(String(global.location.search || ''));
    } catch (err) {
      return false;
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return () => { listeners = listeners.filter((x) => x !== fn); };
  }

  function emit() {
    listeners.forEach((fn) => {
      try { fn(getPublicSnapshot()); } catch (err) { /* ignore */ }
    });
  }

  function pushWarning(type, message, detail) {
    const entry = {
      type,
      message,
      detail: detail || null,
      at: Date.now(),
    };
    state.warnings = [entry, ...state.warnings].slice(0, 20);
    emit();
    return entry;
  }

  function clearWarnings() {
    state.warnings = [];
    emit();
  }

  function hexSha256(bytes) {
    const noble = global.nobleCrypto || global.nobleHashes;
    // Prefer NotesCrypto's noble via subtle path — store always loads crypto first.
    const nc = global.NotesCrypto;
    if (nc && typeof nc.hashBytes === 'function') {
      // hashBytes returns hex already in this codebase
      return null; // async — use syncSha256Hex below
    }
    return null;
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(String(text || ''));
    if (global.NotesCrypto && typeof global.NotesCrypto.hashBytes === 'function') {
      return global.NotesCrypto.hashBytes(enc);
    }
    if (global.crypto && global.crypto.subtle) {
      const buf = await global.crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('No SHA-256 available for freshness tip');
  }

  function fingerprintShort(tip) {
    const t = String(tip || '');
    if (t.length < 12) return t || '—';
    return `${t.slice(0, 6)}…${t.slice(-4)}`;
  }

  function getHwm(uuid) {
    const row = state.hwm[String(uuid || '')];
    if (!row) return null;
    return { v: Number(row.v) || 0, hash: String(row.hash || '') };
  }

  function itemVersion(content) {
    const n = Number(content && content.__fv);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function itemBindId(content) {
    return String((content && content.__fid) || '');
  }

  function shouldTrackType(type) {
    // Derived/search indexes are rebuilt locally; vault_head is the tip itself.
    if (!type) return true;
    if (type === 'search_index') return false;
    if (type === 'vault_head') return false;
    return true;
  }

  function stampForUpsert(uuid, content, { bump = true, existing = null } = {}) {
    const id = String(uuid || '');
    const baseContent = content && typeof content === 'object' ? { ...content } : {};
    if (!shouldTrackType(baseContent.type)) {
      return baseContent;
    }
    const prev = Math.max(
      itemVersion(baseContent),
      itemVersion(existing && existing.content),
      getHwm(id)?.v || 0,
    );
    baseContent.__fid = id;
    baseContent.__fv = bump ? prev + 1 : (itemVersion(baseContent) || prev || 0);
    if (!bump && baseContent.__fv === 0 && prev === 0) {
      // Leave at 0 until first real edit; migration stamps on wrap/save.
      baseContent.__fv = 0;
    }
    return baseContent;
  }

  function stampForWrap(uuid, content) {
    const id = String(uuid || '');
    const next = content && typeof content === 'object' ? { ...content } : {};
    if (!shouldTrackType(next.type)) return next;
    next.__fid = id;
    // Re-encrypt only: migrate missing versions to 0. Upsert bumps on real edits.
    if (next.__fv == null || next.__fv === '') {
      next.__fv = 0;
    } else {
      next.__fv = itemVersion(next);
    }
    return next;
  }

  /** Annotate decrypted content in memory (migration); does not mark dirty. */
  function annotateDecrypted(uuid, content) {
    if (!content || typeof content !== 'object') return content;
    if (!shouldTrackType(content.type)) return content;
    const id = String(uuid || '');
    if (!content.__fid) content.__fid = id;
    if (content.__fv == null || content.__fv === '') content.__fv = 0;
    else content.__fv = itemVersion(content);
    return content;
  }

  /**
   * Check an incoming decrypted item before applying.
   * Returns { ok, reject, warning }.
   */
  function checkIncoming(uuid, content, contentHash, { isDelete = false } = {}) {
    const id = String(uuid || '');
    if (isDelete) {
      return { ok: true, reject: false, warning: null };
    }
    if (!content || typeof content !== 'object') {
      return {
        ok: false,
        reject: true,
        warning: pushWarning(WARN_TYPES.integrity, 'The server returned a corrupted item (not shown).', { uuid: id }),
      };
    }
    if (shouldTrackType(content.type)) {
      const bind = itemBindId(content);
      if (bind && bind !== id) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.bind,
            'The server returned an item whose encrypted id does not match (not shown).',
            { uuid: id, bind },
          ),
        };
      }
      const ver = itemVersion(content);
      const hwm = getHwm(id);
      if (hwm && ver < hwm.v) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.rollback,
            'The server returned an older version of this item.',
            { uuid: id, incoming: ver, held: hwm.v },
          ),
        };
      }
      if (hwm && ver === hwm.v && hwm.hash && contentHash && hwm.hash !== contentHash) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.fork,
            'The server returned a different copy of this item at the same version (possible fork).',
            { uuid: id, version: ver },
          ),
        };
      }
    }
    return { ok: true, reject: false, warning: null };
  }

  function noteAccepted(uuid, content, contentHash, { deleted = false } = {}) {
    const id = String(uuid || '');
    if (deleted) {
      delete state.hwm[id];
      schedulePersist();
      return;
    }
    if (!content || !shouldTrackType(content.type)) return;
    const ver = itemVersion(content);
    const prev = getHwm(id);
    if (prev && ver < prev.v) return; // should have been rejected
    state.hwm[id] = { v: ver, hash: String(contentHash || prev?.hash || '') };
    schedulePersist();
  }

  function versionsMapFromItems(itemsMap) {
    const out = Object.create(null);
    if (!itemsMap || typeof itemsMap.forEach !== 'function') return out;
    itemsMap.forEach((item, uuid) => {
      if (!item || item.deleted) return;
      const type = item.content && item.content.type;
      if (!shouldTrackType(type)) return;
      const ver = itemVersion(item.content);
      // Prefer HWM if higher (accepted remote)
      const hwm = getHwm(uuid);
      out[uuid] = Math.max(ver, hwm ? hwm.v : 0);
    });
    // Also include HWM-only entries for items not in memory
    Object.keys(state.hwm).forEach((uuid) => {
      if (out[uuid] == null) out[uuid] = state.hwm[uuid].v || 0;
    });
    return out;
  }

  async function computeTip(versionsMap) {
    const lines = Object.keys(versionsMap)
      .filter((k) => k && k !== HEAD_UUID)
      .sort()
      .map((k) => `${k}:${Number(versionsMap[k]) || 0}`);
    return sha256Hex(lines.join('\n'));
  }

  function rememberHead(head) {
    if (!head || !head.tip) return;
    const entry = { counter: Number(head.counter) || 0, tip: String(head.tip) };
    state.headsSeen = [entry, ...state.headsSeen.filter((h) => h.tip !== entry.tip)].slice(0, HEADS_SEEN_MAX);
  }

  function seenTip(tip) {
    return state.headsSeen.some((h) => h.tip === tip);
  }

  /**
   * Compare local head to a remote vault_head content after items were applied.
   * Concurrent edits: if recomputed tip from merged versions matches remote or
   * local, or remote is strictly ahead/behind by counter with chain link, no alarm.
   */
  async function evaluateRemoteHead(remoteContent, itemsMap) {
    if (!remoteContent || remoteContent.type !== 'vault_head') return { ok: true };
    const remote = {
      counter: Number(remoteContent.counter) || 0,
      tip: String(remoteContent.tip || ''),
      prev_tip: String(remoteContent.prev_tip || ''),
      prev_counter: Number(remoteContent.prev_counter) || 0,
    };
    const local = state.head;
    const mergedTip = await computeTip(versionsMapFromItems(itemsMap));

    if (!local) {
      // New device / empty freshness: trust first head (honest bootstrap).
      state.head = { ...remote };
      rememberHead(remote);
      state.trustedBootstrap = true;
      schedulePersist();
      return { ok: true, adopted: true, bootstrap: true };
    }

    if (remote.counter < local.counter) {
      if (remote.tip === local.tip || remote.tip === local.prev_tip || seenTip(remote.tip)) {
        return { ok: true, stale: true };
      }
      return {
        ok: false,
        warning: pushWarning(
          WARN_TYPES.freeze,
          'The server presented an older vault head than this device has already seen (possible freeze/rollback).',
          { local: local.counter, remote: remote.counter },
        ),
      };
    }

    if (remote.counter === local.counter && remote.tip && local.tip && remote.tip !== local.tip) {
      // Legitimate multi-device concurrency: both heads advanced from the same
      // parent (same prev_tip), or one tip is the other's parent. Rebase to the
      // merged tip without alarming. A malicious fork tends to present the same
      // counter with unrelated tips and unrelated parents.
      const sameParent = remote.prev_tip && local.prev_tip && remote.prev_tip === local.prev_tip;
      const chained = remote.prev_tip === local.tip
        || local.prev_tip === remote.tip
        || mergedTip === remote.tip
        || mergedTip === local.tip
        || seenTip(remote.tip);
      if (sameParent || chained) {
        state.head = {
          counter: (Number(local.counter) || 0) + 1,
          tip: mergedTip || remote.tip,
          prev_tip: local.tip,
          prev_counter: Number(local.counter) || 0,
        };
        rememberHead(state.head);
        rememberHead(remote);
        schedulePersist();
        return { ok: true, concurrent: true };
      }
      return {
        ok: false,
        warning: pushWarning(
          WARN_TYPES.fork,
          'Two different vault heads share the same counter (possible fork).',
          { counter: local.counter, localTip: local.tip, remoteTip: remote.tip },
        ),
      };
    }

    if (remote.counter > local.counter) {
      // Adopt when chain links or tip matches what we compute from items.
      if (
        remote.prev_tip === local.tip
        || remote.tip === mergedTip
        || seenTip(remote.prev_tip)
        || remote.counter === local.counter + 1
      ) {
        state.head = { ...remote };
        rememberHead(remote);
        schedulePersist();
        return { ok: true, adopted: true };
      }
      // Still adopt tip if items dominate (we're simply behind), but warn softly
      // only when tip disagrees with merged local view after pull.
      state.head = { ...remote };
      rememberHead(remote);
      schedulePersist();
      if (mergedTip && remote.tip && mergedTip !== remote.tip && !seenTip(remote.tip)) {
        // Not necessarily malicious — another device may have versions we haven't pulled yet.
        return { ok: true, adopted: true, lagging: true };
      }
      return { ok: true, adopted: true };
    }

    return { ok: true };
  }

  async function buildNextHead(itemsMap) {
    const tip = await computeTip(versionsMapFromItems(itemsMap));
    const prev = state.head;
    if (prev && prev.tip === tip) return { ...prev, tip };
    const counter = (prev ? Number(prev.counter) || 0 : 0) + 1;
    return {
      counter,
      tip,
      prev_tip: prev ? String(prev.tip || '') : '',
      prev_counter: prev ? Number(prev.counter) || 0 : 0,
    };
  }

  async function commitLocalHead(itemsMap) {
    const next = await buildNextHead(itemsMap);
    state.head = next;
    rememberHead(next);
    schedulePersist();
    return next;
  }

  function headContent(head) {
    return {
      type: 'vault_head',
      counter: Number(head.counter) || 0,
      tip: String(head.tip || ''),
      prev_tip: String(head.prev_tip || ''),
      prev_counter: Number(head.prev_counter) || 0,
      updated_at: new Date().toISOString(),
    };
  }

  function getPublicSnapshot() {
    const head = state.head;
    return {
      headUuid: HEAD_UUID,
      counter: head ? Number(head.counter) || 0 : 0,
      tip: head ? String(head.tip || '') : '',
      fingerprint: fingerprintShort(head && head.tip),
      warningCount: state.warnings.length,
      warnings: state.warnings.slice(0, 5),
      hwmCount: Object.keys(state.hwm).length,
      bootstrap: !!state.trustedBootstrap && !state.head,
    };
  }

  async function encryptState(cryptoKey) {
    if (!global.NotesCrypto || !cryptoKey) return null;
    return global.NotesCrypto.encryptObject(cryptoKey, {
      hwm: state.hwm,
      head: state.head,
      headsSeen: state.headsSeen,
    });
  }

  async function decryptState(cryptoKey, payload) {
    if (!global.NotesCrypto || !cryptoKey || !payload) return emptyState();
    const plain = await global.NotesCrypto.decryptObject(cryptoKey, payload);
    return {
      hwm: plain.hwm && typeof plain.hwm === 'object' ? plain.hwm : Object.create(null),
      head: plain.head || null,
      headsSeen: Array.isArray(plain.headsSeen) ? plain.headsSeen : [],
      warnings: state.warnings || [],
      trustedBootstrap: !plain.head,
    };
  }

  let loadPromise = null;
  async function load(cryptoKey) {
    setCryptoKey(cryptoKey);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      state = emptyState();
      if (!global.NotesIDB || !cryptoKey) return;
      try {
        const row = await global.NotesIDB.getMeta(META_KEY);
        if (row && row.payload) {
          state = await decryptState(cryptoKey, row.payload);
        } else if (row && (row.hwm || row.head)) {
          // Unexpected plaintext shape — ignore (fail closed to empty + bootstrap)
          state = emptyState();
        }
      } catch (err) {
        state = emptyState();
      }
      emit();
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  async function persistNow(cryptoKey) {
    if (!global.NotesIDB || !cryptoKey) return;
    try {
      const payload = await encryptState(cryptoKey);
      if (!payload) return;
      await global.NotesIDB.putMeta(META_KEY, { payload, updated_at: Date.now() / 1000 });
    } catch (err) {
      /* non-fatal */
    }
  }

  let cryptoKeyRef = null;
  function setCryptoKey(key) {
    cryptoKeyRef = key || null;
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistNow(cryptoKeyRef).catch(() => {});
      emit();
    }, 200);
  }

  async function resetAfterIntentionalRestore(cryptoKey) {
    state = emptyState();
    setCryptoKey(cryptoKey);
    await persistNow(cryptoKey);
    emit();
  }

  function clearMemory() {
    state = emptyState();
    cryptoKeyRef = null;
    emit();
  }

  /**
   * QA-only: raise the local high-water mark so the next production freshness
   * check treats the server copy as a rollback. Does nothing unless
   * notes_freshness_test=1. Pair with NotesStore.testFreshnessProbeItem(uuid)
   * or NotesStore.testDemoRollbackWarning(uuid) so a real server ciphertext
   * runs through applySyncPayload (a quiet sync alone often pulls 0 items).
   */
  function testInjectRollbackScenario(uuid, heldVersion) {
    if (!isTestHookEnabled()) {
      throw new Error('Freshness test hook disabled (set localStorage notes_freshness_test=1)');
    }
    const id = String(uuid || '');
    state.hwm[id] = { v: Number(heldVersion) || 2, hash: state.hwm[id]?.hash || 'testhash' };
    schedulePersist();
    return getHwm(id);
  }

  const api = {
    META_KEY,
    HEAD_UUID,
    WARN_TYPES,
    isTestHookEnabled,
    onChange,
    load,
    persistNow,
    setCryptoKey,
    clearMemory,
    resetAfterIntentionalRestore,
    stampForUpsert,
    stampForWrap,
    annotateDecrypted,
    checkIncoming,
    noteAccepted,
    evaluateRemoteHead,
    commitLocalHead,
    buildNextHead,
    headContent,
    getHwm,
    itemVersion,
    getPublicSnapshot,
    clearWarnings,
    pushWarning,
    fingerprintShort,
    computeTip,
    versionsMapFromItems,
    shouldTrackType,
    testInjectRollbackScenario,
    get state() { return state; },
  };

  global.NotesFreshness = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
