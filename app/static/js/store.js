const NotesStore = (() => {
  const MAX_REVISIONS = 30;
  const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
  const OCR_INDEX = 59;
  const DIRTY_META_KEY = 'dirty';

  // Unsynced item ids survive lock / app kill / iOS background suspension in
  // IndexedDB meta. Before this the queue lived only in memory, so an edit made
  // right before the vault auto-locked was never pushed to other devices.
  let dirtyPersistTimer = null;
  let dirtyPersistSuspended = false;

  function persistDirtyNow() {
    clearTimeout(dirtyPersistTimer);
    dirtyPersistTimer = null;
    if (dirtyPersistSuspended) return;
    const snapshot = [...state.dirty];
    try {
      const pending = NotesIDB.putMeta(DIRTY_META_KEY, snapshot);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (err) {
      /* IndexedDB unavailable — memory queue only */
    }
  }

  function persistDirtySoon() {
    if (dirtyPersistSuspended || dirtyPersistTimer) return;
    dirtyPersistTimer = setTimeout(persistDirtyNow, 50);
  }

  class DirtySet extends Set {
    add(value) {
      const had = this.has(value);
      super.add(value);
      if (!had) persistDirtySoon();
      return this;
    }

    delete(value) {
      const removed = super.delete(value);
      if (removed) persistDirtySoon();
      return removed;
    }

    clear() {
      if (!this.size) return;
      super.clear();
      persistDirtySoon();
    }
  }

  const state = {
    csrf: '',
    account: null,
    cryptoKey: null,
    items: new Map(),
    dirty: new DirtySet(),
    lastSync: 0,
    // Local wall clock (ms) of the last completed sync — for "recently synced"
    // throttling. lastSync is a server cursor and must not be compared to Date.now().
    lastSyncAt: 0,
    // Bumped on lock(); in-flight syncs check it and abort without touching the cursor.
    lockEpoch: 0,
    saveTimer: null,
    pushing: false,
    activePush: null,
    lastError: '',
    localReady: false,
    blockPushForPasswordRotation: false,
    kdfVersion: 1,
    altCryptoKey: null,
    kdfProbeMixed: false,
    // Light vault: keep note text local, download attachment files only when a note is opened.
    lightVault: false,
  };

  function setLightVault(on) {
    state.lightVault = !!on;
  }

  function lightVaultEnabled() {
    return !!state.lightVault;
  }

  let onSaveStatus = null;
  let onSyncStatus = null;
  let onUnlockProgress = null;
  let onNoteIngested = null;
  let onVaultPullBegin = null;
  let onVaultPullPage = null;
  let onVaultPullEnd = null;

  function setSaveStatusCallback(fn) {
    onSaveStatus = fn;
  }

  function setSyncStatusCallback(fn) {
    onSyncStatus = fn;
  }

  function setUnlockProgressCallback(fn) {
    onUnlockProgress = fn;
  }

  function setNoteIngestedCallback(fn) {
    onNoteIngested = fn;
  }

  function setVaultPullCallbacks(cbs = {}) {
    onVaultPullBegin = cbs.begin || null;
    onVaultPullPage = cbs.page || null;
    onVaultPullEnd = cbs.end || null;
  }

  function syncPayloadBytes(row) {
    if (!row || row.unchanged) return 0;
    return String(row.ciphertext || '').length + String(row.blob_ciphertext || '').length;
  }

  function orderSyncRows(rows) {
    return rows
      .map((row, index) => ({ row, index, bytes: syncPayloadBytes(row) }))
      .sort((a, b) => {
        if (a.row.unchanged && !b.row.unchanged) return -1;
        if (!a.row.unchanged && b.row.unchanged) return 1;
        return a.bytes - b.bytes || a.index - b.index;
      })
      .map((entry) => entry.row);
  }

  function notifyStatus(text, isError = false) {
    state.lastError = isError ? text : '';
    if (onSaveStatus) onSaveStatus(text, isError);
  }

  const SYNC_LOG_MAX = 40;
  const SYNC_LOG_KEY = 'notes_sync_log';
  let syncLog = [];
  try {
    const raw = localStorage.getItem(SYNC_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) syncLog = parsed.slice(-SYNC_LOG_MAX);
  } catch (err) {
    syncLog = [];
  }

  function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function persistSyncLog() {
    try {
      localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(syncLog.slice(-SYNC_LOG_MAX)));
    } catch (err) {
      /* ignore quota */
    }
  }

  function logSync(kind, fields = {}) {
    const entry = {
      at: new Date().toISOString(),
      kind: String(kind || 'event'),
      ...fields,
    };
    syncLog.push(entry);
    if (syncLog.length > SYNC_LOG_MAX) syncLog = syncLog.slice(-SYNC_LOG_MAX);
    persistSyncLog();
    try {
      console.info('[notes-sync]', entry.at, kind, fields);
    } catch (err) {
      /* ignore */
    }
    return entry;
  }

  function syncLogEntries() {
    return syncLog.slice();
  }

  function formatSyncLog() {
    if (!syncLog.length) return 'Sync log: (empty)';
    const lines = ['Sync log (newest last):'];
    for (const entry of syncLog) {
      const parts = [entry.at, entry.kind];
      if (entry.quiet != null) parts.push(entry.quiet ? 'quiet' : 'loud');
      if (entry.full) parts.push('full');
      if (entry.since != null) parts.push(`since=${entry.since}`);
      if (entry.items != null) parts.push(`items=${entry.items}`);
      if (entry.pages != null) parts.push(`pages=${entry.pages}`);
      if (entry.bytes != null) parts.push(`bytes=${formatBytes(entry.bytes)}`);
      if (entry.ms != null) parts.push(`${entry.ms}ms`);
      if (entry.decryptOk != null || entry.decryptSkipped != null) {
        parts.push(`decrypt=${entry.decryptOk || 0}/${entry.decryptSkipped || 0}`);
      }
      if (entry.dirty != null) parts.push(`dirty=${entry.dirty}`);
      if (entry.local != null) parts.push(`local=${entry.local}`);
      if (entry.lastSync != null) parts.push(`lastSync=${entry.lastSync}`);
      if (entry.kdf != null) parts.push(`kdf=${entry.kdf}`);
      if (entry.hasMore != null) parts.push(entry.hasMore ? 'more' : 'end');
      if (entry.ok === false) parts.push('FAIL');
      if (entry.error) parts.push(String(entry.error).slice(0, 120));
      lines.push(parts.join(' '));
    }
    return lines.join('\n');
  }

  function emitSync(phase, message) {
    if (!onSyncStatus) return;
    let syncState = phase;
    if (phase === 'ok' && state.dirty.size) syncState = 'pending';
    if (phase !== 'syncing' && phase !== 'offline') {
      const unreachable = typeof window !== 'undefined' && typeof window.notesNetworkReachable === 'function'
        ? !window.notesNetworkReachable()
        : (typeof navigator !== 'undefined' && navigator.onLine === false);
      if (unreachable) syncState = 'offline';
    }
    onSyncStatus({
      state: syncState,
      message: message || '',
      dirty: state.dirty.size,
    });
  }

  function deviceId() {
    try {
      const key = 'notes_device_id';
      let id = localStorage.getItem(key) || '';
      if (!/^[A-Za-z0-9._-]{8,80}$/.test(id)) {
        id = (crypto.randomUUID && crypto.randomUUID())
          || `d${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(key, id);
      }
      return id;
    } catch (err) {
      return '';
    }
  }

  function csrf() {
    if (state.csrf) return state.csrf;
    try {
      const saved = sessionStorage.getItem('notes_csrf');
      if (saved) state.csrf = saved;
    } catch (e) {
      /* ignore quota */
    }
    return state.csrf;
  }

  function setCsrf(token) {
    state.csrf = token || '';
    try {
      if (token) sessionStorage.setItem('notes_csrf', token);
      else sessionStorage.removeItem('notes_csrf');
    } catch (e) {
      /* ignore quota */
    }
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const token = state.csrf || csrf();
    if (token) headers['X-CSRF-Token'] = token;
    const device = deviceId();
    if (device) headers['X-Device-Id'] = device;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 8000);
    let res;
    try {
      res = await fetch(path, { ...options, headers, signal: ctrl.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Request timed out. Check the LAN connection and try again.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data.code || '';
      if (err.code === 'session_revoked') notifySessionRevoked(err);
      throw err;
    }
    return data;
  }

  let sessionRevokedHandler = null;

  function setSessionRevokedHandler(fn) {
    sessionRevokedHandler = typeof fn === 'function' ? fn : null;
  }

  function notifySessionRevoked(err) {
    if (!sessionRevokedHandler) return;
    try { sessionRevokedHandler(err); } catch (e) { /* ignore */ }
  }

  function vaultKdfVersionFromAccount(account) {
    const value = Number(account?.vault_kdf_version);
    if (value >= 2) return 2;
    if (value === 1) return 1;
    try {
      const stored = Number(localStorage.getItem('notes_vault_kdf_version'));
      if (stored >= 2) return 2;
      if (stored === 1) return 1;
    } catch (err) {
      /* ignore */
    }
    return 1;
  }

  function vaultKdfUpgradePending() {
    try {
      return localStorage.getItem('notes_vault_kdf_upgrade_pending') === '1';
    } catch (err) {
      return false;
    }
  }

  function parseCipherPayload(ciphertext) {
    if (!ciphertext) return null;
    if (typeof ciphertext === 'object' && ciphertext.iv && ciphertext.data) return ciphertext;
    try {
      const payload = JSON.parse(ciphertext);
      if (payload && payload.iv && payload.data) return payload;
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  let lastDerivedKdf = null;

  function passwordFingerprint(password, salt) {
    try {
      const lib = globalThis.NobleCrypto;
      if (!lib || typeof lib.sha256 !== 'function') return '';
      const enc = new TextEncoder();
      const a = enc.encode(String(password || ''));
      const b = enc.encode(String(salt || ''));
      const merged = new Uint8Array(a.length + 1 + b.length);
      merged.set(a, 0);
      merged[a.length] = 0;
      merged.set(b, a.length + 1);
      const hash = lib.sha256(merged);
      let out = '';
      for (let i = 0; i < 8; i += 1) out += hash[i].toString(16).padStart(2, '0');
      return out;
    } catch (err) {
      return '';
    }
  }

  function rememberDerivedKdf(password, salt, version, derived) {
    const key = derived && (derived.key || derived);
    if (!key) return;
    lastDerivedKdf = {
      password: String(password || ''),
      salt: String(salt || ''),
      version: Number(version) || 1,
      key,
      encoding: derived.encoding || '',
    };
    try {
      const raw = key.raw;
      if (!(raw instanceof Uint8Array)) return;
      let binary = '';
      for (let i = 0; i < raw.length; i += 1) binary += String.fromCharCode(raw[i]);
      sessionStorage.setItem('notes_kdf_cache', JSON.stringify({
        salt: String(salt || ''),
        version: Number(version) || 1,
        encoding: derived.encoding || '',
        raw: btoa(binary),
        fp: passwordFingerprint(password, salt),
      }));
    } catch (err) {
      /* ignore quota / private mode */
    }
  }

  function reuseDerivedKdf(password, salt, version) {
    const want = Number(version) || 1;
    if (
      lastDerivedKdf
      && lastDerivedKdf.password === String(password || '')
      && lastDerivedKdf.salt === String(salt || '')
      && lastDerivedKdf.version === want
      && lastDerivedKdf.key
    ) {
      return lastDerivedKdf;
    }
    try {
      const raw = sessionStorage.getItem('notes_kdf_cache');
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached || cached.salt !== String(salt || '') || Number(cached.version) !== want) return null;
      const fp = passwordFingerprint(password, salt);
      if (!fp || cached.fp !== fp) return null;
      const bytes = Uint8Array.from(atob(cached.raw), (ch) => ch.charCodeAt(0));
      const hit = {
        password: String(password || ''),
        salt: String(salt || ''),
        version: want,
        key: { raw: bytes },
        encoding: cached.encoding || '',
      };
      lastDerivedKdf = hit;
      return hit;
    } catch (err) {
      return null;
    }
  }

  async function deriveVaultKey(password, salt, kdfVersion) {
    const cached = reuseDerivedKdf(password, salt, kdfVersion);
    if (cached) {
      return { key: cached.key, encoding: cached.encoding, version: cached.version };
    }
    const version = Number(kdfVersion) || 1;
    let derived;
    if (version >= 2 && NotesCrypto.workerEnabled()) {
      try {
        derived = await NotesCrypto.deriveKeyInWorker(password, salt, { kdfVersion: version });
      } catch (err) {
        derived = await NotesCrypto.deriveKey(password, salt, { kdfVersion: version });
      }
    } else {
      derived = await NotesCrypto.deriveKey(password, salt, { kdfVersion: version });
    }
    rememberDerivedKdf(password, salt, derived.version || kdfVersion, derived);
    return derived;
  }

  async function scoreVaultKdfVersion(password, salt, kdfVersion, ciphers) {
    let ok = 0;
    try {
      const derived = await deriveVaultKey(password, salt, kdfVersion);
      const key = derived.key || derived;
      for (const row of ciphers) {
        const payload = parseCipherPayload(row.ciphertext);
        if (!payload) continue;
        try {
          await NotesCrypto.decryptObject(key, payload);
          ok += 1;
        } catch (err) {
          /* this item is not this KDF */
        }
      }
    } catch (err) {
      return 0;
    }
    return ok;
  }

  async function probeVaultKdfVersion(password, salt) {
    const ciphers = await sampleCipherRows(16);
    if (!ciphers.length) return null;
    const hint = vaultKdfVersionFromAccount(state.account);
    const first = hint >= 2 ? 2 : 1;
    const second = first === 1 ? 2 : 1;
    const firstScore = await scoreVaultKdfVersion(password, salt, first, ciphers);
    // Skip the other derive only when every sampled item opens with the hint
    // (Argon2 is slow). A leftover other-KDF blob must still be scored.
    if (firstScore === ciphers.length && firstScore > 0) {
      return { version: first, mixed: false };
    }
    const secondScore = await scoreVaultKdfVersion(password, salt, second, ciphers);
    const mixed = firstScore > 0 && secondScore > 0;
    if (secondScore > firstScore) return { version: second, mixed };
    if (firstScore > 0) return { version: first, mixed };
    if (secondScore > 0) return { version: second, mixed };
    return null;
  }

  async function sampleCipherRows(limit = 8) {
    const ciphers = [];
    const collect = (row) => {
      if (row.ciphertext) ciphers.push(row);
      if (ciphers.length >= limit) return false;
      return undefined;
    };
    if (typeof NotesIDB.iterateItems === 'function') {
      await NotesIDB.iterateItems(collect);
    } else {
      (await NotesIDB.loadItems())
        .filter((row) => row.ciphertext)
        .slice(0, limit)
        .forEach((row) => ciphers.push(row));
    }
    return ciphers;
  }

  function unlockPlatformIsIos() {
    if (typeof NotesIosTune !== 'undefined' && NotesIosTune.IS_IOS) return true;
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function sessionTrustedKdfVersion(password, salt) {
    const fp = passwordFingerprint(password, salt);
    if (!fp) return null;
    try {
      const raw = sessionStorage.getItem('notes_kdf_cache');
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (cached?.fp !== fp || cached.salt !== String(salt || '')) return null;
      const ver = Number(cached.version);
      return ver === 1 || ver === 2 ? ver : null;
    } catch (err) {
      return null;
    }
  }

  async function resolveUnlockKdfVersion(password, salt, options = {}) {
    const explicit = Number(options.kdfVersion || options.version);
    if (explicit === 1 || explicit === 2) {
      state.kdfProbeMixed = false;
      return explicit;
    }
    const hint = vaultKdfVersionFromAccount(state.account);
    const ciphers = await sampleCipherRows(4);
    if (!ciphers.length) {
      state.kdfProbeMixed = false;
      if (vaultKdfUpgradePending()) return 1;
      return hint;
    }
    const sessionTrusted = sessionTrustedKdfVersion(password, salt);
    if (sessionTrusted) {
      const trustedScore = await scoreVaultKdfVersion(password, salt, sessionTrusted, ciphers);
      if (trustedScore > 0) {
        if (trustedScore < ciphers.length) {
          const probed = await probeVaultKdfVersion(password, salt);
          if (probed?.version) {
            state.kdfProbeMixed = !!probed.mixed;
            return probed.version;
          }
        } else {
          state.kdfProbeMixed = false;
        }
        return sessionTrusted;
      }
    }
    const first = hint >= 2 ? 2 : 1;
    const second = first === 1 ? 2 : 1;
    const firstScore = await scoreVaultKdfVersion(password, salt, first, ciphers);
    if (firstScore === ciphers.length && firstScore > 0) {
      state.kdfProbeMixed = false;
      return first;
    }
    if (firstScore > 0) {
      if (firstScore < ciphers.length) {
        const probed = await probeVaultKdfVersion(password, salt);
        if (probed?.version) {
          state.kdfProbeMixed = !!probed.mixed;
          return probed.version;
        }
      }
      const secondScore = await scoreVaultKdfVersion(password, salt, second, ciphers);
      state.kdfProbeMixed = secondScore > 0;
      if (secondScore > firstScore) return second;
      return first;
    }
    const secondScore = await scoreVaultKdfVersion(password, salt, second, ciphers);
    if (secondScore > 0) {
      state.kdfProbeMixed = false;
      return second;
    }
    state.kdfProbeMixed = false;
    if (vaultKdfUpgradePending()) return 1;
    return hint;
  }

  function persistVaultKdfServerVersion(version) {
    const next = Number(version) >= 2 ? 2 : 1;
    try {
      localStorage.setItem('notes_vault_kdf_version', String(next));
      if (next >= 2) localStorage.removeItem('notes_vault_kdf_upgrade_pending');
    } catch (err) {
      /* ignore */
    }
    if (state.account) state.account.vault_kdf_version = next;
  }

  let vaultKdfMigrationInFlight = false;
  let lastVaultKdfRetryAt = 0;

  function vaultKdfMigrationComplete() {
    try {
      return localStorage.getItem('notes_vault_kdf_migration_complete') === '1';
    } catch (err) {
      return false;
    }
  }

  function markVaultKdfMigrationComplete() {
    try {
      localStorage.setItem('notes_vault_kdf_migration_complete', '1');
      localStorage.removeItem('notes_vault_kdf_upgrade_pending');
    } catch (err) {
      /* ignore */
    }
  }

  async function retryPendingVaultKdfUpgrade() {
    if (!state.cryptoKey) return false;
    if (state.kdfVersion < 2) {
      if (vaultKdfUpgradePending()) {
        try {
          localStorage.removeItem('notes_vault_kdf_upgrade_pending');
        } catch (err) {
          /* ignore */
        }
      }
      return false;
    }
    // Only finish a real local v2 upgrade. Deriving an Argon2 key (empty
    // device, stale flag) must not flip users.vault_kdf_version.
    if (!vaultKdfUpgradePending()) return false;
    const password = (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword())
      || '';
    const salt = sessionStorage.getItem('notes_salt') || cachedAccount().kdf_salt;
    if (password && salt) {
      const probed = await probeVaultKdfVersion(password, salt);
      if (probed?.version !== 2) {
        try {
          localStorage.removeItem('notes_vault_kdf_upgrade_pending');
        } catch (err) {
          /* ignore */
        }
        return false;
      }
    }
    const serverVer = Number(state.account?.vault_kdf_version);
    if (serverVer >= 2) {
      persistVaultKdfServerVersion(2);
      markVaultKdfMigrationComplete();
      return false;
    }
    const now = Date.now();
    if (now - lastVaultKdfRetryAt < 60000) return false;
    lastVaultKdfRetryAt = now;
    try {
      await api('/api/account/vault-kdf', {
        method: 'POST',
        body: JSON.stringify({ vault_kdf_version: 2 }),
      });
      persistVaultKdfServerVersion(2);
      markVaultKdfMigrationComplete();
      return true;
    } catch (err) {
      if (!isProbablyOffline(err)) console.warn('vault-kdf upgrade retry failed', err);
      return false;
    }
  }

  async function unlock(password, salt, options = {}) {
    emitUnlockProgress('kdf', 0, 3);
    const kdfVersion = await resolveUnlockKdfVersion(password, salt, options);
    emitUnlockProgress('kdf', 1, 3);
    const derived = await deriveVaultKey(password, salt, kdfVersion);
    emitUnlockProgress('kdf', 2, 3);
    state.cryptoKey = derived.key || derived;
    state.saltEncoding = derived.encoding || 'hex';
    state.kdfVersion = derived.version || kdfVersion;
    state.altCryptoKey = null;
    if (state.kdfProbeMixed) {
      const altVersion = kdfVersion >= 2 ? 1 : 2;
      try {
        const other = await deriveVaultKey(password, salt, altVersion);
        state.altCryptoKey = other.key || other;
      } catch (err) {
        state.altCryptoKey = null;
      }
    }
    emitUnlockProgress('kdf', 3, 3);
    sessionStorage.setItem('notes_unlocked', '1');
    sessionStorage.setItem('notes_salt', salt);
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.setVaultPassword(password);
    }
    persistVaultKdfServerVersion(state.kdfVersion);
  }

  function isUnlocked() {
    return !!state.cryptoKey;
  }

  function lock() {
    state.lockEpoch += 1;
    // Keep the persisted unsynced queue — it is restored by loadLocal after the
    // next unlock and pushed then. Only the in-memory copy is dropped here.
    persistDirtyNow();
    dirtyPersistSuspended = true;
    try {
      state.dirty.clear();
    } finally {
      dirtyPersistSuspended = false;
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.cryptoKey = null;
    state.altCryptoKey = null;
    state.kdfProbeMixed = false;
    state.kdfVersion = 1;
    state.items.clear();
    state.localReady = false;
    sessionStorage.removeItem('notes_unlocked');
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.clearSecrets();
    }
    if (typeof NotesCrypto !== 'undefined' && typeof NotesCrypto.terminateWorker === 'function') {
      NotesCrypto.terminateWorker();
    }
  }

  function localWatermark() {
    let max = 0;
    for (const item of state.items.values()) {
      max = Math.max(max, Number(item.updated_at) || 0);
    }
    return max;
  }

  function readStoredLastSync() {
    try {
      const raw = localStorage.getItem('notes_last_sync');
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) return value;
    } catch (err) {
      /* ignore */
    }
    return 0;
  }

  async function rememberLastSync(value) {
    const next = Number(value) || 0;
    state.lastSync = next;
    try {
      if (next) localStorage.setItem('notes_last_sync', String(next));
      else localStorage.removeItem('notes_last_sync');
    } catch (err) {
      /* ignore quota */
    }
    try {
      await NotesIDB.putMeta('lastSync', next);
    } catch (err) {
      /* keep going with memory + localStorage */
    }
  }

  function localContentHashes() {
    const out = {};
    for (const [uuid, item] of state.items) {
      if (item.deleted) continue;
      const hash = item.content_hash;
      if (hash) out[uuid] = String(hash);
    }
    return out;
  }

  function syncRequestTimeoutMs(byteEstimate = 0, { minMs = 90000, maxMs = 300000 } = {}) {
    const bytes = Math.max(0, Number(byteEstimate) || 0);
    return Math.min(maxMs, minMs + Math.floor(bytes / 40000));
  }

  async function fetchMissingBlobs(rows) {
    // Light vault: attachment bytes are fetched on demand when a note is opened.
    if (state.lightVault) return rows;
    const need = rows
      .filter((row) => !row.unchanged && !row.deleted && !row.blob_ciphertext
        && (row.has_blob || row.needs_blob))
      .map((row) => row.item_uuid)
      .filter(Boolean);
    if (!need.length) return rows;
    const blobBytes = rows.reduce(
      (sum, row) => sum + String(row.ciphertext || '').length,
      0,
    );
    const data = await api('/api/sync/blobs', {
      method: 'POST',
      body: JSON.stringify({ uuids: need.slice(0, 50) }),
      timeoutMs: syncRequestTimeoutMs(blobBytes),
    });
    const byId = new Map((data.blobs || []).map((row) => [row.item_uuid, row.blob_ciphertext]));
    return rows.map((row) => {
      if (row.blob_ciphertext || row.unchanged) return row;
      const blob = byId.get(row.item_uuid);
      return blob ? { ...row, blob_ciphertext: blob } : row;
    });
  }

  async function migrateLegacyBlobs() {
    if (!state.cryptoKey || typeof NotesIDB.putBlob !== 'function') return;
    for (const [uuid, item] of state.items) {
      if (item.deleted || item.content?.type !== 'attachment') continue;
      if (!item.content?.file_enc || item.content?.file_enc_stored) continue;
      const stored = get(uuid);
      if (!stored) continue;
      const hasBlob = await NotesIDB.getBlob(uuid);
      if (hasBlob) continue;
      await persistLocal(uuid, stored);
    }
  }

  function syncSince(forceFull = false) {
    // Do NOT fold localWatermark() into the pull cursor. A few recent local notes
    // (e.g. created on PC with the wrong password) would permanently hide older
    // vault items on the server. lastSync / stored meta are the source of truth;
    // loadLocal already lifts lastSync to the local watermark when items open.
    if (forceFull) return 0;
    return Math.max(Number(state.lastSync) || 0, readStoredLastSync());
  }

  function needsSyncOnOpen({ forceFull = false } = {}) {
    if (forceFull) return true;
    if (!state.items.size) return true;
    if (state.dirty.size > 0) return true;
    const last = Math.max(Number(state.lastSync) || 0, readStoredLastSync());
    return !last;
  }

  function newUuid() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function defaultNote() {
    const now = new Date().toISOString();
    return {
      type: 'note',
      title: 'Untitled',
      content: '',
      tags: [],
      attachments: [],
      revisions: [],
      editor: 'plain',
      prevent_edit: false,
      locked: false,
      starred: false,
      pinned: false,
      archived: false,
      trashed: false,
      warn_at: '',
      created_at: now,
      updated_at: now,
    };
  }

  function defaultTag(title) {
    const now = new Date().toISOString();
    return {
      type: 'tag',
      title: title || 'Tag',
      color: '#4f8cff',
      created_at: now,
      updated_at: now,
    };
  }

  function defaultAttachment(noteId, file, fileEnc, displayName, contentSha256, sourceSha256) {
    const now = new Date().toISOString();
    return {
      type: 'attachment',
      note_id: noteId,
      filename: displayName || file.name,
      original_filename: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      content_sha256: contentSha256 || '',
      source_sha256: sourceSha256 || '',
      file_enc: fileEnc,
      ocr_text: '',
      ocr_method: '',
      created_at: now,
      updated_at: now,
    };
  }

  async function ensureAttachmentContentHash(uuid) {
    const item = get(uuid);
    if (!item || item.content?.type !== 'attachment') return '';
    const existing = String(item.content.content_sha256 || '');
    if (existing) return existing;
    try {
      const bytes = await getAttachmentBytes(uuid);
      if (!bytes?.length) return '';
      const hash = await attachmentContentHash(bytes);
      if (!hash) return '';
      upsert(uuid, { ...item.content, content_sha256: hash }, { touchUpdatedAt: false, skipDirty: true });
      return hash;
    } catch (_) {
      return '';
    }
  }

  async function attachmentStoredHashes(uuid) {
    const item = get(uuid);
    if (!item || item.content?.type !== 'attachment') {
      return { contentSha256: '', sourceSha256: '' };
    }
    const meta = item.content || {};
    const contentSha256 = meta.content_sha256
      ? String(meta.content_sha256)
      : await ensureAttachmentContentHash(uuid);
    return {
      contentSha256,
      sourceSha256: String(meta.source_sha256 || ''),
    };
  }

  async function findDuplicateAttachment({ contentSha256, sourceSha256 } = {}) {
    const content = String(contentSha256 || '');
    const source = String(sourceSha256 || '');
    if (!content && !source) return null;
    for (const att of listAttachments()) {
      const parent = get(att.content?.note_id);
      if (!parent || parent.deleted || parent.content?.trashed) continue;
      const stored = await attachmentStoredHashes(att.uuid);
      if (content && stored.contentSha256 && content === stored.contentSha256) return att;
      if (source && stored.sourceSha256 && source === stored.sourceSha256) return att;
    }
    return null;
  }

  function describeDuplicateAttachment(duplicate, file, noteId) {
    const label = duplicate?.content?.filename || file?.name || 'file';
    const parentId = duplicate?.content?.note_id || null;
    const parent = parentId ? get(parentId) : null;
    const trashed = !!parent?.content?.trashed;
    const archived = !!parent?.content?.archived;
    const title = String(parent?.content?.title || '').trim() || 'Untitled';
    let message;
    if (parentId && parentId === noteId) {
      message = `Already attached in this note: ${label}`;
    } else if (trashed) {
      message = `Already saved in Trash (“${title}”): ${label}`;
    } else if (archived) {
      message = `Already saved in Archive (“${title}”): ${label}`;
    } else {
      message = `Already saved in “${title}”: ${label}`;
    }
    if (trashed || archived) {
      message += trashed
        ? '\n\nThat note is in Trash, so it does not appear in All notes.'
        : '\n\nThat note is archived, so it does not appear in All notes.';
    } else if (!parent) {
      message += '\n\nThe note that holds this file could not be found on this device.';
    }
    return {
      message,
      noteId: parent && !parent.deleted ? parentId : null,
      trashed,
      archived,
      filename: label,
    };
  }

  function duplicateAttachmentMessage(duplicate, file, noteId) {
    return describeDuplicateAttachment(duplicate, file, noteId).message;
  }

  async function attachmentContentHash(raw) {
    if (!NotesCrypto?.hashBytes) return '';
    try {
      return await NotesCrypto.hashBytes(raw);
    } catch (_) {
      return '';
    }
  }

  function pushRevision(content) {
    if (!Array.isArray(content.revisions)) content.revisions = [];
    content.revisions.unshift({
      at: new Date().toISOString(),
      title: content.title || '',
      content: content.content || '',
    });
    if (content.revisions.length > MAX_REVISIONS) {
      content.revisions = content.revisions.slice(0, MAX_REVISIONS);
    }
  }

  function isProbablyOffline(err) {
    if (typeof window !== 'undefined' && typeof window.notesNetworkReachable === 'function') {
      return !window.notesNetworkReachable();
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const message = String(err && err.message ? err.message : err || '');
    return /failed to fetch|networkerror|load failed|timed out|offline/i.test(message);
  }

  const PASSWORD_ACK_KEY = 'notes_password_ack_at';

  function readPasswordAck() {
    try {
      const value = Number(localStorage.getItem(PASSWORD_ACK_KEY));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (err) {
      return 0;
    }
  }

  function ackPasswordChanged(at) {
    const ts = Number(at) || 0;
    if (!ts) return;
    try {
      localStorage.setItem(PASSWORD_ACK_KEY, String(ts));
    } catch (err) {
      /* ignore quota */
    }
    state.blockPushForPasswordRotation = false;
  }

  function remotePasswordChanged(account) {
    const server = Number(account?.password_changed_at) || 0;
    if (!server) return false;
    return server > readPasswordAck() + 0.001;
  }

  function abandonLocalForPasswordRotation() {
    clearTimeout(state.saveTimer);
    state.dirty.clear();
    state.pushing = false;
    state.activePush = null;
    state.blockPushForPasswordRotation = true;
  }

  async function prepareForRemotePasswordRotation() {
    abandonLocalForPasswordRotation();
    await rememberLastSync(0);
    try {
      localStorage.removeItem('notes_last_sync');
    } catch (err) {
      /* ignore */
    }
  }

  function cacheAccount(account) {
    if (!account) return;
    try {
      if (account.kdf_salt) {
        localStorage.setItem('notes_kdf_salt', account.kdf_salt);
        sessionStorage.setItem('notes_kdf_salt', account.kdf_salt);
      }
      if (account.email) localStorage.setItem('notes_email', account.email);
      if (account.vault_kdf_version) persistVaultKdfServerVersion(account.vault_kdf_version);
    } catch (e) {
      /* ignore quota */
    }
    if (account.csrf) setCsrf(account.csrf);
  }

  function cachedAccount() {
    try {
      return {
        email: localStorage.getItem('notes_email') || '',
        kdf_salt: localStorage.getItem('notes_kdf_salt') || sessionStorage.getItem('notes_kdf_salt') || '',
        vault_kdf_version: vaultKdfVersionFromAccount(state.account),
      };
    } catch (e) {
      return {
        email: '',
        kdf_salt: sessionStorage.getItem('notes_kdf_salt') || '',
        vault_kdf_version: vaultKdfVersionFromAccount(state.account),
      };
    }
  }

  async function persistLocal(uuid, item) {
    try {
      if (item.deleted) {
        if (typeof NotesSearch !== 'undefined' && NotesSearch.removeFromIndex) {
          NotesSearch.removeFromIndex(uuid);
        }
        if (state.dirty.has(uuid)) {
          // Local delete not yet pushed: keep a tombstone so the deletion still
          // reaches the server after a lock/reload instead of silently reviving.
          await NotesIDB.deleteItem(uuid);
          await NotesIDB.putItem({
            uuid,
            ciphertext: '',
            content_hash: '',
            updated_at: item.updated_at,
            deleted: true,
            has_blob: false,
          });
          return true;
        }
        await NotesIDB.deleteItem(uuid);
        return true;
      }
      if (!state.cryptoKey) return false;
      await sealAttachmentContent(item.content);
      const wrapped = await wrapItem(uuid, item.content, item.updated_at);
      if (wrapped.blob_ciphertext && typeof NotesIDB.putBlob === 'function') {
        await NotesIDB.putBlob(uuid, wrapped.blob_ciphertext);
      }
      await NotesIDB.putItem({
        uuid,
        ciphertext: wrapped.ciphertext,
        content_hash: wrapped.content_hash,
        updated_at: item.updated_at,
        deleted: false,
        // file_enc_stored without local bytes means the server still holds the blob.
        has_blob: !!wrapped.blob_ciphertext
          || !!(item.content?.type === 'attachment' && item.content.file_enc_stored),
      });
      item.content_hash = wrapped.content_hash;
      return true;
    } catch (e) {
      console.warn('idb persist failed', e);
      return false;
    }
  }

  function rebuildSearchIndex() {
    if (typeof NotesSearch === 'undefined' || !NotesSearch.indexNotes) return;
    const tagMap = new Map(listTags().map((tag) => [tag.uuid, tag]));
    NotesSearch.indexNotes(listNotes(), tagMap);
  }

  function updateSearchIndexFor(uuid) {
    if (typeof NotesSearch === 'undefined' || !NotesSearch.indexNote) return;
    const item = state.items.get(uuid);
    if (!item || item.content?.type !== 'note') return;
    refreshNoteSearchText(uuid);
    const fresh = state.items.get(uuid);
    if (!fresh || fresh.content?.type !== 'note') return;
    const tagMap = new Map(listTags().map((tag) => [tag.uuid, tag]));
    NotesSearch.indexNote(fresh, tagMap);
  }

  function splitAttachmentBlob(content) {
    if (!content || content.type !== 'attachment' || !content.file_enc) {
      return { content, blob: '' };
    }
    const meta = { ...content };
    const blob = JSON.stringify(meta.file_enc);
    delete meta.file_enc;
    delete meta.data_b64;
    meta.file_enc_stored = true;
    return { content: meta, blob };
  }

  function mergeAttachmentBlob(content, blobCiphertext) {
    if (!content || content.type !== 'attachment' || !blobCiphertext) return content;
    try {
      const fileEnc = JSON.parse(blobCiphertext);
      const merged = { ...content, file_enc: fileEnc };
      delete merged.file_enc_stored;
      delete merged.data_b64;
      return merged;
    } catch (err) {
      return content;
    }
  }

  // Password / edit protection from another device must apply even when this copy
  // has newer body edits or is still marked dirty for push. Only *add* lock /
  // read-only from remote — an older unlocked server row must not strip them.
  function mergeCrossDeviceProtection(localContent, remoteContent) {
    if (!localContent || localContent.type !== 'note' || !remoteContent || remoteContent.type !== 'note') {
      return { changed: false, content: localContent };
    }
    const merged = { ...localContent };
    let changed = false;
    if (remoteContent.locked && !merged.locked) {
      merged.locked = true;
      changed = true;
    }
    if (remoteContent.prevent_edit && !merged.prevent_edit) {
      merged.prevent_edit = true;
      changed = true;
    }
    return { changed, content: merged };
  }

  function attachLiveIds(content, noteId) {
    if (!content || content.type !== 'note') return content;
    const live = [];
    for (const item of state.items.values()) {
      if (item.deleted || item.content?.type !== 'attachment') continue;
      if (item.content.note_id === noteId) live.push(item.uuid);
    }
    content.attachments = [...new Set([...(content.attachments || []), ...live])];
    return content;
  }

  // Attachment file payloads (file_enc) are NOT kept in memory — loading every
  // photo/PDF into state.items crashed iOS Safari (repeated tab OOM reloads).
  // In-memory attachment content carries file_enc_stored: true instead; the real
  // bytes stay in the IndexedDB row and are fetched on demand.
  function strippedAttachmentContent(content) {
    if (!content || content.type !== 'attachment' || !content.file_enc) return null;
    const light = { ...content };
    delete light.file_enc;
    delete light.data_b64;
    light.file_enc_stored = true;
    return light;
  }

  async function storedAttachmentFileEnc(uuid) {
    if (typeof NotesIDB.getBlob === 'function') {
      const blob = await NotesIDB.getBlob(uuid);
      if (blob) {
        try {
          return JSON.parse(blob);
        } catch (err) {
          /* fall through to legacy row */
        }
      }
    }
    const row = await NotesIDB.getItem(uuid);
    if (!row) return null;
    if (row.ciphertext) {
      const item = await unwrapItem({
        item_uuid: row.uuid,
        ciphertext: row.ciphertext,
        updated_at: row.updated_at,
        deleted: row.deleted,
      });
      return item.content?.file_enc || null;
    }
    return row.content?.file_enc || null;
  }

  async function wrapItem(uuid, content, updatedAt) {
    await sealAttachmentContent(content);
    let wrapContent = content;
    let blobCiphertext = '';
    if (content?.type === 'attachment') {
      if (content.file_enc) {
        const split = splitAttachmentBlob(content);
        wrapContent = split.content;
        blobCiphertext = split.blob;
      } else if (content.file_enc_stored) {
        const fileEnc = await storedAttachmentFileEnc(uuid);
        if (fileEnc) blobCiphertext = JSON.stringify(fileEnc);
      }
    }
    const payload = await NotesCrypto.encryptObject(state.cryptoKey, wrapContent);
    const ciphertext = JSON.stringify(payload);
    const content_hash = await NotesCrypto.hashText(ciphertext);
    const ts = Number(updatedAt);
    return {
      item_uuid: uuid,
      content_version: 1,
      ciphertext,
      blob_ciphertext: blobCiphertext,
      content_hash,
      deleted: !!content.deleted,
      updated_at: Number.isFinite(ts) && ts > 0 ? ts : Date.now() / 1000,
    };
  }

  async function decryptCipherPayload(payload, { fast = false } = {}) {
    const tryKey = async (key) => {
      if (!fast && NotesCrypto.workerEnabled()) {
        try {
          return await NotesCrypto.decryptObjectInWorker(key, payload);
        } catch (err) {
          /* fall back to main thread */
        }
      }
      return NotesCrypto.decryptObject(key, payload);
    };
    try {
      return await tryKey(state.cryptoKey);
    } catch (err) {
      if (!state.altCryptoKey) throw err;
      return tryKey(state.altCryptoKey);
    }
  }

  async function unwrapItem(row, { fast = false, skipBlob = false } = {}) {
    const payload = parseCipherPayload(row.ciphertext) || JSON.parse(row.ciphertext);
    let content = await decryptCipherPayload(payload, { fast });
    let blob = '';
    if (!skipBlob) {
      blob = row.blob_ciphertext
        || ((row.has_blob && typeof NotesIDB.getBlob === 'function')
          ? await NotesIDB.getBlob(row.item_uuid || row.uuid)
          : '');
    } else if (row.blob_ciphertext) {
      blob = row.blob_ciphertext;
    }
    if (blob) content = mergeAttachmentBlob(content, blob);
    else if (
      content?.type === 'attachment'
      && (row.has_blob || row.needs_blob || row.blob_ciphertext)
      && !content.file_enc
    ) {
      // Bytes live in IndexedDB or still on the server (light vault) — fetched on demand.
      content = { ...content, file_enc_stored: true };
    }
    return {
      uuid: row.item_uuid || row.uuid,
      content,
      updated_at: row.updated_at,
      deleted: !!row.deleted,
    };
  }

  let unlockMaintenance = null;
  let loadLocalInFlight = null;
  let attachmentDecryptInFlight = null;

  function emitUnlockProgress(phase, done = 0, total = 0) {
    onUnlockProgress?.({ phase, done, total });
  }

  async function finishLoadLocal() {
    if (loadLocalInFlight) await loadLocalInFlight;
    if (attachmentDecryptInFlight) await attachmentDecryptInFlight;
  }

  async function runUnlockMaintenance() {
    await migratePlainAttachments();
    await migrateLegacyBlobs();
    rebuildSearchIndex();
  }

  function scheduleUnlockMaintenance() {
    if (unlockMaintenance) return unlockMaintenance;
    unlockMaintenance = runUnlockMaintenance().catch((err) => {
      console.warn('unlock maintenance failed', err);
    }).finally(() => {
      unlockMaintenance = null;
    });
    return unlockMaintenance;
  }

  async function finishUnlockMaintenance() {
    if (unlockMaintenance) await unlockMaintenance;
  }

  async function ingestCipherRow(row, { fast = false, skipBlob = false } = {}) {
    const item = await unwrapItem({
      item_uuid: row.uuid,
      ciphertext: row.ciphertext,
      updated_at: row.updated_at,
      deleted: row.deleted,
      has_blob: row.has_blob,
      blob_ciphertext: row.blob_ciphertext,
    }, { fast, skipBlob });
    if (row.content_hash) item.content_hash = row.content_hash;
    const light = strippedAttachmentContent(item.content);
    if (light) item.content = light;
    state.items.set(row.uuid, item);
    return item;
  }

  function unlockDecryptConcurrency(ios) {
    if (ios) return 1;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 16;
    return Math.min(24, Math.max(8, cores));
  }

  function lockedError() {
    const err = new Error('Vault locked during sync');
    err.code = 'VAULT_LOCKED';
    return err;
  }

  async function loadPersistedDirtyIds() {
    try {
      const raw = await NotesIDB.getMeta(DIRTY_META_KEY);
      if (!Array.isArray(raw)) return [];
      return raw.map((id) => String(id || '')).filter(Boolean);
    } catch (err) {
      return [];
    }
  }

  async function setPersistedDirtyIds(ids) {
    const next = [...new Set((ids || []).map((id) => String(id || '')).filter(Boolean))];
    try {
      await NotesIDB.putMeta(DIRTY_META_KEY, next);
    } catch (err) {
      /* ignore */
    }
    return next;
  }

  async function buildPushPayloadFromIdbRow(row) {
    const uuid = String(row?.uuid || row?.item_uuid || '').trim();
    if (!uuid) return null;
    const updatedAt = Number(row.updated_at) || Date.now() / 1000;
    if (row.deleted) {
      const ciphertext = String(row.ciphertext || '');
      if (!ciphertext) return null;
      const content_hash = row.content_hash || await NotesCrypto.hashText(ciphertext);
      return {
        item_uuid: uuid,
        content_version: 1,
        ciphertext,
        blob_ciphertext: '',
        content_hash,
        deleted: true,
        updated_at: updatedAt,
      };
    }
    const ciphertext = String(row.ciphertext || '');
    if (!ciphertext) return null;
    let blob_ciphertext = String(row.blob_ciphertext || '');
    if (!blob_ciphertext && row.has_blob && typeof NotesIDB.getBlob === 'function') {
      const blob = await NotesIDB.getBlob(uuid);
      if (blob) blob_ciphertext = typeof blob === 'string' ? blob : JSON.stringify(blob);
    }
    const content_hash = row.content_hash || await NotesCrypto.hashText(ciphertext);
    return {
      item_uuid: uuid,
      content_version: 1,
      ciphertext,
      blob_ciphertext,
      content_hash,
      deleted: false,
      updated_at: updatedAt,
    };
  }

  async function persistCipherRowFromServer(row) {
    const uuid = String(row?.item_uuid || row?.uuid || '').trim();
    if (!uuid) return;
    if (row.deleted) {
      try { await NotesIDB.deleteItem(uuid); } catch (err) { /* ignore */ }
      return;
    }
    if (row.unchanged || !row.ciphertext) return;
    const ciphertext = typeof row.ciphertext === 'string' ? row.ciphertext : JSON.stringify(row.ciphertext);
    if (row.blob_ciphertext && typeof NotesIDB.putBlob === 'function') {
      try { await NotesIDB.putBlob(uuid, row.blob_ciphertext); } catch (err) { /* ignore */ }
    }
    try {
      await NotesIDB.putItem({
        uuid,
        ciphertext,
        content_hash: row.content_hash || '',
        updated_at: Number(row.updated_at) || Date.now() / 1000,
        deleted: false,
        has_blob: !!(row.blob_ciphertext || row.has_blob),
      });
    } catch (err) {
      /* ignore */
    }
  }

  async function pushDirtyPersisted({ quiet = false } = {}) {
    if (state.blockPushForPasswordRotation) return false;
    const dirtyIds = await loadPersistedDirtyIds();
    if (!dirtyIds.length) return true;
    if (state.pushing && state.activePush) return state.activePush;

    state.pushing = true;
    if (!quiet) emitSync('syncing', 'Saving encrypted changes…');
    const pending = (async () => {
      try {
        const payload = [];
        const deletedIds = new Set();
        const skipped = [];
        for (const uuid of dirtyIds) {
          let row = null;
          try {
            row = await NotesIDB.getItem(uuid);
          } catch (err) {
            row = null;
          }
          if (!row) {
            skipped.push(uuid);
            continue;
          }
          if (row.deleted) deletedIds.add(uuid);
          const item = await buildPushPayloadFromIdbRow(row);
          if (!item) {
            skipped.push(uuid);
            continue;
          }
          payload.push(item);
        }
        if (!payload.length) return skipped.length === 0;
        const body = JSON.stringify({ items: payload });
        const timeoutMs = Math.min(180000, 20000 + Math.floor(body.length / 80));
        const pushRes = await api('/api/sync/items', {
          method: 'POST',
          body,
          timeoutMs,
        });
        const settled = new Set();
        if (Array.isArray(pushRes.results)) {
          for (const row of pushRes.results) {
            if (row.status === 'ok' || row.status === 'unchanged' || row.status === 'stale') {
              settled.add(row.item_uuid);
            }
          }
        }
        const remaining = dirtyIds.filter((id) => !settled.has(id));
        await setPersistedDirtyIds(remaining);
        for (const uuid of settled) {
          if (!deletedIds.has(uuid)) continue;
          try { await NotesIDB.deleteItem(uuid); } catch (err) { /* ignore */ }
        }
        logSync('push-persisted', {
          items: payload.length,
          settled: settled.size,
          skipped: skipped.length,
          quiet: !!quiet,
          ok: true,
        });
        if (!quiet) emitSync('ok', 'Synced');
        return true;
      } catch (e) {
        logSync('push-persisted', {
          ok: false,
          quiet: !!quiet,
          error: e.message || String(e),
        });
        if (!quiet && !isProbablyOffline(e)) emitSync('error', e.message || 'Sync failed');
        return false;
      }
    })();
    state.activePush = pending;
    try {
      return await pending;
    } finally {
      if (state.activePush === pending) {
        state.pushing = false;
        state.activePush = null;
      }
    }
  }

  async function pullCipherWhileLocked({ quiet = true } = {}) {
    if (state.cryptoKey) return false;
    const pending = await loadPersistedDirtyIds();
    if (pending.length) return false;
    let since = Math.max(readStoredLastSync(), Number(await NotesIDB.getMeta('lastSync')) || 0);
    let cursorSince = since;
    let afterUuid = '';
    let pages = 0;
    let watermark = since;
    let any = false;
    while (pages < 200) {
      pages += 1;
      const pullBody = {
        since: cursorSince,
        limit: 50,
        cursor: 'synced_at',
        include_blobs: 0,
      };
      if (afterUuid) pullBody.after = afterUuid;
      const data = await api('/api/sync/pull', {
        method: 'POST',
        body: JSON.stringify(pullBody),
        timeoutMs: syncRequestTimeoutMs(50 * 80000),
      });
      const rows = await fetchMissingBlobs(data.items || []);
      if (!rows.length) break;
      any = true;
      for (const row of rows) {
        watermark = Math.max(watermark, rowCursor(row));
        await persistCipherRowFromServer(row);
        afterUuid = row.item_uuid || afterUuid;
      }
      if (!data.has_more) break;
      cursorSince = watermark;
    }
    if (any && watermark) await rememberLastSync(watermark);
    if (any && !quiet) emitSync('ok', 'Downloaded encrypted notes');
    logSync('pull-cipher-locked', { pages, any, watermark, quiet: !!quiet });
    return any;
  }

  async function syncWhileLocked({ quiet = true } = {}) {
    const pushed = await pushDirtyPersisted({ quiet });
    const pulled = await pullCipherWhileLocked({ quiet });
    return !!(pushed || pulled);
  }

  async function restoreDirtyQueue(tombstoneRows = []) {
    let saved = [];
    try {
      const raw = await NotesIDB.getMeta(DIRTY_META_KEY);
      if (Array.isArray(raw)) saved = raw.map((id) => String(id || '')).filter(Boolean);
    } catch (err) {
      saved = [];
    }
    const pending = new Set(saved);
    for (const row of tombstoneRows) {
      if (pending.has(row.uuid)) {
        state.items.set(row.uuid, {
          uuid: row.uuid,
          content: { deleted: true },
          updated_at: Number(row.updated_at) || 0,
          deleted: true,
        });
      } else {
        // Tombstone already pushed (or abandoned) — nothing left to sync.
        try { await NotesIDB.deleteItem(row.uuid); } catch (err) { /* ignore */ }
      }
    }
    dirtyPersistSuspended = true;
    try {
      for (const uuid of pending) {
        if (state.items.has(uuid)) state.dirty.add(uuid);
      }
    } finally {
      dirtyPersistSuspended = false;
    }
    if (pending.size !== state.dirty.size) persistDirtySoon();
    if (state.dirty.size) logSync('dirty-restored', { dirty: state.dirty.size });
    return state.dirty.size;
  }

  async function loadLocal(options = {}) {
    if (loadLocalInFlight) return loadLocalInFlight;
    loadLocalInFlight = loadLocalInner(options).finally(() => {
      loadLocalInFlight = null;
    });
    return loadLocalInFlight;
  }

  async function loadLocalInner(options = {}) {
    if (!state.cryptoKey) throw new Error('Unlock the vault first');
    const skipBlob = options.skipBlob !== false;
    const onPrimaryReady = typeof options.onPrimaryReady === 'function' ? options.onPrimaryReady : null;
    const cipherRows = [];
    const plainRows = [];
    const tombstoneRows = [];
    const collectRow = (row) => {
      if (row.ciphertext) cipherRows.push(row);
      else if (row.content && !row.ciphertext) plainRows.push(row);
      else if (row.deleted) tombstoneRows.push(row);
    };
    if (typeof NotesIDB.iterateItems === 'function') {
      await NotesIDB.iterateItems(collectRow);
    } else {
      (await NotesIDB.loadItems()).forEach(collectRow);
    }
    const primaryRows = cipherRows.filter((row) => !row.has_blob);
    const attachmentRows = cipherRows.filter((row) => row.has_blob);
    let opened = 0;
    let failed = 0;
    let cipherOpened = 0;
    const ios = unlockPlatformIsIos();
    const fastDecrypt = true;
    const yieldEvery = ios ? 12 : 64;
    const concurrency = unlockDecryptConcurrency(ios);
    let primaryReadyDone = false;
    const reportProgress = (done, phase = 'decrypt', batchTotal = 0) => {
      const total = batchTotal || (phase === 'attachments' ? attachmentRows.length : primaryRows.length) || cipherRows.length;
      onUnlockProgress?.({ done, total, phase });
    };
    if (primaryRows.length) reportProgress(0, 'decrypt', primaryRows.length);
    else reportProgress(0, 'decrypt', 1);
    const decryptBatch = async (rows, phase) => {
      if (!rows.length) return;
      let batchDone = 0;
      const decryptOne = async (i) => {
        const row = rows[i];
        try {
          await ingestCipherRow(row, { fast: fastDecrypt, skipBlob });
          opened += 1;
          cipherOpened += 1;
        } catch (err) {
          failed += 1;
        }
        batchDone += 1;
        if (onUnlockProgress && (
          batchDone === 1
          || batchDone === rows.length
          || batchDone % 4 === 0
          || (!ios && rows.length <= 24)
        )) {
          reportProgress(batchDone, phase, rows.length);
        }
        if (ios && i > 0 && i % yieldEvery === 0) {
          if (typeof NotesIosTune !== 'undefined' && NotesIosTune.yieldMainThread) {
            await NotesIosTune.yieldMainThread();
          } else {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      };
      if (concurrency <= 1 || rows.length <= 2) {
        for (let i = 0; i < rows.length; i += 1) {
          await decryptOne(i);
        }
      } else {
        let next = 0;
        const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
          while (true) {
            const i = next;
            next += 1;
            if (i >= rows.length) break;
            await decryptOne(i);
          }
        });
        await Promise.all(workers);
      }
      reportProgress(rows.length, phase, rows.length);
    };
    await decryptBatch(primaryRows, 'decrypt');
    if (onPrimaryReady && !primaryReadyDone) {
      primaryReadyDone = true;
      try {
        await onPrimaryReady({ opened, failed, cipherOpened, partial: attachmentRows.length > 0 });
      } catch (err) {
        console.warn('unlock primary ready failed', err);
      }
    }
    for (const row of plainRows) {
      const item = {
        uuid: row.uuid,
        content: row.content,
        updated_at: row.updated_at || 0,
        deleted: !!row.deleted,
      };
      state.items.set(row.uuid, item);
      opened += 1;
      const light = strippedAttachmentContent(item.content);
      if (light) item.content = light;
    }
    if (attachmentRows.length) {
      attachmentDecryptInFlight = decryptBatch(attachmentRows, 'attachments')
        .finally(() => {
          attachmentDecryptInFlight = null;
        });
    }
    await restoreDirtyQueue(tombstoneRows);
    const savedSync = Number(await NotesIDB.getMeta('lastSync')) || 0;
    if (cipherRows.length === 0 && plainRows.length === 0) {
      // Empty IndexedDB must not reuse a stale watermark — that skips the full
      // download after cache clears / Update now, leaving a blank note list.
      state.lastSync = 0;
      try {
        localStorage.removeItem('notes_last_sync');
      } catch (err) {
        /* ignore */
      }
      try {
        await NotesIDB.putMeta('lastSync', 0);
      } catch (err) {
        /* ignore */
      }
    } else {
      const openedNotes = [...state.items.values()]
        .filter((item) => item.content?.type === 'note' && !item.deleted).length;
      if (openedNotes > 0) {
        // Never fold localWatermark() (client edit clock) into the pull cursor:
        // the cursor lives on the server's synced_at timeline, and a device
        // clock running ahead would skip other devices' changes.
        state.lastSync = Math.max(savedSync, readStoredLastSync());
        if (state.lastSync) {
          try {
            localStorage.setItem('notes_last_sync', String(state.lastSync));
          } catch (err) {
            /* ignore */
          }
        }
      } else {
        // Tags/attachments alone must not advance the pull cursor — that skips
        // note ciphertext on the next incremental sync and stalls at ~98%.
        state.lastSync = 0;
        try {
          localStorage.removeItem('notes_last_sync');
        } catch (err) {
          /* ignore */
        }
        try {
          await NotesIDB.putMeta('lastSync', 0);
        } catch (err) {
          /* ignore */
        }
      }
    }
    if (!state.cryptoKey) throw lockedError();
    state.localReady = true;
    scheduleUnlockMaintenance();
    if (failed && !opened) {
      const err = new Error('Wrong password or the local vault is unreadable');
      err.code = 'LOCAL_DECRYPT_FAILED';
      err.failed = failed;
      throw err;
    }
    return { opened, failed, cipherOpened };
  }

  async function loadAccount() {
    state.account = await api('/api/account', { timeoutMs: 4000 });
    cacheAccount(state.account);
    return state.account;
  }

  async function pushDirty({ quiet = false } = {}) {
    await finishLoadLocal();
    await finishUnlockMaintenance();
    if (state.blockPushForPasswordRotation) {
      notifyStatus('Unlock with your new vault password to sync');
      emitSync('pending', 'Password changed on another device');
      return false;
    }
    if (state.pushing) return state.activePush || Promise.resolve(true);
    if (!state.dirty.size) {
      if (!state.cryptoKey) return pushDirtyPersisted({ quiet });
      return true;
    }
    // Locked vault: push pre-encrypted rows from IndexedDB when possible.
    if (!state.cryptoKey) return pushDirtyPersisted({ quiet });

    state.pushing = true;
    if (!quiet) {
      notifyStatus('Saving…');
      emitSync('syncing', 'Saving…');
    }
    const epoch = state.lockEpoch;
    const pending = (async () => {
      try {
        const snapshots = new Map();
        const payload = [];
        const deletedIds = new Set();
        for (const uuid of [...state.dirty]) {
          const item = state.items.get(uuid);
          if (!item) {
            state.dirty.delete(uuid);
            continue;
          }
          if (!state.cryptoKey) throw lockedError();
          await sealAttachmentContent(item.content);
          const content = { ...item.content };
          if (item.deleted) {
            content.deleted = true;
            deletedIds.add(uuid);
          }
          snapshots.set(uuid, item.updated_at);
          payload.push(await wrapItem(uuid, content, item.updated_at));
        }
        if (!payload.length) {
          if (!quiet) {
            notifyStatus('Saved');
            emitSync('ok', 'Synced');
          }
          return true;
        }
        const body = JSON.stringify({ items: payload });
        const timeoutMs = Math.min(180000, 20000 + Math.floor(body.length / 80));
        const pushStarted = Date.now();
        const pushRes = await api('/api/sync/items', {
          method: 'POST',
          body,
          timeoutMs,
        });
        const settled = [];
        if (Array.isArray(pushRes.results)) {
          for (const row of pushRes.results) {
            // "stale": another device stored a newer version — drop our pending
            // write; the next pull brings the winning copy.
            if (row.status === 'ok' || row.status === 'unchanged' || row.status === 'stale') {
              settled.push(row.item_uuid);
            }
          }
        } else {
          NotesSanitize.clearUnchangedDirty(state.dirty, snapshots, (uuid) => state.items.get(uuid)?.updated_at);
          for (const uuid of snapshots.keys()) {
            if (!state.dirty.has(uuid)) settled.push(uuid);
          }
        }
        // A lock during the request already dropped the in-memory queue; the
        // persisted copy is reconciled on the next unlock (server answers "unchanged").
        if (state.lockEpoch === epoch) {
          for (const uuid of settled) state.dirty.delete(uuid);
        }
        for (const uuid of settled) {
          if (!deletedIds.has(uuid)) continue;
          try { await NotesIDB.deleteItem(uuid); } catch (err) { /* tombstone cleanup is best effort */ }
        }
        logSync('push', {
          items: payload.length,
          bytes: body.length,
          ms: Date.now() - pushStarted,
          quiet: !!quiet,
          ok: true,
          accepted: pushRes.accepted,
          unchanged: pushRes.unchanged,
          stale: pushRes.stale,
        });
        if (state.lockEpoch === epoch) await NotesIDB.putMeta('lastSync', state.lastSync);
        if (!quiet) {
          notifyStatus('Saved');
          emitSync('ok', 'Synced');
        }
        return true;
      } catch (e) {
        if (e?.code === 'VAULT_LOCKED' || (!state.cryptoKey && state.lockEpoch !== epoch)) {
          logSync('push', { ok: false, quiet: !!quiet, error: 'vault locked', dirty: state.dirty.size });
          return false;
        }
        console.error('push failed', e);
        logSync('push', {
          ok: false,
          quiet: !!quiet,
          error: e.message || String(e),
          dirty: state.dirty.size,
        });
        if (isProbablyOffline(e)) {
          if (!quiet) {
            notifyStatus('Saved on this device · will sync when online');
            emitSync('offline', 'Offline');
          }
          return false;
        }
        notifyStatus(`Save failed: ${e.message}`, true);
        if (!quiet) emitSync('error', e.message || 'Sync failed');
        return false;
      }
    })();
    state.activePush = pending;
    let ok = false;
    try {
      ok = await pending;
    } finally {
      if (state.activePush === pending) {
        state.pushing = false;
        state.activePush = null;
      }
    }
    if (ok && state.dirty.size) return pushDirty({ quiet });
    return ok;
  }

  function schedulePush() {
    emitSync('pending', 'Waiting to sync');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      pushDirty();
    }, 400);
  }

  async function refetchSyncItems(uuids, { includeBlobs = true } = {}) {
    const ids = [...new Set((uuids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const data = await api('/api/sync/refetch', {
        method: 'POST',
        body: JSON.stringify({ uuids: chunk, include_blobs: includeBlobs ? 1 : 0 }),
        timeoutMs: syncRequestTimeoutMs(chunk.length * 120000),
      });
      out.push(...(data.items || []));
    }
    return out;
  }

  // Server-side receive time of a sync row (falls back to the client edit time
  // for servers that predate the synced_at cursor).
  function rowCursor(row) {
    const synced = Number(row?.synced_at);
    if (Number.isFinite(synced) && synced > 0) return synced;
    return Number(row?.updated_at) || 0;
  }

  async function applySyncPayload(data, { finalize = true, progress = null, quiet = false } = {}) {
    const rows = orderSyncRows(data.items || []);
    const total = rows.length;
    let decryptSkipped = 0;
    let decryptOk = 0;
    let firstFailedAt = null;
    let watermark = state.lastSync || 0;
    const unchangedMisses = [];
    const doneBefore = Math.max(0, Number(progress?.doneBefore) || 0);
    const expectedTotal = Math.max(1, Number(progress?.expectedTotal) || total || 1);
    const epoch = state.lockEpoch;
    let protectionPushNeeded = false;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      // Locked mid-pull: stop here. Rows are not persisted without the key and
      // the cursor must stay where it was so the next unlock resumes cleanly.
      if (state.lockEpoch !== epoch || !state.cryptoKey) throw lockedError();
      if (row.unchanged) {
        if (!row.deleted && !state.items.has(row.item_uuid)) {
          unchangedMisses.push(row.item_uuid);
          logSync('unchanged-miss', { uuid: row.item_uuid, hash: row.content_hash || '' });
        }
        watermark = Math.max(watermark, rowCursor(row));
        continue;
      }
      if (!state.cryptoKey) {
        decryptSkipped += 1;
        if (firstFailedAt == null) firstFailedAt = Number(row.updated_at) || 0;
      } else {
        try {
          const remote = await unwrapItem(row);
          const local = state.items.get(row.item_uuid);
          const localWins = local && !local.deleted && (local.updated_at || 0) > (row.updated_at || 0);
          let applied = false;
          let protectionMerged = false;
          if (row.deleted) {
            if (!localWins) {
              state.items.delete(row.item_uuid);
              await NotesIDB.deleteItem(row.item_uuid);
              if (typeof NotesSearch !== 'undefined' && NotesSearch.removeFromIndex) {
                NotesSearch.removeFromIndex(row.item_uuid);
              }
              applied = true;
            }
          } else if (localWins) {
            if (local?.content?.type === 'note' && remote.content?.type === 'note') {
              const { changed, content } = mergeCrossDeviceProtection(local.content, remote.content);
              if (changed) {
                const next = {
                  ...local,
                  content,
                  content_hash: row.content_hash || local.content_hash,
                };
                state.items.set(row.item_uuid, next);
                state.dirty.add(row.item_uuid);
                protectionPushNeeded = true;
                await persistLocal(row.item_uuid, next);
                updateSearchIndexFor(row.item_uuid);
                applied = true;
                protectionMerged = true;
              }
            } else if (
              local?.content?.type === 'attachment'
              && remote.content?.type === 'attachment'
              && attachmentIndexReady(remote.content)
              && !attachmentIndexReady(local.content)
            ) {
              // This device may have touched the file while another device
              // finished indexing. Keep the synced text so we do not OCR again.
              const content = { ...local.content };
              adoptRemoteOcr(content, remote.content);
              const next = { ...local, content };
              state.items.set(row.item_uuid, next);
              await persistLocal(row.item_uuid, next);
              const light = strippedAttachmentContent(next.content);
              if (light) next.content = light;
              if (content.note_id) refreshNoteSearchText(content.note_id);
              applied = true;
            }
          } else {
            const prevLocked = !!local?.content?.locked;
            const prevPrevent = !!local?.content?.prevent_edit;
            if (remote.content?.type === 'note') attachLiveIds(remote.content, row.item_uuid);
            state.items.set(row.item_uuid, remote);
            if (row.content_hash) remote.content_hash = row.content_hash;
            await persistLocal(row.item_uuid, remote);
            if (remote.content?.type === 'note') {
              if (!progress?.deferSearchIndex) updateSearchIndexFor(row.item_uuid);
              protectionMerged = !!remote.content.locked !== prevLocked
                || !!remote.content.prevent_edit !== prevPrevent;
            }
            // Keep pulled photo/PDF bytes out of memory (iOS tab stability).
            const light = strippedAttachmentContent(remote.content);
            if (light) remote.content = light;
            if (remote.content?.type === 'attachment' && remote.content.note_id) {
              refreshNoteSearchText(remote.content.note_id);
            }
            applied = true;
          }
          if (applied && !row.deleted && remote.content?.type === 'note' && onNoteIngested) {
            try {
              onNoteIngested(row.item_uuid, {
                expectedTotal,
                done: doneBefore + i + 1,
                quiet: !!quiet,
                protectionMerged,
              });
            } catch (ingestErr) { /* ignore */ }
          }
          decryptOk += 1;
          watermark = Math.max(watermark, rowCursor(row));
        } catch (e) {
          if (e?.code === 'VAULT_LOCKED') throw e;
          if (!state.cryptoKey || state.lockEpoch !== epoch) throw lockedError();
          console.warn('decrypt failed', row.item_uuid, e);
          decryptSkipped += 1;
          if (firstFailedAt == null) firstFailedAt = Number(row.updated_at) || 0;
          // Keep going — one bad blob must not stop the rest of the vault.
        }
      }
      const done = doneBefore + i + 1;
      const rawPct = Math.round((done / expectedTotal) * 100);
      // Stay under 100% until the final page finishes (caller emits 100%).
      const pct = progress?.isFinalPage && i === total - 1
        ? 100
        : Math.max(1, Math.min(99, rawPct));
      if (!quiet && (i === 0 || i === total - 1 || i % 2 === 1 || total <= 3)) {
        const liveNotes = listNotes().filter((n) => !n.content?.trashed).length;
        const noteHint = liveNotes ? ` · ${liveNotes} note${liveNotes === 1 ? '' : 's'}` : '';
        emitSync('syncing', `Downloading… ${pct}% (${done}/${expectedTotal})${noteHint}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (protectionPushNeeded) schedulePush();
    if (finalize && !decryptSkipped) {
      await rememberLastSync(Number(data.cursor) || data.server_time || watermark || Date.now() / 1000);
    } else if (!decryptSkipped && watermark) {
      await rememberLastSync(watermark);
    }
    return {
      decryptSkipped,
      decryptOk,
      firstFailedAt,
      watermark,
      processed: rows.length,
      unchangedMisses,
    };
  }

  async function pullChanges(since, { quiet = false } = {}) {
    const pullSince = Number(since) || 0;
    const deferSearchIndex = pullSince === 0;
    let cursorSince = pullSince;
    let afterUuid = '';
    let pages = 0;
    let lastData = { items: [], server_time: Date.now() / 1000, has_more: false };
    let anyItems = false;
    let decryptSkipped = 0;
    let decryptOk = 0;
    let firstFailedAt = null;
    let processed = 0;
    let expectedTotal = 0;
    let pageLimit = 50;
    let lastPageBytes = 0;
    const MIN_PAGE_LIMIT = 10;
    const MAX_PAGE_LIMIT = 50;
    const PAGE_BYTE_SOFT_CAP = 2_800_000;
    const epoch = state.lockEpoch;
    let serverCursor = 0;
    while (pages < 2000) {
      pages += 1;
      if (!state.cryptoKey || state.lockEpoch !== epoch) throw lockedError();
      // Full vault pulls must always receive ciphertext. Sending known_hashes on
      // since=0 used to mark notes as unchanged when only tags/attachments were
      // in memory, so progress hit 98% while the note list stayed empty.
      const known = pullSince > 0 && state.items.size > 0 ? localContentHashes() : {};
      const pullBody = {
        since: cursorSince,
        limit: pageLimit,
        // Page and filter on the server's receive time, not on client edit
        // time — otherwise an offline/late push lands behind our cursor forever.
        cursor: 'synced_at',
        include_blobs: cursorSince > 0 || state.lightVault ? 0 : 1,
      };
      if (afterUuid) pullBody.after = afterUuid;
      if (Object.keys(known).length) pullBody.known_hashes = known;
      const pageStarted = Date.now();
      let data;
      let rows;
      let pageBytes = 0;
      try {
        data = await api('/api/sync/pull', {
          method: 'POST',
          body: JSON.stringify(pullBody),
          timeoutMs: syncRequestTimeoutMs(Math.max(lastPageBytes, pageLimit * 80000)),
        });
        lastData = data;
        if (Number(data.cursor) > 0) serverCursor = Math.max(serverCursor, Number(data.cursor));
        rows = await fetchMissingBlobs(data.items || []);
        pageBytes = rows.reduce(
          (sum, row) => sum + String(row.ciphertext || '').length + String(row.blob_ciphertext || '').length,
          0,
        );
      } catch (err) {
        const timedOut = err?.name === 'AbortError'
          || /timed out/i.test(String(err?.message || ''));
        if (processed > 0 && timedOut) {
          logSync('pull-partial', {
            page: pages,
            since: cursorSince,
            processed,
            decryptOk,
            decryptSkipped,
            error: err.message || String(err),
            quiet: !!quiet,
          });
          if (cursorSince) await rememberLastSync(cursorSince);
          return {
            ...lastData,
            decryptSkipped,
            decryptOk,
            firstFailedAt,
            pages,
            processed,
            total_undeleted: lastData.total_undeleted,
            partial: true,
            resumeSince: cursorSince,
            resumeAfter: afterUuid,
          };
        }
        throw err;
      }
      if (!rows.length) {
        logSync('pull-page', {
          page: pages,
          since: cursorSince,
          items: 0,
          bytes: pageBytes,
          ms: Date.now() - pageStarted,
          hasMore: !!data.has_more,
          quiet: !!quiet,
          total: Number(data.total_undeleted) || 0,
        });
        break;
      }
      if (pages === 1 && pullSince === 0 && !quiet && onVaultPullBegin) {
        try {
          onVaultPullBegin(Number(data.total_undeleted) || rows.length || 0);
        } catch (err) { /* ignore */ }
      }
      anyItems = true;
      const serverTotal = Number(data.total_undeleted) || 0;
      if (!expectedTotal) {
        // Full vault pull: use server count. Incremental: grow as pages arrive.
        expectedTotal = Number(since) === 0
          ? Math.max(serverTotal, rows.length)
          : (data.has_more ? Math.max(rows.length + 1, pageLimit) : rows.length);
      }
      if (data.has_more) {
        expectedTotal = Math.max(expectedTotal, processed + rows.length + 1);
        if (Number(since) === 0 && serverTotal) {
          expectedTotal = Math.max(expectedTotal, serverTotal);
        }
      } else {
        expectedTotal = Math.max(processed + rows.length, Number(since) === 0 ? serverTotal : 0);
      }
      const page = await applySyncPayload(data, {
        finalize: false,
        quiet,
        progress: {
          doneBefore: processed,
          expectedTotal: Math.max(expectedTotal, processed + rows.length),
          isFinalPage: !data.has_more,
          quiet,
          deferSearchIndex,
        },
      });
      if (page.unchangedMisses?.length) {
        try {
          const refetched = await refetchSyncItems(page.unchangedMisses, {
            includeBlobs: cursorSince === 0 && !state.lightVault,
          });
          if (refetched.length) {
            const fixed = await fetchMissingBlobs(refetched);
            const refill = await applySyncPayload(
              { items: fixed, server_time: data.server_time },
              { finalize: false, quiet, progress: { doneBefore: processed, expectedTotal, quiet, deferSearchIndex } },
            );
            decryptSkipped += refill.decryptSkipped || 0;
            decryptOk += refill.decryptOk || 0;
            if (refill.firstFailedAt != null && firstFailedAt == null) {
              firstFailedAt = refill.firstFailedAt;
            }
            logSync('unchanged-refetch', {
              requested: page.unchangedMisses.length,
              received: refetched.length,
              decryptOk: refill.decryptOk || 0,
              decryptSkipped: refill.decryptSkipped || 0,
            });
          }
        } catch (err) {
          logSync('unchanged-refetch-failed', {
            count: page.unchangedMisses.length,
            error: err.message || String(err),
          });
        }
      }
      processed += rows.length;
      decryptSkipped += page.decryptSkipped || 0;
      decryptOk += page.decryptOk || 0;
      logSync('pull-page', {
        page: pages,
        since: cursorSince,
        items: rows.length,
        bytes: pageBytes,
        ms: Date.now() - pageStarted,
        hasMore: !!data.has_more,
        quiet: !!quiet,
        decryptOk: page.decryptOk || 0,
        decryptSkipped: page.decryptSkipped || 0,
        total: Number(data.total_undeleted) || 0,
      });
      if (page.firstFailedAt != null && firstFailedAt == null) {
        firstFailedAt = page.firstFailedAt;
      }
      if (!quiet && onVaultPullPage) {
        try {
          onVaultPullPage({
            expectedTotal: Number(data.total_undeleted) || expectedTotal || 0,
            notes: listNotes().filter((n) => !n.content?.trashed).length,
            processed,
            page: pages,
          });
        } catch (err) { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      lastPageBytes = pageBytes;
      const last = rows[rows.length - 1];
      cursorSince = rowCursor(last) || cursorSince;
      afterUuid = String(last.item_uuid || '');
      if (data.has_more) {
        if (pageBytes >= PAGE_BYTE_SOFT_CAP && pageLimit > MIN_PAGE_LIMIT) {
          pageLimit = Math.max(MIN_PAGE_LIMIT, Math.floor(pageLimit / 2));
        } else if (pageBytes < PAGE_BYTE_SOFT_CAP / 2 && pageLimit < MAX_PAGE_LIMIT) {
          pageLimit = Math.min(MAX_PAGE_LIMIT, pageLimit + 10);
        }
      }
      // Byte-budget pages can be shorter than limit while more items remain.
      // Only stop when the server says there is nothing left.
      if (!data.has_more) break;
    }
    if (!state.cryptoKey || state.lockEpoch !== epoch) throw lockedError();
    if (anyItems && !decryptSkipped && !quiet) {
      emitSync('syncing', `Downloading… 100% (${processed}/${Math.max(expectedTotal, processed)})`);
    }
    if (decryptSkipped && decryptOk === 0) {
      // Do NOT jump to server_time — that permanently skips undecryptable items.
      // Reset only when nothing decrypted (wrong key). Partial failures keep the
      // watermark to avoid full-vault re-pull loops on the 30s quiet sync.
      await rememberLastSync(0);
      try {
        localStorage.removeItem('notes_last_sync');
      } catch (err) {
        /* ignore */
      }
    } else if (anyItems || lastData.server_time || serverCursor) {
      // Prefer the server-computed cursor (max synced_at seen, held a few seconds
      // behind "now" so an in-flight push from another device is not skipped).
      const next = serverCursor
        ? Math.max(serverCursor, cursorSince)
        : (lastData.server_time || cursorSince || Date.now() / 1000);
      await rememberLastSync(next);
    }
    if (deferSearchIndex && anyItems) rebuildSearchIndex();
    return {
      ...lastData,
      decryptSkipped,
      decryptOk,
      firstFailedAt,
      pages,
      processed,
      total_undeleted: lastData.total_undeleted,
    };
  }

  async function clearUnreadableLocal({ resetSync = true, onlyIfMemoryEmpty = true } = {}) {
    if (onlyIfMemoryEmpty && listNotes().length > 0) {
      return { removed: 0, skipped: 'memory-has-notes' };
    }
    const rows = await NotesIDB.loadItems();
    let removed = 0;
    for (const row of rows) {
      if (!row.ciphertext) continue;
      const live = state.items.get(row.uuid);
      if (live && !live.deleted && live.content) {
        continue;
      }
      if (!state.cryptoKey) {
        await NotesIDB.deleteItem(row.uuid);
        state.items.delete(row.uuid);
        state.dirty.delete(row.uuid);
        removed += 1;
        continue;
      }
      try {
        await unwrapItem({
          item_uuid: row.uuid,
          ciphertext: row.ciphertext,
          updated_at: row.updated_at,
          deleted: row.deleted,
        });
      } catch (err) {
        await NotesIDB.deleteItem(row.uuid);
        state.items.delete(row.uuid);
        state.dirty.delete(row.uuid);
        removed += 1;
      }
    }
    state.localReady = true;
    // Only reset the pull cursor when the caller is recovering from a bad cache.
    // Post-sync cleanup must not force a full download on every quiet sync.
    if (resetSync) await rememberLastSync(0);
    return { removed };
  }

  /** Remove all notes, blobs, and sync metadata from this device (server ciphertext unchanged). */
  async function clearDeviceData() {
    dirtyPersistSuspended = true;
    try {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      state.items.clear();
      state.dirty.clear();
      state.lastSync = 0;
      state.localReady = false;
      state.cryptoKey = null;
      state.altCryptoKey = null;
      if (typeof NotesIDB.clearAll === 'function') {
        await NotesIDB.clearAll();
      }
    } finally {
      dirtyPersistSuspended = false;
    }
    try {
      localStorage.removeItem(SYNC_LOG_KEY);
      localStorage.removeItem(PASSWORD_ACK_KEY);
      localStorage.removeItem('notes_last_sync');
      localStorage.removeItem('notes_kdf_salt');
      localStorage.removeItem('notes_vault_kdf_version');
      localStorage.removeItem('notes_vault_kdf_upgrade_pending');
      localStorage.removeItem('notes_vault_kdf_migration_complete');
      localStorage.removeItem('notes_offline_unlock_verified');
      localStorage.removeItem('notes_device_password');
      localStorage.removeItem('notes_test_password');
      localStorage.removeItem('notes_pending_device_report');
      localStorage.removeItem('notes_remember_device_declined');
    } catch (err) {
      /* ignore */
    }
    try {
      sessionStorage.removeItem('notes_unlocked');
      sessionStorage.removeItem('notes_salt');
      sessionStorage.removeItem('notes_kdf_salt');
      sessionStorage.removeItem('notes_kdf_cache');
      sessionStorage.removeItem('notes_csrf');
      sessionStorage.removeItem('notes_open_id');
    } catch (err) {
      /* ignore */
    }
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.clearSecrets();
      NotesVaultSecrets.clearDevicePassword();
    }
    if (typeof NotesCrypto !== 'undefined' && typeof NotesCrypto.terminateWorker === 'function') {
      NotesCrypto.terminateWorker();
    }
  }

  async function localCipherCount() {
    try {
      const rows = await NotesIDB.loadItems();
      return rows.filter((row) => row.ciphertext).length;
    } catch (err) {
      return 0;
    }
  }

  async function sync({ quiet = false, full = false } = {}) {
    await finishLoadLocal();
    await finishUnlockMaintenance();
    const syncStarted = Date.now();
    const sinceBefore = syncSince();
    logSync('sync-start', {
      quiet: !!quiet,
      full: !!full,
      local: state.items.size,
      dirty: state.dirty.size,
      lastSync: Number(state.lastSync) || 0,
      since: sinceBefore,
      kdf: state.kdfVersion || 1,
    });
    if (!quiet) emitSync('syncing', 'Syncing…');
    try {
      if (!state.cryptoKey) {
        if (!quiet) emitSync('error', 'Unlock the vault first');
        throw new Error('Unlock the vault first');
      }
      // Unreadable local cache used to leave localReady=false and silently skip sync.
      if (!state.localReady) state.localReady = true;
      await retryPendingVaultKdfUpgrade();
      await pushDirty({ quiet });
      const hadLocalItems = state.items.size > 0;
      const sizeBefore = state.items.size;
      const notesBefore = listNotes().filter((n) => !n.content?.trashed).length;
      const needsFullVault = full || notesBefore === 0;
      let since = needsFullVault ? 0 : syncSince();
      if (needsFullVault) await rememberLastSync(0);
      if (!quiet) emitSync('syncing', since ? 'Checking for changes…' : 'Downloading notes…');
      let pull = await pullChanges(since, { quiet });
      let noteCount = listNotes().filter((n) => !n.content?.trashed).length;
      if (pull.decryptSkipped > 0 && noteCount === 0) {
        const password = (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword())
      || '';
        const salt = sessionStorage.getItem('notes_salt') || cachedAccount().kdf_salt;
        if (password && salt) {
          const altVersion = state.kdfVersion >= 2 ? 1 : 2;
          logSync('kdf-retry', { from: state.kdfVersion, to: altVersion, decryptSkipped: pull.decryptSkipped });
          await unlock(password, salt, { kdfVersion: altVersion });
          await rememberLastSync(0);
          pull = await pullChanges(0, { quiet });
          noteCount = listNotes().filter((n) => !n.content?.trashed).length;
        }
      }
      if (noteCount === 0 && Number(pull.total_undeleted) > 0
        && (pull.decryptSkipped > 0 || (since === 0 && (pull.processed || 0) > 0))) {
        logSync('note-retry', {
          decryptSkipped: pull.decryptSkipped || 0,
          decryptOk: pull.decryptOk || 0,
          total: Number(pull.total_undeleted) || 0,
        });
        await rememberLastSync(0);
        pull = await pullChanges(0, { quiet });
        noteCount = listNotes().filter((n) => !n.content?.trashed).length;
      }
      // Only refill from zero. A slightly lower local count than
      // total_undeleted (tags/attachments, leftover failed decrypts) must not
      // restart a full vault download on every load and 30s timer.
      const liveCount = [...state.items.values()].filter((item) => !item.deleted).length;
      const serverTotal = Number(pull.total_undeleted) || 0;
      const totpCount = countTotpItems();
      const vaultLooksIncomplete = serverTotal > 0 && liveCount < serverTotal;
      const missingTotpAfterSync = totpCount === 0 && noteCount > 0 && vaultLooksIncomplete;
      if (serverTotal > 0 && since > 0
        && ((noteCount === 0 && (liveCount === 0 || (pull.processed || 0) === 0))
          || missingTotpAfterSync)) {
        if (!quiet) emitSync('syncing', 'Downloading full vault…');
        logSync('sync-empty-refill', {
          since,
          serverTotal,
          liveCount,
          totpCount,
          processed: pull.processed || 0,
          missingTotp: missingTotpAfterSync,
        });
        await rememberLastSync(0);
        pull = await pullChanges(0, { quiet });
        noteCount = listNotes().filter((n) => !n.content?.trashed).length;
      }
      const hasChanges = state.items.size !== sizeBefore;
      let notes = listNotes().filter((n) => !n.content?.trashed).length;
      if (notesBefore > 0 && notes === 0) {
        logSync('sync-notes-lost', {
          notesBefore,
          decryptSkipped: pull.decryptSkipped || 0,
          decryptOk: pull.decryptOk || 0,
          local: state.items.size,
        });
        try {
          await loadLocal({});
          notes = listNotes().filter((n) => !n.content?.trashed).length;
          if (notes > 0) {
            logSync('sync-recovered-local', { recovered: notes });
            emitSync('error', 'Sync could not refresh your notes — showing the local copy on this device.');
          }
        } catch (err) {
          console.warn('reload local after sync loss failed', err);
        }
      }
      if (pull.decryptSkipped > 0) {
        const opened = Math.max(Number(pull.decryptOk) || 0, notes, state.items.size);
        if (notes === 0) {
          const msg = pull.decryptOk > 0
            ? `Downloaded ${pull.decryptOk} items but no notes opened — check vault password or tap Sync again.`
            : `Could not decrypt ${pull.decryptSkipped} item(s). Use the same vault password as on your phone.`;
          emitSync('error', msg);
          if (pull.decryptOk === 0) {
            const err = new Error(msg);
            err.code = 'DECRYPT_PARTIAL';
            err.decryptSkipped = pull.decryptSkipped;
            err.opened = 0;
            throw err;
          }
        } else if (opened <= 0) {
          const msg = `Could not decrypt ${pull.decryptSkipped} item(s). Use the same vault password as on your phone.`;
          emitSync('error', msg);
          const err = new Error(msg);
          err.code = 'DECRYPT_PARTIAL';
          err.decryptSkipped = pull.decryptSkipped;
          err.opened = 0;
          throw err;
        }
        const warn = `${pull.decryptSkipped} item(s) could not be decrypted — showing ${notes} note${notes === 1 ? '' : 's'}.`;
        logSync('decrypt-partial', {
          decryptSkipped: pull.decryptSkipped,
          decryptOk: pull.decryptOk || 0,
          notes,
          local: state.items.size,
        });
        if (!quiet || hasChanges) {
          emitSync('ok', notes ? `Synced · ${notes} notes (${pull.decryptSkipped} skipped)` : warn);
        }
      } else if (pull.partial) {
        const msg = notes
          ? `Download paused · ${notes} note${notes === 1 ? '' : 's'} so far — tap Sync to continue`
          : 'Download paused — tap Sync to continue';
        if (!quiet) emitSync('syncing', msg);
        logSync('sync-paused', {
          processed: pull.processed || 0,
          pages: pull.pages || 0,
          notes,
          resumeSince: pull.resumeSince || 0,
        });
        const serverTotal = Number(pull.total_undeleted) || 0;
        const liveCount = [...state.items.values()].filter((item) => !item.deleted).length;
        if (serverTotal > liveCount) {
          setTimeout(() => {
            sync({ quiet: true }).catch(() => {});
          }, 1500);
        }
      } else if (!quiet || hasChanges) {
        emitSync('ok', notes ? `Synced · ${notes} notes` : 'Synced');
      }
      pull.liveCount = [...state.items.values()].filter((item) => !item.deleted).length;
      pull.noteCount = listNotes().filter((n) => !n.content?.trashed).length;
      state.lastSyncAt = Date.now();
      logSync('sync-done', {
        quiet: !!quiet,
        full: !!full,
        ok: true,
        ms: Date.now() - syncStarted,
        items: pull.processed || 0,
        pages: pull.pages || 0,
        decryptOk: pull.decryptOk || 0,
        decryptSkipped: pull.decryptSkipped || 0,
        local: state.items.size,
        dirty: state.dirty.size,
        lastSync: Number(state.lastSync) || 0,
        since,
      });
      return state.items;
    } catch (err) {
      logSync('sync-done', {
        quiet: !!quiet,
        full: !!full,
        ok: false,
        ms: Date.now() - syncStarted,
        error: err.message || String(err),
        local: state.items.size,
        dirty: state.dirty.size,
      });
      if (err?.code === 'VAULT_LOCKED') {
        // Expected when the vault locks mid-sync — not a sync failure.
        throw err;
      }
      if (!quiet && err?.code !== 'DECRYPT_PARTIAL') {
        if (isProbablyOffline(err)) emitSync('offline', 'Offline');
        else emitSync('error', err.message || 'Sync failed');
      }
      throw err;
    } finally {
      if (onVaultPullEnd) {
        try { onVaultPullEnd(); } catch (err) { /* ignore */ }
      }
    }
  }

  function listNotes() {
    return [...state.items.values()].filter((i) => i.content?.type === 'note' && !i.deleted);
  }

  function normalizeTotpSecret(secret) {
    return String(secret || '').toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
  }

  function countTotpItems() {
    return [...state.items.values()].filter((item) => item.content?.type === 'totp' && !item.deleted).length;
  }

  function listTotpAccounts() {
    const seen = new Set();
    return [...state.items.values()]
      .filter((item) => item.content?.type === 'totp' && !item.deleted)
      .sort((a, b) => {
        const left = `${a.content.issuer || ''} ${a.content.account || ''}`.toLowerCase();
        const right = `${b.content.issuer || ''} ${b.content.account || ''}`.toLowerCase();
        return left.localeCompare(right);
      })
      .filter((item) => {
        const secret = normalizeTotpSecret(item.content.secret);
        if (!secret) return false;
        if (seen.has(secret)) return false;
        seen.add(secret);
        return true;
      });
  }

  function dedupeTotpAccounts() {
    const live = [...state.items.values()].filter((item) => item.content?.type === 'totp' && !item.deleted);
    const planned = (typeof NotesTotp !== 'undefined' && NotesTotp.planDedupe)
      ? NotesTotp.planDedupe(live.map((item) => ({
        id: item.uuid,
        secret: item.content.secret,
        issuer: item.content.issuer,
        account: item.content.account,
        created_at: item.content.created_at,
      })))
      : { keep: live, removeIds: [] };
    const keepById = new Map((planned.keep || []).map((entry) => [entry.id, entry]));
    let removed = 0;
    for (const id of planned.removeIds || []) {
      const extra = get(id);
      const keeper = planned.keep && planned.keep.find((entry) => normalizeTotpSecret(entry.secret) === normalizeTotpSecret(extra && extra.content && extra.content.secret));
      if (extra && keeper) {
        const keepItem = get(keeper.id);
        if (keepItem && keepItem.content) {
          const next = { ...keepItem.content };
          let changed = false;
          if (!String(next.issuer || '').trim() && extra.content.issuer) {
            next.issuer = extra.content.issuer;
            changed = true;
          }
          if (!String(next.account || '').trim() && extra.content.account) {
            next.account = extra.content.account;
            changed = true;
          }
          if (changed) upsert(keepItem.uuid, next);
        }
      }
      if (removeTotpAccount(id)) removed += 1;
    }
    return { removed, kept: keepById.size || live.length - removed };
  }

  function addTotpAccount(entry) {
    const secret = normalizeTotpSecret(entry && entry.secret);
    if (!secret) throw new Error('Missing authenticator secret');
    const existing = listTotpAccounts().find((item) => normalizeTotpSecret(item.content.secret) === secret);
    if (existing) return { uuid: existing.uuid, created: false, item: existing };
    const now = new Date().toISOString();
    const id = newUuid();
    upsert(id, {
      type: 'totp',
      issuer: String((entry && entry.issuer) || '').trim(),
      account: String((entry && (entry.account || entry.issuer)) || 'Account').trim() || 'Account',
      secret,
      digits: Number((entry && entry.digits) || 6) || 6,
      period: Number((entry && entry.period) || 30) || 30,
      algorithm: String((entry && entry.algorithm) || 'SHA1').toUpperCase().replace('-', ''),
      created_at: now,
      updated_at: now,
    });
    return { uuid: id, created: true, item: get(id) };
  }

  function removeTotpAccount(uuid) {
    const item = get(uuid);
    if (!item || item.content?.type !== 'totp') return false;
    remove(uuid);
    return true;
  }

  function listTags() {
    return [...state.items.values()]
      .filter((i) => i.content?.type === 'tag' && !i.deleted)
      .sort((a, b) => (a.content.title || '').localeCompare(b.content.title || ''));
  }

  function noteCountForTag(tagId) {
    return listNotes().filter(
      (n) => !n.content.trashed && (n.content.tags || []).includes(tagId),
    ).length;
  }

  function renameTag(uuid, title) {
    const tag = get(uuid);
    if (!tag || tag.content.type !== 'tag') return;
    const name = String(title || '').trim();
    if (!name) return;
    upsert(uuid, { ...tag.content, title: name });
  }

  function setTagColor(uuid, color) {
    const tag = get(uuid);
    if (!tag || tag.content.type !== 'tag') return;
    const safe = NotesSanitize.safeColor(color, '');
    if (!safe) return;
    upsert(uuid, { ...tag.content, color: safe });
  }

  function deleteTag(uuid) {
    const tag = get(uuid);
    if (!tag || tag.content.type !== 'tag') return;
    for (const note of listNotes()) {
      const tags = note.content.tags || [];
      if (!tags.includes(uuid)) continue;
      upsert(note.uuid, { ...note.content, tags: tags.filter((id) => id !== uuid) });
    }
    remove(uuid);
  }

  function mergeDuplicateTags() {
    const groups = new Map();
    for (const tag of listTags()) {
      const key = String(tag.content.title || '').trim().toLowerCase();
      if (!key) continue;
      const list = groups.get(key) || [];
      list.push(tag);
      groups.set(key, list);
    }
    let merged = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => {
        const byNotes = noteCountForTag(b.uuid) - noteCountForTag(a.uuid);
        if (byNotes) return byNotes;
        return String(a.content.created_at || '').localeCompare(String(b.content.created_at || ''));
      });
      const keep = group[0];
      for (const extra of group.slice(1)) {
        for (const note of listNotes()) {
          const ids = note.content.tags || [];
          if (!ids.includes(extra.uuid)) continue;
          upsert(note.uuid, {
            ...note.content,
            tags: [...new Set(ids.map((id) => (id === extra.uuid ? keep.uuid : id)))],
          }, { touchUpdatedAt: false });
        }
        remove(extra.uuid);
        merged += 1;
      }
    }
    return merged;
  }

  function listAttachments(noteId) {
    return [...state.items.values()].filter(
      (i) => i.content?.type === 'attachment'
        && (noteId == null || i.content?.note_id === noteId)
        && !i.deleted,
    );
  }

  function get(uuid) {
    return state.items.get(uuid);
  }

  function upsert(uuid, content, { recordRevision = false, touchUpdatedAt = true, skipDirty = false } = {}) {
    const existing = state.items.get(uuid);
    if (recordRevision && existing?.content?.type === 'note') {
      const prev = existing.content;
      const changed = prev.title !== content.title || prev.content !== content.content;
      content.revisions = [...(prev.revisions || [])];
      if (changed) {
        const now = Date.now();
        const latest = content.revisions[0];
        const latestAt = latest?.at ? new Date(latest.at).getTime() : 0;
        // Coalesce rapid edits into one history row (avoid per-keystroke revisions).
        const REVISION_GAP_MS = 60_000;
        if (latest && Number.isFinite(latestAt) && now - latestAt < REVISION_GAP_MS) {
          /* keep the existing revision snapshot from the start of this edit burst */
        } else {
          content.revisions.unshift({
            at: new Date(now).toISOString(),
            title: prev.title || '',
            content: prev.content || '',
          });
          if (content.revisions.length > MAX_REVISIONS) {
            content.revisions = content.revisions.slice(0, MAX_REVISIONS);
          }
        }
      }
    }
    if (content.type === 'note') attachLiveIds(content, uuid);
    if (touchUpdatedAt) {
      content.updated_at = new Date().toISOString();
    } else if (!content.updated_at) {
      content.updated_at = existing?.content?.updated_at
        || existing?.content?.created_at
        || new Date().toISOString();
    }
    const itemTs = touchUpdatedAt
      ? Date.now() / 1000
      : Math.max(
        Number(existing?.updated_at) || 0,
        (() => {
          const ms = Date.parse(content.updated_at);
          return Number.isFinite(ms) ? ms / 1000 : 0;
        })(),
      );
    const item = {
      uuid,
      content,
      updated_at: itemTs || Date.now() / 1000,
      deleted: false,
    };
    state.items.set(uuid, item);
    if (!skipDirty) {
      state.dirty.add(uuid);
      schedulePush();
    }
    if (content.type === 'note') updateSearchIndexFor(uuid);
    persistLocal(uuid, item);
  }

  function bytesFromB64(text) {
    const binary = atob(text || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function sealAttachmentContent(content) {
    if (!content || content.type !== 'attachment') return false;
    let changed = false;
    if (content.file_enc && content.data_b64) {
      delete content.data_b64;
      changed = true;
    }
    if (!content.file_enc && content.data_b64 && state.cryptoKey) {
      content.file_enc = await NotesCrypto.encryptBytes(state.cryptoKey, bytesFromB64(content.data_b64));
      delete content.data_b64;
      changed = true;
    }
    return changed;
  }

  async function migratePlainAttachments() {
    if (!state.cryptoKey) return;
    let dirty = false;
    for (const [uuid, item] of state.items) {
      if (item.deleted) continue;
      const changed = await sealAttachmentContent(item.content);
      if (!changed) continue;
      state.dirty.add(uuid);
      await persistLocal(uuid, item);
      const light = strippedAttachmentContent(item.content);
      if (light) item.content = light;
      dirty = true;
    }
    if (dirty) {
      /* push runs from unlock/boot sync — avoid "Waiting to sync" on every reload */
    }
  }

  function linkNoteAttachment(noteId, attId) {
    const note = get(noteId);
    if (!note || note.content?.type !== 'note') return;
    const attachments = [...new Set([...(note.content.attachments || []), attId])];
    const pending = (note.content.sn_pending_files || []).filter((item) => item.uuid !== attId);
    if (attachments.length === (note.content.attachments || []).length
      && pending.length === (note.content.sn_pending_files || []).length) return;
    upsert(noteId, { ...note.content, attachments, sn_pending_files: pending }, { touchUpdatedAt: false });
  }

  function bytesToImportFile(bytes, filename, mime) {
    return {
      name: filename || 'attachment',
      type: mime || 'application/octet-stream',
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async function importAttachment({ uuid, noteId, bytes, filename, mime, created_at } = {}) {
    if (!state.cryptoKey) throw new Error('Unlock the vault first');
    if (!noteId || !bytes || !bytes.length) return null;
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    }
    const existing = uuid ? get(uuid) : null;
    if (existing && existing.content?.type === 'attachment' && !existing.deleted) {
      linkNoteAttachment(noteId, uuid);
      return { uuid, created: false };
    }
    const contentSha256 = await attachmentContentHash(bytes);
    const duplicate = await findDuplicateAttachment({ contentSha256 });
    if (duplicate && duplicate.content?.note_id === noteId) {
      linkNoteAttachment(noteId, duplicate.uuid);
      return { uuid: duplicate.uuid, created: false };
    }
    const id = (uuid && !get(uuid)) ? uuid : newUuid();
    const fileEnc = await NotesCrypto.encryptBytes(state.cryptoKey, bytes);
    const content = defaultAttachment(
      noteId,
      bytesToImportFile(bytes, filename, mime),
      fileEnc,
      filename,
      contentSha256,
      '',
    );
    if (created_at) content.created_at = created_at;
    content.sn_file_uuid = uuid || '';
    upsert(id, content);
    const stored = get(id);
    if (!stored || !(await persistLocal(id, stored))) {
      discardItem(id);
      try { await NotesIDB.deleteItem(id); } catch (_) { /* nothing durable */ }
      throw new Error('Could not save the file on this device. Storage may be full.');
    }
    linkNoteAttachment(noteId, id);
    const live = get(id);
    const light = live && strippedAttachmentContent(live.content);
    if (light) live.content = light;
    return { uuid: id, created: true };
  }

  function attachmentIndexReady(content) {
    if (!content || content.type !== 'attachment') return false;
    const method = content.ocr_method || '';
    if (!method || method === 'pending' || method === 'failed') return false;
    if (Number(content.ocr_index || 0) !== OCR_INDEX) return false;
    if (method === 'text' || method === 'none') return true;
    return !!String(content.ocr_text || '').trim() || Array.isArray(content.ocr_boxes);
  }

  function adoptRemoteOcr(target, source) {
    target.ocr_text = source.ocr_text || '';
    target.ocr_method = source.ocr_method || '';
    target.ocr_index = source.ocr_index;
    if (Array.isArray(source.ocr_boxes)) {
      target.ocr_boxes = source.ocr_boxes;
      if (source.ocr_boxes_v) target.ocr_boxes_v = source.ocr_boxes_v;
      else delete target.ocr_boxes_v;
    }
  }

  async function addAttachment(noteId, file, { displayName, sourceSha256, ocrPending = false } = {}) {
    if (!state.cryptoKey) throw new Error('Unlock the vault first');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    const contentSha256 = await attachmentContentHash(raw);
    const sourceHash = String(sourceSha256 || '');
    const duplicate = await findDuplicateAttachment({
      contentSha256,
      sourceSha256: sourceHash,
    });
    if (duplicate) {
      throw new Error(duplicateAttachmentMessage(duplicate, file, noteId));
    }
    const fileEnc = await NotesCrypto.encryptBytes(state.cryptoKey, raw);
    const id = newUuid();
    const content = defaultAttachment(noteId, file, fileEnc, displayName, contentSha256, sourceHash);
    if (ocrPending) content.ocr_method = 'pending';
    upsert(id, content);
    const stored = get(id);
    if (!stored || !(await persistLocal(id, stored))) {
      discardItem(id);
      try { await NotesIDB.deleteItem(id); } catch (_) { /* nothing durable */ }
      throw new Error('Could not save the file on this device. Storage may be full.');
    }
    const note = get(noteId);
    if (note) {
      note.content.attachments = note.content.attachments || [];
      if (!note.content.attachments.includes(id)) {
        note.content.attachments.push(id);
      }
      const addedName = String(displayName || file.name || '').split(/[/\\]/).pop().toLowerCase();
      note.content.sn_pending_files = (note.content.sn_pending_files || []).filter((item) => {
        const pendingName = String(item.name || '').split(/[/\\]/).pop().toLowerCase();
        return pendingName && pendingName !== addedName;
      });
      upsert(noteId, note.content);
    }
    // Persisted to IndexedDB above — drop the encrypted bytes from memory.
    // Sync hydrates them from the stored row when pushing.
    const live = get(id);
    const light = live && strippedAttachmentContent(live.content);
    if (light) live.content = light;
    return id;
  }

  async function fetchAttachmentBlobFromServer(uuid) {
    const item = get(uuid);
    if (!item || item.content?.type !== 'attachment') return false;
    try {
      const data = await api('/api/sync/blobs', {
        method: 'POST',
        body: JSON.stringify({ uuids: [uuid] }),
        timeoutMs: syncRequestTimeoutMs(2_000_000),
      });
      const row = (data.blobs || []).find((entry) => entry.item_uuid === uuid);
      const blobCipher = row?.blob_ciphertext;
      if (!blobCipher) return false;
      if (typeof NotesIDB.putBlob === 'function') {
        await NotesIDB.putBlob(uuid, blobCipher);
      }
      const merged = mergeAttachmentBlob({ ...item.content }, blobCipher);
      const light = strippedAttachmentContent(merged);
      item.content = light || merged;
      state.items.set(uuid, item);
      const idbRow = await NotesIDB.getItem(uuid).catch(() => null);
      if (idbRow) {
        await NotesIDB.putItem({
          ...idbRow,
          uuid,
          has_blob: true,
        });
      }
      return true;
    } catch (err) {
      console.warn('fetch attachment blob failed', uuid, err);
      return false;
    }
  }

  async function hasLocalAttachmentBytes(uuid) {
    const item = get(uuid);
    if (!item || item.content?.type !== 'attachment') return false;
    if (item.content.file_enc || item.content.data_b64) return true;
    if (typeof NotesIDB.getBlob !== 'function') return false;
    try {
      return !!(await NotesIDB.getBlob(uuid));
    } catch (err) {
      return false;
    }
  }

  // Light vault: opening a note downloads its files so they stay available offline.
  async function ensureNoteAttachmentsLocal(noteId, { onProgress } = {}) {
    if (!state.cryptoKey || !noteId) return 0;
    const atts = listAttachments(noteId);
    let fetched = 0;
    for (const att of atts) {
      if (await hasLocalAttachmentBytes(att.uuid)) continue;
      const ok = await fetchAttachmentBlobFromServer(att.uuid);
      if (ok) {
        fetched += 1;
        try { onProgress?.(fetched, atts.length); } catch (err) { /* ignore */ }
      }
    }
    return fetched;
  }

  // Free device storage: drop downloaded attachment bytes (metadata + previews stay).
  async function purgeLocalAttachmentBytes({ keepNoteIds = [] } = {}) {
    if (typeof NotesIDB.deleteBlob !== 'function') return 0;
    const keep = new Set(keepNoteIds || []);
    let removed = 0;
    for (const [uuid, item] of state.items) {
      if (item.deleted || item.content?.type !== 'attachment') continue;
      if (keep.has(item.content.note_id)) continue;
      if (state.dirty.has(uuid)) continue;
      const hadLocal = await hasLocalAttachmentBytes(uuid);
      if (!hadLocal) continue;
      try {
        await NotesIDB.deleteBlob(uuid);
      } catch (err) {
        continue;
      }
      const light = strippedAttachmentContent(item.content) || { ...item.content, file_enc_stored: true };
      delete light.data_b64;
      item.content = light;
      removed += 1;
    }
    return removed;
  }

  // Account-wide settings travel as one encrypted vault item (type "settings").
  const SETTINGS_TYPE = 'settings';

  function settingsItem() {
    let best = null;
    for (const item of state.items.values()) {
      if (item.deleted || item.content?.type !== SETTINGS_TYPE) continue;
      if (!best || (Number(item.updated_at) || 0) > (Number(best.updated_at) || 0)) best = item;
    }
    return best;
  }

  function getGlobalSettings() {
    const item = settingsItem();
    if (!item) return null;
    return {
      uuid: item.uuid,
      prefs: item.content?.prefs && typeof item.content.prefs === 'object' ? item.content.prefs : {},
      updatedAt: Number(item.updated_at) || 0,
    };
  }

  function saveGlobalSettings(nextPrefs) {
    if (!state.cryptoKey || !nextPrefs || typeof nextPrefs !== 'object') return false;
    const existing = settingsItem();
    if (existing) {
      const same = JSON.stringify(existing.content?.prefs || {}) === JSON.stringify(nextPrefs);
      if (same) return false;
    }
    const uuid = existing?.uuid || newUuid();
    upsert(uuid, {
      type: SETTINGS_TYPE,
      prefs: { ...nextPrefs },
      created_at: existing?.content?.created_at || new Date().toISOString(),
    });
    // Retire duplicates created by devices that raced on first save.
    for (const item of [...state.items.values()]) {
      if (item.uuid === uuid || item.deleted || item.content?.type !== SETTINGS_TYPE) continue;
      remove(item.uuid);
    }
    return true;
  }

  async function cryptoKeysEqual(left, right) {
    if (!left || !right) return false;
    try {
      const extractBytes = async (k) => {
        if (!k) return null;
        if (k.raw instanceof Uint8Array) return k.raw;
        if (k instanceof Uint8Array) return k;
        if (k.buffer instanceof ArrayBuffer) return new Uint8Array(k.buffer);
        if (globalThis.CryptoKey && k instanceof CryptoKey) {
          const raw = await crypto.subtle.exportKey('raw', k);
          return new Uint8Array(raw);
        }
        return null;
      };
      const ua = await extractBytes(left);
      const ub = await extractBytes(right);
      if (!ua || !ub || ua.length === 0 || ub.length === 0 || ua.length !== ub.length) return false;
      let diff = 0;
      for (let i = 0; i < ua.length; i += 1) diff |= ua[i] ^ ub[i];
      return diff === 0;
    } catch (err) {
      return false;
    }
  }

  async function verifyVaultPassword(password) {
    if (!state.cryptoKey) return false;
    const clean = String(password || '').trim();
    if (!clean) return false;
    if (typeof NotesVaultSecrets !== 'undefined') {
      const saved = NotesVaultSecrets.getVaultPassword();
      if (saved && saved === clean) return true;
    }
    const salt = sessionStorage.getItem('notes_salt') || cachedAccount().kdf_salt;
    if (!salt) return false;
    try {
      const derived = await deriveVaultKey(clean, salt, state.kdfVersion);
      if (await cryptoKeysEqual(state.cryptoKey, derived.key || derived)) return true;
      if (state.altCryptoKey) {
        const altVersion = state.kdfVersion >= 2 ? 1 : 2;
        const altDerived = await deriveVaultKey(clean, salt, altVersion);
        const altKey = altDerived.key || altDerived;
        if (await cryptoKeysEqual(state.cryptoKey, altKey)) return true;
        if (await cryptoKeysEqual(state.altCryptoKey, altKey)) return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  async function getAttachmentBytes(uuid) {
    const item = get(uuid);
    if (!item || item.content.type !== 'attachment') return null;
    if (item.content.file_enc) {
      if (!state.cryptoKey) throw new Error('Unlock the vault first');
      return NotesCrypto.decryptBytes(state.cryptoKey, item.content.file_enc);
    }
    if (item.content.file_enc_stored) {
      if (!state.cryptoKey) throw new Error('Unlock the vault first');
      let fileEnc = await storedAttachmentFileEnc(uuid);
      if (!fileEnc) {
        const fetched = await fetchAttachmentBlobFromServer(uuid);
        if (fetched) fileEnc = await storedAttachmentFileEnc(uuid);
      }
      if (fileEnc) return NotesCrypto.decryptBytes(state.cryptoKey, fileEnc);
    }
    if (item.content.data_b64) {
      const bytes = bytesFromB64(item.content.data_b64);
      if (state.cryptoKey) {
        item.content.file_enc = await NotesCrypto.encryptBytes(state.cryptoKey, bytes);
        delete item.content.data_b64;
        upsert(uuid, item.content);
      }
      return bytes;
    }
    throw new Error('This file is not on this device yet. Stay on Wi‑Fi until sync finishes, then try Preview again.');
  }

  function ocrBoxesEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((box, index) => {
      const other = right[index] || {};
      return String(box?.text || '') === String(other.text || '')
        && Number(box?.l || 0) === Number(other.l || 0)
        && Number(box?.t || 0) === Number(other.t || 0)
        && Number(box?.w || 0) === Number(other.w || 0)
        && Number(box?.h || 0) === Number(other.h || 0)
        && Number(box?.page || 0) === Number(other.page || 0);
    });
  }

  const PREVIEW_JPEG_MAX = 96 * 1024;

  async function setAttachmentPreview(uuid, jpegBytes) {
    const item = get(uuid);
    if (!item || item.content.type !== 'attachment' || !state.cryptoKey) return false;
    const raw = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes || []);
    if (!raw.length || raw.length > PREVIEW_JPEG_MAX) return false;
    const previewEnc = await NotesCrypto.encryptBytes(state.cryptoKey, raw);
    const prev = item.content.preview_enc;
    if (prev
      && prev.iv === previewEnc.iv
      && prev.data === previewEnc.data
      && Number(prev.v) === Number(previewEnc.v)) {
      return false;
    }
    upsert(uuid, { ...item.content, preview_enc: previewEnc });
    return true;
  }

  async function getAttachmentPreviewBytes(uuid) {
    const item = get(uuid);
    if (!item?.content?.preview_enc || !state.cryptoKey) return null;
    try {
      return await NotesCrypto.decryptBytes(state.cryptoKey, item.content.preview_enc);
    } catch (err) {
      return null;
    }
  }

  async function rekeyAttachmentPreviewEnc(content, fromKey, toKey) {
    if (!content?.preview_enc) return false;
    const raw = await NotesCrypto.decryptBytes(fromKey, content.preview_enc);
    content.preview_enc = await NotesCrypto.encryptBytes(toKey, raw);
    return true;
  }

  function setAttachmentOcr(uuid, text, method, boxes) {
    const item = get(uuid);
    if (!item || item.content.type !== 'attachment') return false;
    const nextText = String(text || '');
    const nextMethod = method || '';
    const hasBoxes = arguments.length > 3;
    const nextBoxes = hasBoxes ? (Array.isArray(boxes) ? boxes.slice(0, 1500) : []) : null;
    const unchanged = String(item.content.ocr_text || '') === nextText
      && String(item.content.ocr_method || '') === nextMethod
      && Number(item.content.ocr_index || 0) === OCR_INDEX
      && (!hasBoxes || ocrBoxesEqual(item.content.ocr_boxes, nextBoxes));
    if (unchanged) return false;
    const content = { ...item.content, ocr_text: nextText, ocr_method: nextMethod };
    content.ocr_index = OCR_INDEX;
    if (hasBoxes) {
      content.ocr_boxes = nextBoxes;
      if (content.ocr_boxes.length) content.ocr_boxes_v = 2;
      else delete content.ocr_boxes_v;
    }
    if (content.file_enc) delete content.data_b64;
    upsert(uuid, content);
    const noteId = item.content.note_id;
    if (noteId) refreshNoteSearchText(noteId);
    return true;
  }

  function staleAttachmentOcr(uuid) {
    const item = get(uuid);
    if (!item || item.content.type !== 'attachment') return;
    const content = { ...item.content };
    delete content.ocr_index;
    upsert(uuid, content);
  }

  function refreshNoteSearchText(noteId) {
    const note = get(noteId);
    if (!note || note.content.type !== 'note') return;
    const atts = listAttachments(noteId);
    const ocr = atts.map((item) => item.content.ocr_text).filter(Boolean).join('\n\n');
    const names = atts.map((item) => {
      const parts = [item.content.filename, item.content.original_filename].filter(Boolean);
      return [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))].join(' ');
    }).filter(Boolean).join(' ');
    if (String(note.content.ocr_text || '') === ocr
      && String(note.content.attachment_names || '') === names) return false;
    // OCR / search-index refresh must not rewrite last-edit time or enqueue sync.
    upsert(noteId, { ...note.content, ocr_text: ocr, attachment_names: names }, {
      touchUpdatedAt: false,
      skipDirty: true,
    });
    updateSearchIndexFor(noteId);
    return true;
  }

  function restoreRevision(noteId, revision) {
    const note = get(noteId);
    if (!note) return;
    const next = { ...note.content };
    next.revisions = [...(note.content.revisions || [])];
    next.revisions.unshift({
      at: new Date().toISOString(),
      title: note.content.title || '',
      content: note.content.content || '',
    });
    next.title = revision.title;
    next.content = revision.content;
    upsert(noteId, next, { recordRevision: false });
  }

  function discardItem(uuid) {
    state.items.delete(uuid);
    state.dirty.delete(uuid);
  }

  function remove(uuid, { force = false } = {}) {
    const item = state.items.get(uuid);
    if (!item) return false;
    if (!force && item.content?.type === 'note' && (item.content.locked || item.content.prevent_edit)) {
      return false;
    }
    item.deleted = true;
    item.content = item.content || {};
    item.content.deleted = true;
    item.content.updated_at = new Date().toISOString();
    state.dirty.add(uuid);
    persistLocal(uuid, item);
    schedulePush();
    return true;
  }

  async function rekeyAttachmentFileEnc(content, fromKey, toKey) {
    if (!content || content.type !== 'attachment' || !content.file_enc) return false;
    const raw = await NotesCrypto.decryptBytes(fromKey, content.file_enc);
    content.file_enc = await NotesCrypto.encryptBytes(toKey, raw);
    delete content.data_b64;
    return true;
  }

  async function attachmentBytesWithKey(content, key) {
    if (!content?.file_enc) return null;
    return NotesCrypto.decryptBytes(key, content.file_enc);
  }

  async function repairAttachmentsWithPreviousPassword(previousPassword) {
    if (!state.cryptoKey) throw new Error('Unlock the vault first');
    const previous = String(previousPassword || '').trim();
    if (!previous) throw new Error('Enter your previous vault password');
    const salt = sessionStorage.getItem('notes_salt') || cachedAccount().kdf_salt;
    if (!salt) throw new Error('Missing vault salt');
    const derived = await NotesCrypto.deriveKey(previous, salt, { kdfVersion: state.kdfVersion });
    const oldKey = derived.key || derived;
    const newKey = state.cryptoKey;
    let repaired = 0;
    let failed = 0;
    for (const att of listAttachments()) {
      if (!att.content.file_enc && att.content.file_enc_stored) {
        const fileEnc = await storedAttachmentFileEnc(att.uuid).catch(() => null);
        if (!fileEnc) continue;
        try {
          await NotesCrypto.decryptBytes(newKey, fileEnc);
          continue; // healthy — bytes stay out of memory
        } catch (err) {
          /* needs repair — hydrate for the rekey below */
        }
        att.content.file_enc = fileEnc;
        delete att.content.file_enc_stored;
      }
      if (!att.content.file_enc) continue;
      try {
        await attachmentBytesWithKey(att.content, newKey);
        continue;
      } catch (err) {
        /* try repair */
      }
      try {
        await rekeyAttachmentFileEnc(att.content, oldKey, newKey);
        upsert(att.uuid, att.content);
        repaired += 1;
      } catch (err) {
        failed += 1;
        console.warn('attachment repair failed', att.uuid, err);
      }
    }
    if (repaired) await flush();
    return { repaired, failed };
  }

  async function migrateVaultKdfIfNeeded(password, salt) {
    if (!state.cryptoKey) return { migrated: false };
    if (state.kdfVersion >= 2) {
      await retryPendingVaultKdfUpgrade();
      return { migrated: false };
    }
    if (vaultKdfMigrationInFlight || vaultKdfMigrationComplete()) return { migrated: false };
    const serverVer = Number(state.account?.vault_kdf_version);
    if (serverVer >= 2) return { migrated: false };
    if (vaultKdfUpgradePending()) {
      await retryPendingVaultKdfUpgrade();
      return { migrated: false };
    }

    const clean = String(password || (typeof NotesVaultSecrets !== 'undefined' ? NotesVaultSecrets.getVaultPassword() : '') || '').trim();
    const vaultSalt = String(salt || sessionStorage.getItem('notes_salt') || cachedAccount().kdf_salt || '').trim();
    if (!clean || !vaultSalt) return { migrated: false };

    vaultKdfMigrationInFlight = true;
    const oldKey = state.cryptoKey;
    const snapshot = [...state.items.entries()].map(([uuid, item]) => ({
      uuid,
      item: {
        uuid: item.uuid,
        content: JSON.parse(JSON.stringify(item.content)),
        updated_at: item.updated_at,
        deleted: !!item.deleted,
      },
    }));
    for (const { uuid, item } of snapshot) {
      if (item.content?.type === 'attachment' && item.content.file_enc_stored && !item.content.file_enc) {
        const fileEnc = await storedAttachmentFileEnc(uuid);
        if (fileEnc) item.content.file_enc = fileEnc;
        delete item.content.file_enc_stored;
      }
    }
    try {
      const derived = await NotesCrypto.deriveKey(clean, vaultSalt, { kdfVersion: 2 });
      const newKey = derived.key;
      const ts = Date.now() / 1000;
      for (const { uuid, item } of snapshot) {
        if (item.content?.type === 'attachment' && item.content.file_enc) {
          await rekeyAttachmentFileEnc(item.content, oldKey, newKey);
        }
        if (item.content?.type === 'attachment' && item.content.preview_enc) {
          try {
            await rekeyAttachmentPreviewEnc(item.content, oldKey, newKey);
          } catch (err) {
            delete item.content.preview_enc;
          }
        }
        item.updated_at = Math.max(Number(item.updated_at) || 0, ts);
        state.items.set(uuid, item);
        state.dirty.add(uuid);
      }
      state.cryptoKey = newKey;
      state.kdfVersion = 2;
      for (const { uuid, item } of snapshot) {
        await persistLocal(uuid, item);
      }
      await flush();
      try {
        await api('/api/account/vault-kdf', {
          method: 'POST',
          body: JSON.stringify({ vault_kdf_version: 2 }),
        });
        persistVaultKdfServerVersion(2);
        markVaultKdfMigrationComplete();
      } catch (err) {
        try {
          localStorage.setItem('notes_vault_kdf_upgrade_pending', '1');
        } catch (ignore) {
          /* ignore */
        }
        if (!isProbablyOffline(err)) throw err;
        notifyStatus('Vault upgraded on this device · will finish sync when online');
      }
      for (const entry of state.items.values()) {
        const light = strippedAttachmentContent(entry.content);
        if (light) entry.content = light;
      }
      return { migrated: true, reencrypted: snapshot.length };
    } finally {
      vaultKdfMigrationInFlight = false;
    }
  }

  let passwordChangeInFlight = false;

  async function changePassword(currentPassword, newPassword) {
    if (!state.cryptoKey) throw new Error('Unlock the vault first');
    if (passwordChangeInFlight) throw new Error('Password change already in progress');
    const current = String(currentPassword || '').trim();
    const next = String(newPassword || '').trim();
    if (!current || !next) throw new Error('Enter both passwords');
    if (next.length < 8) throw new Error('New password must be at least 8 characters');
    if (current === next) throw new Error('Choose a different password');
    const cached = cachedAccount();
    const salt = sessionStorage.getItem('notes_salt') || cached.kdf_salt;
    if (!salt) throw new Error('Missing vault salt — connect online once');

    passwordChangeInFlight = true;
    const snapshot = [...state.items.entries()].map(([uuid, item]) => ({
      uuid,
      item: {
        uuid: item.uuid,
        content: JSON.parse(JSON.stringify(item.content)),
        updated_at: item.updated_at,
        deleted: !!item.deleted,
      },
    }));
    // Hydrate stored attachment payloads with the CURRENT key before rekeying,
    // otherwise stripped items would silently keep old-key file bytes.
    for (const { uuid, item } of snapshot) {
      if (item.content?.type === 'attachment' && item.content.file_enc_stored && !item.content.file_enc) {
        const fileEnc = await storedAttachmentFileEnc(uuid);
        if (fileEnc) item.content.file_enc = fileEnc;
        delete item.content.file_enc_stored;
      }
    }

    try {
      let loginMatchesCurrent = true;
      try {
        await api('/api/account/unlock', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } catch (err) {
        if (err?.status !== 401) throw err;
        // Vault password may differ from the server login hash (common after a
        // server-side password reset). Session auth is enough to realign.
        loginMatchesCurrent = false;
        try {
          await api('/api/account');
        } catch (sessionErr) {
          throw new Error('Sign in with the login password first, then change the vault password.');
        }
      }

      const oldKey = state.cryptoKey;
      await unlock(next, salt, { kdfVersion: state.kdfVersion });
      const newKey = state.cryptoKey;
      const ts = Date.now() / 1000;
      for (const { uuid, item } of snapshot) {
        if (item.content?.type === 'attachment' && item.content.file_enc) {
          try {
            await rekeyAttachmentFileEnc(item.content, oldKey, newKey);
          } catch (err) {
            throw new Error(`Could not re-encrypt “${item.content.filename || 'document'}”. Try Settings → Repair documents with your previous password.`);
          }
        }
        if (item.content?.type === 'attachment' && item.content.preview_enc) {
          try {
            await rekeyAttachmentPreviewEnc(item.content, oldKey, newKey);
          } catch (err) {
            /* drop broken preview — can regenerate from server */
            delete item.content.preview_enc;
          }
        }
        item.updated_at = Math.max(Number(item.updated_at) || 0, ts);
        state.items.set(uuid, item);
        state.dirty.add(uuid);
        await persistLocal(uuid, item);
      }
      await flush();
      const passwordBody = { current_password: current, new_password: next };
      if (typeof NotesSrpAuth !== 'undefined' && NotesSrpAuth.makeVerifier) {
        const srp = await NotesSrpAuth.makeVerifier(cached.email, next);
        passwordBody.srp_salt = srp.srp_salt;
        passwordBody.srp_verifier = srp.srp_verifier;
      }
      if (!loginMatchesCurrent) {
        passwordBody.align_after_vault_rekey = true;
        let accountPassword = '';
        try {
          accountPassword = String(
            (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getAccountPassword()) || ''
          ).trim();
        } catch (err) {
          accountPassword = '';
        }
        if (!accountPassword) {
          throw new Error('Sign in again with your login password, then change the vault password.');
        }
        passwordBody.account_password = accountPassword;
      }
      await api('/api/account/password', {
        method: 'POST',
        body: JSON.stringify(passwordBody),
      }).then((res) => {
        ackPasswordChanged(res?.password_changed_at);
        return res;
      });
      if (typeof NotesVaultSecrets !== 'undefined') {
        NotesVaultSecrets.setAccountPassword(next);
      }
      cacheAccount({ email: cached.email, kdf_salt: salt, csrf: csrf() });
      // Everything is re-encrypted and flushed — drop file bytes from memory again.
      for (const entry of state.items.values()) {
        const light = strippedAttachmentContent(entry.content);
        if (light) entry.content = light;
      }
      return { reencrypted: snapshot.length };
    } catch (err) {
      try {
        await unlock(current, salt);
        for (const { uuid, item } of snapshot) {
          state.items.set(uuid, item);
          state.dirty.delete(uuid);
          await persistLocal(uuid, item);
        }
      } catch (rollbackErr) {
        console.warn('password change rollback failed', rollbackErr);
      }
      throw err;
    } finally {
      passwordChangeInFlight = false;
    }
  }

  function noteHasPendingFile(note, fileId, fileName) {
    const pending = note?.content?.sn_pending_files || [];
    if (fileId && pending.some((item) => item.uuid === fileId)) return true;
    if (fileName && NotesSnImport?.matchLooseFile?.(pending, fileName)) return true;
    return false;
  }

  async function attachImportedBytes(noteId, file, bytes) {
    if (!get(noteId) || get(noteId).content?.type !== 'note') return null;
    return importAttachment({
      uuid: file.uuid,
      noteId,
      bytes,
      filename: file.name || 'attachment',
      mime: file.mime || '',
      created_at: file.created_at,
    });
  }

  async function importSnFiles(parsed) {
    const attachedIds = [];
    let attached = 0;
    let missing = 0;
    for (const file of parsed.files || []) {
      const bytes = file.data_b64 ? bytesFromB64(file.data_b64) : null;
      const noteIds = file.noteIds && file.noteIds.length
        ? file.noteIds
        : listNotes().filter((note) => noteHasPendingFile(note, file.uuid, file.name)).map((note) => note.uuid);
      if (!bytes || !bytes.length) {
        if (noteIds.length) missing += 1;
        continue;
      }
      for (const noteId of noteIds) {
        const result = await attachImportedBytes(noteId, file, bytes);
        if (result?.created) attached += 1;
        if (result?.uuid) attachedIds.push(result.uuid);
      }
    }
    for (const blob of parsed.blobs || []) {
      const bytes = blob.data_b64 ? bytesFromB64(blob.data_b64) : null;
      if (!bytes || !bytes.length) continue;
      const matches = listNotes().filter((note) => noteHasPendingFile(note, '', blob.name));
      if (!matches.length) continue;
      const note = matches[0];
      const pending = NotesSnImport.matchLooseFile(note.content.sn_pending_files, blob.name);
      const result = await attachImportedBytes(note.uuid, {
        uuid: pending?.uuid,
        name: pending?.name || blob.name,
        mime: pending?.mime || blob.mime,
      }, bytes);
      if (result?.created) attached += 1;
      if (result?.uuid) attachedIds.push(result.uuid);
    }
    missing = listNotes().reduce((sum, note) => sum + (note.content.sn_pending_files || []).length, 0);
    return { attached, missing, attachmentIds: [...new Set(attachedIds)] };
  }

  async function importLooseSnFiles(files) {
    let attached = 0;
    const attachmentIds = [];
    for (const file of files || []) {
      const bytes = file.bytes || (file.data_b64 ? bytesFromB64(file.data_b64) : null)
        || (file.arrayBuffer ? new Uint8Array(await file.arrayBuffer()) : null);
      const name = file.name || file.filename || '';
      if (!bytes || !bytes.length || !name) continue;
      const matches = listNotes().filter((note) => noteHasPendingFile(note, '', name));
      if (!matches.length) continue;
      const note = matches[0];
      const pending = NotesSnImport.matchLooseFile(note.content.sn_pending_files, name);
      const result = await attachImportedBytes(note.uuid, {
        uuid: pending?.uuid,
        name: pending?.name || name,
        mime: pending?.mime || file.type || file.mime || '',
      }, bytes);
      if (result?.created) attached += 1;
      if (result?.uuid) attachmentIds.push(result.uuid);
    }
    return {
      attached,
      missing: listNotes().reduce((sum, note) => sum + (note.content.sn_pending_files || []).length, 0),
      attachmentIds,
    };
  }

  async function importBackup(json, merge = true, { blobs } = {}) {
    if (typeof NotesSnImport !== 'undefined') {
      const parsed = NotesSnImport.parse(json, { blobs });
      if (parsed.kind === 'sn-encrypted') throw new Error(parsed.error);
      if (parsed.kind === 'sn') {
        let tags = parsed.tags;
        let notes = parsed.notes;
        if (typeof NotesSnImport.mergeTagsByTitle === 'function') {
          const remapped = NotesSnImport.mergeTagsByTitle(tags, notes, listTags());
          tags = remapped.tags;
          notes = remapped.notes;
        }
        for (const tag of tags) {
          if (!merge && state.items.has(tag.uuid)) continue;
          upsert(tag.uuid, tag.content);
        }
        for (const note of notes) {
          if (!merge && state.items.has(note.uuid)) continue;
          const existing = get(note.uuid);
          const incoming = note.content;
          const content = existing && existing.content?.type === 'note'
            ? {
              ...existing.content,
              ...incoming,
              attachments: [...new Set([
                ...(existing.content.attachments || []),
                ...(incoming.attachments || []),
              ])],
              sn_pending_files: NotesSnImport.mergePending
                ? NotesSnImport.mergePending([
                  existing.content.sn_pending_files,
                  incoming.sn_pending_files,
                ])
                : incoming.sn_pending_files || existing.content.sn_pending_files || [],
            }
            : incoming;
          upsert(note.uuid, content);
        }
        const filesResult = await importSnFiles(parsed);
        const mergedTags = mergeDuplicateTags();
        await pushDirty();
        return {
          imported: notes.length,
          tags: tags.length,
          skipped: parsed.skipped,
          mergedTags,
          files: filesResult.attached,
          filesMissing: filesResult.missing,
          attachmentIds: filesResult.attachmentIds,
        };
      }
      json = parsed.data;
    }
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    let imported = 0;
    for (const row of data.items || []) {
      if (!merge && state.items.has(row.item_uuid)) continue;
      const item = await unwrapItem(row);
      state.items.set(row.item_uuid, item);
      state.dirty.add(row.item_uuid);
      await persistLocal(row.item_uuid, item);
      const light = strippedAttachmentContent(item.content);
      if (light) item.content = light;
      imported += 1;
    }
    await pushDirty();
    return { imported, tags: 0, skipped: 0 };
  }

  async function flush() {
    clearTimeout(state.saveTimer);
    if (state.activePush) await state.activePush;
    return pushDirty();
  }

  // Cheap poll (tiny JSON, no ciphertext) so other devices' edits show up
  // within seconds instead of waiting for the periodic full incremental pull.
  async function hasRemoteChanges() {
    const persistedDirty = await loadPersistedDirtyIds();
    if (persistedDirty.length) return true;
    if (state.dirty.size) return true;
    if (!state.cryptoKey) {
      try {
        const data = await api('/api/sync/watermark', { timeoutMs: 6000 });
        const remote = Number(data?.synced_watermark) || 0;
        if (!remote) return false;
        const local = Math.max(Number(state.lastSync) || 0, readStoredLastSync());
        if (!local) return true;
        return remote > local + 0.0005;
      } catch (err) {
        return false;
      }
    }
    const data = await api('/api/sync/watermark', { timeoutMs: 6000 });
    const remote = Number(data?.synced_watermark) || 0;
    if (!remote) return false;
    const local = Math.max(Number(state.lastSync) || 0, readStoredLastSync());
    if (!local) return true;
    return remote > local + 0.0005;
  }

  const onOnline = typeof window !== 'undefined' ? window.addEventListener : null;
  if (typeof onOnline === 'function') {
    onOnline.call(window, 'online', () => {
      if (!state.cryptoKey) {
        syncWhileLocked({ quiet: true }).catch(() => {});
        return;
      }
      pushDirty()
        .then((ok) => (ok ? sync() : false))
        .catch(() => {});
    });
  }

  return {
    csrf,
    deviceId,
    setCsrf,
    setSaveStatusCallback,
    setSyncStatusCallback,
    setUnlockProgressCallback,
    setNoteIngestedCallback,
    setVaultPullCallbacks,
    emitSync,
    logSync,
    syncLogEntries,
    formatSyncLog,
    api,
    setSessionRevokedHandler,
    unlock,
    isUnlocked,
    lock,
    newUuid,
    defaultNote,
    defaultTag,
    loadAccount,
    cacheAccount,
    cachedAccount,
    isProbablyOffline,
    loadLocal,
    finishLoadLocal,
    finishUnlockMaintenance,
    clearUnreadableLocal,
    clearDeviceData,
    localCipherCount,
    syncSince,
    needsSyncOnOpen,
    sync,
    pushDirty,
    pushDirtyPersisted,
    pullCipherWhileLocked,
    syncWhileLocked,
    loadPersistedDirtyIds,
    flush,
    hasRemoteChanges,
    restoreDirtyQueue,
    rememberLastSync,
    hasKey: isUnlocked,
    listNotes,
    countTotpItems,
    listTotpAccounts,
    addTotpAccount,
    removeTotpAccount,
    dedupeTotpAccounts,
    listTags,
    noteCountForTag,
    renameTag,
    setTagColor,
    deleteTag,
    mergeDuplicateTags,
    listAttachments,
    findDuplicateAttachment,
    describeDuplicateAttachment,
    formatDuplicateUploadMessage: duplicateAttachmentMessage,
    get,
    upsert,
    addAttachment,
    getAttachmentBytes,
    setAttachmentOcr,
    staleAttachmentOcr,
    OCR_INDEX,
    refreshNoteSearchText,
    restoreRevision,
    remove,
    importBackup,
    importLooseSnFiles,
    importAttachment,
    setAttachmentOcr,
    setAttachmentPreview,
    getAttachmentPreviewBytes,
    migrateVaultKdfIfNeeded,
    changePassword,
    repairAttachmentsWithPreviousPassword,
    mergeCrossDeviceProtection,
    verifyVaultPassword,
    fetchAttachmentBlobFromServer,
    hasLocalAttachmentBytes,
    ensureNoteAttachmentsLocal,
    purgeLocalAttachmentBytes,
    setLightVault,
    lightVaultEnabled,
    getGlobalSettings,
    saveGlobalSettings,
    ackPasswordChanged,
    remotePasswordChanged,
    prepareForRemotePasswordRotation,
    abandonLocalForPasswordRotation,
    passwordChangeInFlight: () => passwordChangeInFlight,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    state,
  };
})();
if (typeof window !== 'undefined') window.NotesStore = NotesStore;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesStore;
