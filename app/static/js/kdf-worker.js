/*
 * Decrypts encrypted Aegis and 2FAS exports off the main thread (docs/2FA_IMPORT_SPEC.md 3.2, 3.3).
 * Served with its own CSP (default-src 'none'), so it is self-contained: no importScripts, no network.
 * Message in:  {id, format: 'aegis'|'2fas', password: Uint8Array, data}  (password buffer is zeroed here)
 * Message out: {id, ok: true, text} or {id, ok: false, code}. Codes only, never input, keys or messages.
 * scrypt: there is no scrypt in WebCrypto and no vendored one in this repo, so a small, bounded
 * implementation of RFC 7914 lives here, checked against the RFC vectors in tests/test_totp_kdf.js.
 */
'use strict';

const KDF_LIMITS = {
  scryptMinN: 1 << 10, scryptMaxN: 1 << 20, scryptMaxR: 16, scryptMaxP: 4, scryptMaxBytes: 256 * 1024 * 1024,
  pbkdf2Min: 1000, pbkdf2Max: 2000000, saltMin: 8, saltMax: 512, maxSlots: 16,
};

const kdfSubtle = () => (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : require('crypto').webcrypto.subtle;

class KdfError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function hexBytes(value, min, max) {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-fA-F]*$/.test(value)) throw new KdfError('invalid');
  const n = value.length / 2;
  if (n < min || n > max) throw new KdfError('invalid');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = parseInt(value.substr(i * 2, 2), 16);
  return out;
}

function b64Bytes(value, min, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > max * 2) throw new KdfError('invalid');
  let bin;
  try { bin = atob(value); } catch (e) { throw new KdfError('invalid'); }
  if (bin.length < min || bin.length > max) throw new KdfError('invalid');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---- scrypt (RFC 7914) ----
function salsa20_8(B) {
  const x = new Uint32Array(B);
  const R = (a, b) => ((a << b) | (a >>> (32 - b)));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R((x[0] + x[12]) | 0, 7); x[8] ^= R((x[4] + x[0]) | 0, 9);
    x[12] ^= R((x[8] + x[4]) | 0, 13); x[0] ^= R((x[12] + x[8]) | 0, 18);
    x[9] ^= R((x[5] + x[1]) | 0, 7); x[13] ^= R((x[9] + x[5]) | 0, 9);
    x[1] ^= R((x[13] + x[9]) | 0, 13); x[5] ^= R((x[1] + x[13]) | 0, 18);
    x[14] ^= R((x[10] + x[6]) | 0, 7); x[2] ^= R((x[14] + x[10]) | 0, 9);
    x[6] ^= R((x[2] + x[14]) | 0, 13); x[10] ^= R((x[6] + x[2]) | 0, 18);
    x[3] ^= R((x[15] + x[11]) | 0, 7); x[7] ^= R((x[3] + x[15]) | 0, 9);
    x[11] ^= R((x[7] + x[3]) | 0, 13); x[15] ^= R((x[11] + x[7]) | 0, 18);
    x[1] ^= R((x[0] + x[3]) | 0, 7); x[2] ^= R((x[1] + x[0]) | 0, 9);
    x[3] ^= R((x[2] + x[1]) | 0, 13); x[0] ^= R((x[3] + x[2]) | 0, 18);
    x[6] ^= R((x[5] + x[4]) | 0, 7); x[7] ^= R((x[6] + x[5]) | 0, 9);
    x[4] ^= R((x[7] + x[6]) | 0, 13); x[5] ^= R((x[4] + x[7]) | 0, 18);
    x[11] ^= R((x[10] + x[9]) | 0, 7); x[8] ^= R((x[11] + x[10]) | 0, 9);
    x[9] ^= R((x[8] + x[11]) | 0, 13); x[10] ^= R((x[9] + x[8]) | 0, 18);
    x[12] ^= R((x[15] + x[14]) | 0, 7); x[13] ^= R((x[12] + x[15]) | 0, 9);
    x[14] ^= R((x[13] + x[12]) | 0, 13); x[15] ^= R((x[14] + x[13]) | 0, 18);
  }
  for (let i = 0; i < 16; i += 1) B[i] = (B[i] + x[i]) | 0;
}

function blockMix(B, Y, r) {
  const X = B.slice((2 * r - 1) * 16, 2 * r * 16);
  for (let i = 0; i < 2 * r; i += 1) {
    for (let k = 0; k < 16; k += 1) X[k] ^= B[i * 16 + k];
    salsa20_8(X);
    Y.set(X, ((i & 1) ? r + (i >> 1) : (i >> 1)) * 16);
  }
  B.set(Y);
  X.fill(0);
}

function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const s = kdfSubtle();
  return s.importKey('raw', password, 'PBKDF2', false, ['deriveBits'])
    .then((key) => s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, dkLen * 8))
    .then((bits) => new Uint8Array(bits));
}

function scryptLimitsOk(n, r, p) {
  return Number.isSafeInteger(n) && Number.isSafeInteger(r) && Number.isSafeInteger(p)
    && n >= KDF_LIMITS.scryptMinN && n <= KDF_LIMITS.scryptMaxN && (n & (n - 1)) === 0
    && r >= 1 && r <= KDF_LIMITS.scryptMaxR && p >= 1 && p <= KDF_LIMITS.scryptMaxP
    && 128 * n * r * p <= KDF_LIMITS.scryptMaxBytes;
}

