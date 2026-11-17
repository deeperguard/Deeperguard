const NotesCrypto = (() => {
  const VAULT_KDF_V1 = 1;
  const VAULT_KDF_V2 = 2;
  const ARGON2_PARAMS = { t: 3, m: 65536, p: 2, dkLen: 32 };

  function b64(bytes) {
    let binary = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  }

  function fromB64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function noble() {
    const lib = globalThis.NobleCrypto;
    if (!lib || !lib.gcm || !lib.sha256) {
      throw new Error('Encryption library failed to load. Refresh the page.');
    }
    return lib;
  }

  function argon2() {
    const lib = globalThis.NobleArgon2;
    if (!lib || !lib.argon2idAsync) {
      throw new Error('Argon2 library failed to load. Refresh the page.');
    }
    return lib;
  }

  function isRawKey(key) {
    return key && key.raw instanceof Uint8Array;
  }

  function alignBytes(bytes) {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
  }

  function decodeSaltBytes(salt) {
    const text = String(salt || '').trim();
    if (!text) {
      const empty = new Uint8Array(8);
      return empty;
    }
    try {
      const decoded = fromB64(text);
      if (decoded.length >= 8) return alignBytes(decoded);
    } catch (err) {
      /* fall through to UTF-8 salt */
    }
    const encoded = new TextEncoder().encode(text);
    if (encoded.length >= 8) return alignBytes(encoded);
    const padded = new Uint8Array(8);
    padded.set(encoded);
    return padded;
  }

  function deriveRawV1(password, salt) {
    const enc = new TextEncoder();
    const a = enc.encode(String(password || ''));
    const b = enc.encode(String(salt || ''));
    const merged = new Uint8Array(a.length + 1 + b.length);
    merged.set(a, 0);
    merged[a.length] = 0;
    merged.set(b, a.length + 1);
    return alignBytes(noble().sha256(merged));
  }

  async function deriveRawV2(password, salt) {
    const pwd = new TextEncoder().encode(String(password || ''));
    const saltBytes = decodeSaltBytes(salt);
    const raw = await argon2().argon2idAsync(pwd, saltBytes, ARGON2_PARAMS);
    return alignBytes(raw);
  }

  function normalizeKdfVersion(value) {
    const version = Number(value);
    if (version === VAULT_KDF_V2) return VAULT_KDF_V2;
    return VAULT_KDF_V1;
  }

  async function deriveKey(password, salt, options = {}) {
    const version = normalizeKdfVersion(options.version || options.kdfVersion);
    if (version === VAULT_KDF_V2) {
      return {
        key: { raw: await deriveRawV2(password, salt) },
        encoding: 'argon2id',
        version: VAULT_KDF_V2,
      };
    }
    return {
      key: { raw: deriveRawV1(password, salt) },
      encoding: 'sha256',
      version: VAULT_KDF_V1,
    };
  }

  function randomIv() {
    const iv = new Uint8Array(12);
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('Secure random is unavailable in this browser');
    }
    globalThis.crypto.getRandomValues(iv);
    return iv;
  }

  async function encryptObject(key, obj) {
    const iv = randomIv();
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const cipher = noble().gcm(alignBytes(raw), iv).encrypt(plaintext);
    return { v: 1, iv: b64(iv), data: b64(cipher) };
  }

  async function decryptObject(key, payload) {
    const iv = fromB64(payload.iv);
    const data = fromB64(payload.data);
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const plain = noble().gcm(alignBytes(raw), iv).decrypt(data);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function aadBytes(aad) {
    return aad == null ? null : (aad instanceof Uint8Array ? aad : new TextEncoder().encode(String(aad)));
  }

  // Optional `aad` binds the ciphertext to a context (payload v: 2). Without it
  // the payload stays v: 1 and decrypts exactly as before.
  async function encryptBytes(key, bytes, { aad } = {}) {
    const iv = randomIv();
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const plain = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const ad = aadBytes(aad);
    const cipher = ad
      ? noble().gcm(alignBytes(raw), iv, ad).encrypt(alignBytes(plain))
      : noble().gcm(alignBytes(raw), iv).encrypt(alignBytes(plain));
    return { v: ad ? 2 : 1, iv: b64(iv), data: b64(cipher) };
  }

  async function decryptBytes(key, payload, { aad } = {}) {
    if (!payload || !payload.iv || !payload.data) throw new Error('Missing encrypted file');
    const iv = fromB64(payload.iv);
    const data = fromB64(payload.data);
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const ad = aadBytes(aad);
    if (Number(payload.v) === 2 && !ad) throw new Error('Missing authenticated context');
    return ad
      ? noble().gcm(alignBytes(raw), iv, ad).decrypt(data)
      : noble().gcm(alignBytes(raw), iv).decrypt(data);
  }

  // HMAC-SHA256 built on the library sha256 (RFC 2104), for deterministic ids.
  function hmacSha256(keyBytes, msgBytes) {
    const { sha256 } = noble();
    let k = alignBytes(keyBytes);
    if (k.length > 64) k = sha256(k);
    const ipad = new Uint8Array(64 + msgBytes.length);
    const opad = new Uint8Array(96);
    for (let i = 0; i < 64; i += 1) {
      const b = i < k.length ? k[i] : 0;
      ipad[i] = b ^ 0x36;
      opad[i] = b ^ 0x5c;
    }
    ipad.set(msgBytes, 64);
    opad.set(sha256(ipad), 64);
    return sha256(opad);
  }

  async function hashText(text) {
    return b64(noble().sha256(new TextEncoder().encode(text))).slice(0, 16);
  }

  async function hashBytes(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const hash = noble().sha256(alignBytes(arr));
    return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- Recovery key and vault key wrapping (docs/VAULT_RECOVERY.md 1.2, 1.3) ----
  const WRAP_VERSION = 1;
  const RECOVERY_KEY_BYTES = 20; // 160 bits
  const RECOVERY_SALT_BYTES = 16;
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const WRAP_TYPES = ['recovery', 'prf', 'pending-rekey'];

  function randomBytes(n) {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('Secure random is unavailable in this browser');
    }
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  }

  function generateRecoveryKey() {
    return randomBytes(RECOVERY_KEY_BYTES);
  }

  function generateRecoverySalt() {
    return randomBytes(RECOVERY_SALT_BYTES);
  }

  // RFC 5869 HKDF-SHA256. An empty salt means 32 zero bytes (same HMAC key).
  function hkdfSha256(ikm, salt, info, length) {
    const hashLen = 32;
    if (!(length > 0) || length > 255 * hashLen) throw new Error('Invalid HKDF length');
    const infoBytes = info instanceof Uint8Array ? info : new TextEncoder().encode(String(info || ''));
    const prk = hmacSha256(salt && salt.length ? salt : new Uint8Array(hashLen), alignBytes(ikm));
    const out = new Uint8Array(length);
    let prev = new Uint8Array(0);
    for (let i = 1, pos = 0; pos < length; i += 1) {
      const msg = new Uint8Array(prev.length + infoBytes.length + 1);
      msg.set(prev, 0);
      msg.set(infoBytes, prev.length);
      msg[msg.length - 1] = i;
      prev = hmacSha256(prk, msg);
      const take = Math.min(hashLen, length - pos);
      out.set(prev.subarray(0, take), pos);
      pos += take;
    }
    return out;
  }

  function base32Encode(bytes) {
    let bits = 0;
    let acc = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      acc = (acc << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += B32[(acc >>> (bits - 5)) & 31];
        bits -= 5;
      }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
    return out;
  }

  function recoveryCheck(bytes) {
    const label = new TextEncoder().encode('deeperguard/recovery/check/v1');
    const msg = new Uint8Array(label.length + bytes.length);
    msg.set(label, 0);
    msg.set(bytes, label.length);
    const h = noble().sha256(msg);
    return B32[h[0] >> 3] + B32[((h[0] & 7) << 2) | (h[1] >> 6)];
  }

  // 32 Crockford base32 characters in 8 groups of 4, plus a 2-character check group.
  function encodeRecoveryKey(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== RECOVERY_KEY_BYTES) {
      throw new Error('Invalid recovery key');
    }
    const text = base32Encode(bytes);
    const groups = [];
    for (let i = 0; i < text.length; i += 4) groups.push(text.slice(i, i + 4));
    groups.push(recoveryCheck(bytes));
    return groups.join('-');
  }

  // Throws on a wrong length, a character outside the alphabet or a failed check.
  function decodeRecoveryKey(text) {
    const clean = String(text || '').toUpperCase().replace(/[\s-]+/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1');
    if (clean.length !== 34) throw new Error('Recovery key has the wrong length');
    const bytes = new Uint8Array(RECOVERY_KEY_BYTES);
    let bits = 0;
    let acc = 0;
    let pos = 0;
    for (let i = 0; i < 32; i += 1) {
      const v = B32.indexOf(clean[i]);
      if (v < 0) throw new Error('Recovery key contains an invalid character');
      acc = (acc << 5) | v;
      bits += 5;
      if (bits >= 8) {
        bytes[pos] = (acc >>> (bits - 8)) & 255;
        pos += 1;
        bits -= 8;
        acc &= (1 << bits) - 1;
      }
    }
    if (recoveryCheck(bytes) !== clean.slice(32)) throw new Error('Recovery key check failed');
    return bytes;
  }

  function deriveRecoveryWrapKey(recoveryKey, recoverySalt) {
    if (!(recoveryKey instanceof Uint8Array) || recoveryKey.length < 16) {
      throw new Error('Invalid recovery key');
    }
    if (!(recoverySalt instanceof Uint8Array) || !recoverySalt.length) {
      throw new Error('Missing recovery salt');
    }
    return { raw: hkdfSha256(recoveryKey, recoverySalt, 'deeperguard/recovery/v1', 32) };
  }

  function vaultKeyId(vaultKey) {
    const raw = isRawKey(vaultKey) ? vaultKey.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const id = hkdfSha256(raw, null, 'deeperguard/keyid/v1', 16);
    return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function wrapAad({ accountId, type, keyId, binding }) {
    if (!WRAP_TYPES.includes(type)) throw new Error('Unknown wrap type');
    const fields = [String(accountId == null ? '' : accountId), type, String(keyId || ''), String(binding || '')];
    if (!fields[0] || !fields[2]) throw new Error('Missing wrap context');
    if (fields.some((f) => f.includes('|'))) throw new Error('Invalid wrap context');
    return new TextEncoder().encode(`deeperguard|vault-wrap|v1|${fields.join('|')}`);
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function unwrapVaultKey(wrapKey, wrap, { accountId, type, binding } = {}) {
    if (!wrap || Number(wrap.wrap_version) !== WRAP_VERSION) throw new Error('Unsupported wrap version');
    const aad = wrapAad({ accountId, type, keyId: wrap.key_id, binding });
    const raw = alignBytes(await decryptBytes(wrapKey, wrap.blob, { aad }));
    if (raw.length !== 32) throw new Error('Unwrapped key has the wrong length');
    const key = { raw };
    if (vaultKeyId(key) !== wrap.key_id) throw new Error('Wrap belongs to a different vault key');
    return key;
  }

  // Wraps the vault key and immediately unwraps the result to compare it with the
  // original; a wrap that does not round-trip is never returned.
  async function wrapVaultKey(vaultKey, wrapKey, { accountId, type, binding } = {}) {
    const raw = isRawKey(vaultKey) ? vaultKey.raw : null;
    if (!raw || raw.length !== 32) throw new Error('Missing encryption key');
    const keyId = vaultKeyId(vaultKey);
    const aad = wrapAad({ accountId, type, keyId, binding });
    const blob = await encryptBytes(wrapKey, raw, { aad });
    const wrap = { wrap_version: WRAP_VERSION, key_id: keyId, blob };
    const check = await unwrapVaultKey(wrapKey, wrap, { accountId, type, binding });
    if (!sameBytes(check.raw, raw)) throw new Error('Wrap verification failed');
    return wrap;
  }

  const WORKER_TIMEOUT_MS = 90000;
  let workerTimeoutMs = WORKER_TIMEOUT_MS;
  let workerRef = null;
  let workerMsgId = 0;
  const workerWaiters = new Map();

  function workerEnabled() {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined';
  }

  function workerUrl() {
    const hashed = document.querySelector('meta[name="notes-crypto-worker"]')?.getAttribute('content') || '';
    if (hashed) return hashed;
    const build = document.querySelector('meta[name="notes-build"]')?.getAttribute('content') || '';
    return `/static/js/crypto-worker.js${build ? `?v=${build}` : ''}`;
  }

  function getWorker() {
    if (!workerEnabled()) return null;
    if (!workerRef) {
      workerRef = new Worker(workerUrl());
      workerRef.onmessage = (event) => {
        const { id, ok, result, content, error, progress } = event.data || {};
        if (progress != null && !result && !error) {
          if (typeof globalThis.__notesKdfProgress === 'function') {
            globalThis.__notesKdfProgress(progress);
          }
          return;
        }
        const waiter = workerWaiters.get(id);
        if (!waiter) return;
        workerWaiters.delete(id);
        if (ok) waiter.resolve(result || content);
        else waiter.reject(new Error(error || 'crypto worker failed'));
      };
      workerRef.onerror = () => {
        workerWaiters.forEach((waiter) => waiter.reject(new Error('crypto worker crashed')));
        workerWaiters.clear();
        workerRef = null;
      };
    }
    return workerRef;
  }

  function workerCall(type, payload) {
    const worker = getWorker();
    if (!worker) return Promise.reject(new Error('crypto worker unavailable'));
    const id = ++workerMsgId;
    return new Promise((resolve, reject) => {
      // Watchdog: a worker that is killed or frozen never answers; without a
      // deadline the unlock button would stay on "Checking…" forever.
      const timer = setTimeout(() => {
        if (!workerWaiters.has(id)) return;
        workerWaiters.delete(id);
        terminateWorker();
        reject(new Error('crypto worker timed out'));
      }, workerTimeoutMs);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      workerWaiters.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        worker.postMessage({ id, type, ...payload });
      } catch (err) {
        workerWaiters.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function setWorkerTimeoutMs(ms) {
    workerTimeoutMs = Number(ms) > 0 ? Number(ms) : WORKER_TIMEOUT_MS;
  }

  async function deriveKeyInWorker(password, salt, options = {}) {
    const version = normalizeKdfVersion(options.version || options.kdfVersion);
    const result = await workerCall('deriveKey', {
      password: String(password || ''),
      salt: String(salt || ''),
      kdfVersion: version,
    });
    return {
      key: { raw: fromB64(result.raw) },
      encoding: result.encoding,
      version: result.version,
    };
  }

  async function decryptObjectInWorker(key, payload) {
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    return workerCall('decrypt', {
      rawKey: b64(raw),
      payload,
    });
  }

  function terminateWorker() {
    if (!workerRef) return;
    try {
      workerRef.terminate();
    } catch (err) {
      /* ignore */
    }
    workerRef = null;
    workerWaiters.forEach((waiter) => waiter.reject(new Error('crypto worker terminated')));
    workerWaiters.clear();
  }

  return {
    deriveKey,
    deriveKeyInWorker,
    decryptObjectInWorker,
    workerEnabled,
    terminateWorker,
    setWorkerTimeoutMs,
    encryptObject,
    decryptObject,
    encryptBytes,
    decryptBytes,
    hashText,
    hashBytes,
    hmacSha256,
    hkdfSha256,
    generateRecoveryKey,
    generateRecoverySalt,
    encodeRecoveryKey,
    decodeRecoveryKey,
    deriveRecoveryWrapKey,
    vaultKeyId,
    wrapVaultKey,
    unwrapVaultKey,
    RECOVERY_KEY_BYTES,
    WRAP_VERSION,
    VAULT_KDF_V1,
    VAULT_KDF_V2,
    ARGON2_PARAMS,
  };
})();
if (typeof window !== 'undefined') window.NotesCrypto = NotesCrypto;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesCrypto;
