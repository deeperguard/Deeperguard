/*
 * Encrypted, synced user settings (see docs/SETTINGS_SPEC.md).
 * One vault item { type: 'ui_settings', blob } travels through the normal
 * encrypted item sync. The blob is AES-256-GCM (vault key, fresh IV, AAD) over
 * a length-prefixed record zero-padded to a fixed size. Only allowlisted keys
 * are read or written; nothing is kept in localStorage/sessionStorage/cookies.
 */
const NotesSettingsSync = (() => {
  const ITEM_TYPE = 'ui_settings';
  const SCHEMA_V = 1;
  const PAD_BLOCK = 1024;
  const DEBOUNCE_MS = 1000;
  const MAX_FUTURE_MS = 5 * 60 * 1000;

  const bool = (v) => v === true || v === false;
  const oneOf = (list) => (v) => typeof v === 'string' && list.includes(v);
  const intOneOf = (list) => (v) => Number.isInteger(v) && list.includes(v);

  const SETTINGS_ALLOWLIST = Object.freeze({
    theme: { check: oneOf(['light', 'dark', 'system']), def: 'light' },
    fontSize: { check: (v) => Number.isInteger(v) && v >= 13 && v <= 22, def: 16 },
    monospace: { check: bool, def: false },
    spellcheck: { check: bool, def: true },
    hidePreviews: { check: bool, def: false },
    compactList: { check: bool, def: true },
    sort: { check: oneOf(['updated', 'created', 'title']), def: 'updated' },
    autoPreview: { check: bool, def: false },
    autoOpenPdfOnly: { check: bool, def: true },
    autoLockMin: { check: intOneOf([0, 1, 5, 15, 30, 60]), def: 15 },
    lockOnUnfocus: { check: oneOf(['never', 'immediate', '1min']), def: '1min' },
    navPinned: { check: bool, def: false },
    agendaView: { check: oneOf(['day', '3day', 'week', 'month', 'agenda']), def: null },
  });

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isAllowed = (key) => hasOwn(SETTINGS_ALLOWLIST, key);
  const isValid = (key, value) => isAllowed(key) && SETTINGS_ALLOWLIST[key].check(value);

  // ---- padding -------------------------------------------------------------
  function paddedLength(bodyLen) {
    return Math.ceil((4 + bodyLen) / PAD_BLOCK) * PAD_BLOCK;
  }

  function padRecord(text) {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(paddedLength(body.length));
    new DataView(out.buffer).setUint32(0, body.length, false);
    out.set(body, 4);
    return out;
  }

  function unpadRecord(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < PAD_BLOCK || bytes.length % PAD_BLOCK) {
      throw new Error('bad padding');
    }
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    if (len > bytes.length - 4 || paddedLength(len) !== bytes.length) throw new Error('bad padding');
    return new TextDecoder().decode(bytes.subarray(4, 4 + len));
  }

  // ---- record (plaintext) --------------------------------------------------
  // Keeps only valid allowlisted entries; clamps timestamps from the future.
  function sanitizeKeys(keys, now) {
    const out = {};
    if (!keys || typeof keys !== 'object') return out;
    for (const key of Object.keys(keys)) {
      if (!isAllowed(key)) continue;
      const entry = keys[key];
      if (!entry || typeof entry !== 'object' || !isValid(key, entry.value)) continue;
      let at = entry.updatedAt;
      if (!Number.isInteger(at) || at < 0) continue;
      if (at > now + MAX_FUTURE_MS) at = now;
      out[key] = { value: entry.value, updatedAt: at };
    }
    return out;
  }

  // Per-key last-writer-wins; tie -> larger JSON of value, so merge commutes.
  function mergeKeys(a, b) {
    const out = { ...a };
    for (const key of Object.keys(b)) {
      const mine = out[key];
      const theirs = b[key];
      if (!mine || theirs.updatedAt > mine.updatedAt
        || (theirs.updatedAt === mine.updatedAt
          && JSON.stringify(theirs.value) > JSON.stringify(mine.value))) {
        out[key] = theirs;
      }
    }
    return out;
  }

  function serialize(keys) {
    const clean = {};
    for (const key of Object.keys(keys).sort()) {
      if (isValid(key, keys[key].value)) {
        clean[key] = { value: keys[key].value, updatedAt: keys[key].updatedAt };
      }
    }
    return JSON.stringify({ v: SCHEMA_V, keys: clean });
  }

  // Throws on malformed input; returns { newer: true } for a newer schema.
  function parseRecord(text, now) {
    const rec = JSON.parse(text);
    if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.v)) throw new Error('bad record');
    if (rec.v > SCHEMA_V) return { newer: true, keys: {} };
    return { newer: false, keys: sanitizeKeys(rec.keys, now) };
  }

  // ---- instance ------------------------------------------------------------
  function create(deps) {
    const {
      store,
      crypto: cry,
      getKey,
      getUserId = () => '',
      now = () => Date.now(),
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (t) => clearTimeout(t),
      onNotice = () => {},
    } = deps;

    let keys = {};
    let lastSaved = null;
    let timer = null;
    let loaded = false;
    let writeBlocked = false; // decrypt failed: no overwrite until the user changes something
    let newerSchema = false; // record from a newer client: never write
    let dirtyByUser = false;

    const aad = () => `dg:settings:v1|${getUserId()}`;

    function itemUuid() {
      const mac = cry.hmacSha256(getKey().raw, new TextEncoder().encode('dg:settings:v1:uuid'));
      const h = Array.from(mac.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    function getSetting(key) {
      if (!isAllowed(key)) return undefined;
      if (loaded && hasOwn(keys, key)) return keys[key].value;
      return SETTINGS_ALLOWLIST[key].def;
    }

    function hasSetting(key) {
      return loaded && isAllowed(key) && hasOwn(keys, key);
    }

    // Call after unlock, and again after a sync pull (merges per key).
    async function load() {
      if (!store.isUnlocked()) return false; // nothing is read before unlock
      const item = store.get(itemUuid());
      const blob = item && !item.deleted ? item.content?.blob : null;
      if (blob) {
        try {
          const plain = await cry.decryptBytes(getKey(), blob, { aad: aad() });
          const rec = parseRecord(unpadRecord(plain), now());
          if (rec.newer) {
            newerSchema = true;
          } else {
            keys = mergeKeys(keys, rec.keys);
            writeBlocked = false;
            lastSaved = serialize(keys);
          }
        } catch (err) {
          writeBlocked = true;
          onNotice('Settings could not be read; using defaults.');
        }
      }
      loaded = true;
      return true;
    }

    async function save() {
      timer = null;
      if (!store.isUnlocked() || newerSchema) return false;
      if (writeBlocked && !dirtyByUser) return false;
      const plain = serialize(keys);
      if (plain === lastSaved) return false;
      const blob = await cry.encryptBytes(getKey(), padRecord(plain), { aad: aad() });
      store.upsert(itemUuid(), { type: ITEM_TYPE, blob });
      lastSaved = plain;
      writeBlocked = false;
      return true;
    }

    function setSetting(key, value) {
      if (!loaded || !isValid(key, value)) return false;
      keys[key] = { value, updatedAt: now() };
      dirtyByUser = true;
      if (timer != null) clearTimer(timer);
      timer = setTimer(() => { save().catch(() => {}); }, DEBOUNCE_MS);
      return true;
    }

    async function flush() {
      if (timer == null) return false;
      clearTimer(timer);
      return save();
    }

    // Call before store.lock(): flush, then drop everything from memory.
    async function lock() {
      try {
        await flush();
      } finally {
        if (timer != null) clearTimer(timer);
        timer = null;
        keys = {};
        lastSaved = null;
        loaded = false;
        writeBlocked = false;
        newerSchema = false;
        dirtyByUser = false;
      }
    }

    return { getSetting, hasSetting, setSetting, load, flush, lock, itemUuid };
  }

  return {
    ITEM_TYPE, SETTINGS_ALLOWLIST, PAD_BLOCK, DEBOUNCE_MS,
    isValid, padRecord, unpadRecord, sanitizeKeys, mergeKeys, serialize, parseRecord, create,
  };
})();
if (typeof window !== 'undefined') window.NotesSettingsSync = NotesSettingsSync;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSettingsSync;