async function scrypt(password, salt, n, r, p, dkLen) {
  if (!scryptLimitsOk(n, r, p)) throw new KdfError('kdf_limit');
  const blockWords = 32 * r;
  const b = await pbkdf2Sha256(password, salt, 1, p * 128 * r);
  const words = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); // little-endian hosts
  const V = new Uint32Array(blockWords * n);
  const Y = new Uint32Array(blockWords);
  for (let c = 0; c < p; c += 1) {
    const X = words.subarray(c * blockWords, (c + 1) * blockWords);
    for (let i = 0; i < n; i += 1) {
      V.set(X, i * blockWords);
      blockMix(X, Y, r);
    }
    for (let i = 0; i < n; i += 1) {
      const j = (X[(2 * r - 1) * 16] & (n - 1)) >>> 0;
      const off = j * blockWords;
      for (let k = 0; k < blockWords; k += 1) X[k] ^= V[off + k];
      blockMix(X, Y, r);
    }
  }
  V.fill(0);
  Y.fill(0);
  const out = await pbkdf2Sha256(password, b, 1, dkLen);
  b.fill(0);
  return out;
}

async function gcmDecrypt(keyBytes, iv, ciphertextAndTag) {
  const s = kdfSubtle();
  try {
    const key = await s.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv }, key, ciphertextAndTag));
  } catch (e) {
    throw new KdfError('bad_password');
  }
}

// ---- Aegis: password slots (type 1) with scrypt, then master key, then db ----
async function decryptAegis(data, password) {
  const slots = data && data.slots;
  const params = data && data.params;
  if (!Array.isArray(slots) || !params || typeof params !== 'object') throw new KdfError('invalid');
  if (slots.length > KDF_LIMITS.maxSlots) throw new KdfError('invalid');
  const pwSlots = slots.filter((slot) => slot && typeof slot === 'object' && slot.type === 1);
  if (!pwSlots.length) throw new KdfError('no_slot');
  // Validate every parameter of every slot before the first (expensive) derivation.
  const parsed = pwSlots.map((slot) => {
    const kp = slot.key_params && typeof slot.key_params === 'object' ? slot.key_params : {};
    if (!scryptLimitsOk(slot.n, slot.r, slot.p)) throw new KdfError('kdf_limit');
    return {
      n: slot.n, r: slot.r, p: slot.p,
      salt: hexBytes(slot.salt, KDF_LIMITS.saltMin, KDF_LIMITS.saltMax),
      key: hexBytes(slot.key, 32, 32),
      nonce: hexBytes(kp.nonce, 12, 12),
      tag: hexBytes(kp.tag, 16, 16),
    };
  });
  const dbNonce = hexBytes(params.nonce, 12, 12);
  const dbTag = hexBytes(params.tag, 16, 16);
  const db = b64Bytes(data.db, 1, 8 * 1024 * 1024);
  for (const slot of parsed) {
    let kek = null;
    let master = null;
    try {
      kek = await scrypt(password, slot.salt, slot.n, slot.r, slot.p, 32);
      master = await gcmDecrypt(kek, slot.nonce, concat(slot.key, slot.tag));
      if (master.length !== 32) continue;
      const plain = await gcmDecrypt(master, dbNonce, concat(db, dbTag));
      return new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } catch (e) {
      if (e instanceof KdfError && e.code !== 'bad_password') throw e;
    } finally {
      if (kek) kek.fill(0);
      if (master) master.fill(0);
    }
  }
  throw new KdfError('bad_password');
}

// ---- 2FAS: base64(ct+tag):base64(salt):base64(iv), PBKDF2-SHA256 ----
function parse2fasPart(str) {
  if (typeof str !== 'string' || str.length > 8 * 1024 * 1024) throw new KdfError('invalid');
  const parts = str.split(':');
  if (parts.length !== 3) throw new KdfError('invalid');
  return {
    ct: b64Bytes(parts[0], 17, 8 * 1024 * 1024),
    salt: b64Bytes(parts[1], KDF_LIMITS.saltMin, KDF_LIMITS.saltMax),
    iv: b64Bytes(parts[2], 12, 12),
  };
}

async function decrypt2fas(data, password) {
  const iterations = data && data.iterations != null ? data.iterations : 10000;
  if (!Number.isSafeInteger(iterations) || iterations < KDF_LIMITS.pbkdf2Min || iterations > KDF_LIMITS.pbkdf2Max) {
    throw new KdfError('kdf_limit');
  }
  const main = parse2fasPart(data.servicesEncrypted);
  const ref = data.reference == null ? null : parse2fasPart(data.reference);
  const open = async (part) => {
    let key = null;
    try {
      key = await pbkdf2Sha256(password, part.salt, iterations, 32);
      return await gcmDecrypt(key, part.iv, part.ct);
    } finally {
      if (key) key.fill(0);
    }
  };
  const plain = await open(main);
  if (ref) (await open(ref)).fill(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

async function runKdfJob(job) {
  const password = job && job.password instanceof Uint8Array ? job.password : new Uint8Array(0);
  try {
    if (!password.length) throw new KdfError('bad_password');
    if (job.format === 'aegis') return { ok: true, text: await decryptAegis(job.data, password) };
    if (job.format === '2fas') return { ok: true, text: await decrypt2fas(job.data, password) };
    throw new KdfError('invalid');
  } catch (e) {
    // Anything unexpected (bad UTF-8, out of memory) is the same generic error: no oracle.
    return { ok: false, code: e instanceof KdfError ? e.code : 'bad_password' };
  } finally {
    password.fill(0);
  }
}

if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  self.onmessage = (event) => {
    const msg = event.data || {};
    runKdfJob(msg).then((res) => { res.id = msg.id; self.postMessage(res); });
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { runKdfJob, scrypt, KDF_LIMITS, scryptLimitsOk };
