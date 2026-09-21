/* eslint-disable no-restricted-globals */
importScripts('vendor/noble-crypto.js', 'vendor/noble-argon2.js');

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
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(0);
  return bytes;
}

function alignBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function decodeSaltBytes(salt) {
  const text = String(salt || '').trim();
  if (!text) return new Uint8Array(8);
  try {
    const decoded = fromB64(text);
    if (decoded.length >= 8) return alignBytes(decoded);
  } catch (err) {
    /* fall through */
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
  return alignBytes(NobleCrypto.sha256(merged));
}

async function deriveRawV2(password, salt) {
  const pwd = new TextEncoder().encode(String(password || ''));
  const saltBytes = decodeSaltBytes(salt);
  const raw = await NobleArgon2.argon2idAsync(pwd, saltBytes, ARGON2_PARAMS);
  return alignBytes(raw);
}

async function deriveKey(password, salt, kdfVersion) {
  const version = Number(kdfVersion) === VAULT_KDF_V2 ? VAULT_KDF_V2 : VAULT_KDF_V1;
  if (version === VAULT_KDF_V2) {
    const raw = await deriveRawV2(password, salt);
    return { raw: b64(raw), encoding: 'argon2id', version: VAULT_KDF_V2 };
  }
  const raw = deriveRawV1(password, salt);
  return { raw: b64(raw), encoding: 'sha256', version: VAULT_KDF_V1 };
}

async function decryptObject(rawB64, payload) {
  const raw = alignBytes(fromB64(rawB64));
  const iv = fromB64(payload.iv);
  const data = fromB64(payload.data);
  const plain = NobleCrypto.gcm(raw, iv).decrypt(data);
  return JSON.parse(new TextDecoder().decode(plain));
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'deriveKey') {
      const result = await deriveKey(msg.password, msg.salt, msg.kdfVersion);
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (msg.type === 'decrypt') {
      const content = await decryptObject(msg.rawKey, msg.payload);
      self.postMessage({ id, ok: true, content });
      return;
    }
    self.postMessage({ id, ok: false, error: 'unknown message type' });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
