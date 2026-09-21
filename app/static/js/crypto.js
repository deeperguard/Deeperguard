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
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(iv);
      return iv;
    }
    for (let i = 0; i < iv.length; i += 1) iv[i] = Math.floor(Math.random() * 256);
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

  async function encryptBytes(key, bytes) {
    const iv = randomIv();
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    const plain = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const cipher = noble().gcm(alignBytes(raw), iv).encrypt(alignBytes(plain));
    return { v: 1, iv: b64(iv), data: b64(cipher) };
  }

  async function decryptBytes(key, payload) {
    if (!payload || !payload.iv || !payload.data) throw new Error('Missing encrypted file');
    const iv = fromB64(payload.iv);
    const data = fromB64(payload.data);
    const raw = isRawKey(key) ? key.raw : null;
    if (!raw) throw new Error('Missing encryption key');
    return noble().gcm(alignBytes(raw), iv).decrypt(data);
  }

  async function hashText(text) {
    return b64(noble().sha256(new TextEncoder().encode(text))).slice(0, 16);
  }

  async function hashBytes(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const hash = noble().sha256(alignBytes(arr));
    return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  let workerRef = null;
  let workerMsgId = 0;
  const workerWaiters = new Map();

  function workerEnabled() {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined';
  }

  function workerUrl() {
    const build = document.querySelector('meta[name="notes-build"]')?.getAttribute('content') || '';
    return `/static/js/crypto-worker.js${build ? `?v=${build}` : ''}`;
  }

  function getWorker() {
    if (!workerEnabled()) return null;
    if (!workerRef) {
      workerRef = new Worker(workerUrl());
      workerRef.onmessage = (event) => {
        const { id, ok, result, content, error } = event.data || {};
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
      workerWaiters.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
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
    encryptObject,
    decryptObject,
    encryptBytes,
    decryptBytes,
    hashText,
    hashBytes,
    VAULT_KDF_V1,
    VAULT_KDF_V2,
    ARGON2_PARAMS,
  };
})();
if (typeof window !== 'undefined') window.NotesCrypto = NotesCrypto;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesCrypto;
