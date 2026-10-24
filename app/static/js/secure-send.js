/**
 * D2 Secure Send — client encrypt/decrypt. Key lives only in the URL fragment (#).
 * Optional passphrase: Argon2id (vault KDF v2) combined with a fragment key so
 * the link alone cannot decrypt and offline guessing stays expensive.
 * File name / MIME / size live only inside the ciphertext.
 */
(function (global) {
  'use strict';

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_EXPIRES_SECONDS = 7 * 24 * 3600;
  const DEFAULT_EXPIRES_SECONDS = MAX_EXPIRES_SECONDS;
  const DEFAULT_MAX_VIEWS = 1;
  const LINK_STOPPED = 'This link has stopped working.';
  /** Generic download name — never use a server Content-Disposition filename. */
  const GENERIC_DOWNLOAD_NAME = 'attachment.bin';

  function b64url(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let binary = '';
    for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromB64url(text) {
    const s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const binary = atob(s + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(out);
    } else {
      for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
    }
    return out;
  }

  function cryptoApi() {
    const c = global.NotesCrypto;
    if (!c || !c.encryptObject || !c.deriveKey) {
      throw new Error('Encryption library failed to load. Refresh the page.');
    }
    return c;
  }

  /** contentKey = SHA-256(fragKey || argon2id(pass, salt)) — both required. */
  async function derivePassphraseContentKey(fragKey, passphrase, saltBytes) {
    const c = cryptoApi();
    const lib = global.NobleCrypto;
    if (!lib || !lib.sha256) throw new Error('Encryption library failed to load.');
    const derived = await c.deriveKey(passphrase, b64url(saltBytes), {
      version: c.VAULT_KDF_V2,
    });
    const passKey = derived.key.raw;
    const merged = new Uint8Array(fragKey.length + passKey.length);
    merged.set(fragKey, 0);
    merged.set(passKey, fragKey.length);
    const aligned = new Uint8Array(merged.length);
    aligned.set(merged);
    const digest = lib.sha256(aligned);
    const raw = new Uint8Array(digest.length);
    raw.set(digest);
    return { raw };
  }

  /**
   * Fragment formats (never sent to the server):
   *   v1.<contentKey>                         — no passphrase
   *   v1p.<salt>.<fragKey>                     — passphrase required (Argon2id + fragKey)
   */
  async function sealPayload({ title, body, file, passphrase }) {
    const c = cryptoApi();
    const plain = {
      title: String(title || '').slice(0, 500),
      body: String(body || '').slice(0, 2_000_000),
      file: null,
    };
    if (file) {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) {
        throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
      }
      // Name, MIME, and size are encrypted with the note — never sent in the clear.
      plain.file = {
        name: String(file.name || 'file').slice(0, 255),
        mime: String(file.type || 'application/octet-stream').slice(0, 128),
        size: buf.length,
        data: b64url(buf),
      };
    }

    const pass = String(passphrase || '').trim();
    let contentKey;
    let fragment;
    let hasPassphrase = false;
    if (pass) {
      hasPassphrase = true;
      const salt = randomBytes(16);
      const fragKey = randomBytes(32);
      contentKey = await derivePassphraseContentKey(fragKey, pass, salt);
      fragment = `v1p.${b64url(salt)}.${b64url(fragKey)}`;
    } else {
      const contentKeyRaw = randomBytes(32);
      contentKey = { raw: contentKeyRaw };
      fragment = `v1.${b64url(contentKeyRaw)}`;
    }

    const ciphertext = await c.encryptObject(contentKey, plain);
    return {
      ciphertext,
      fragment,
      hasPassphrase,
      hasFile: !!plain.file,
      // Client-side hint only — server uses measured ciphertext length.
      byteSize: String(ciphertext.data || '').length + String(ciphertext.iv || '').length,
    };
  }

  async function resolveContentKey(fragment, passphrase) {
    const parts = String(fragment || '').replace(/^#/, '').split('.');
    if (parts[0] === 'v1' && parts.length === 2) {
      return { raw: fromB64url(parts[1]) };
    }
    if (parts[0] === 'v1p' && parts.length === 3) {
      const pass = String(passphrase || '');
      if (!pass) {
        const err = new Error('Passphrase required');
        err.code = 'passphrase_required';
        throw err;
      }
      const salt = fromB64url(parts[1]);
      const fragKey = fromB64url(parts[2]);
      return derivePassphraseContentKey(fragKey, pass, salt);
    }
    throw new Error('Invalid link key');
  }

  async function openPayload(ciphertext, fragment, passphrase) {
    const c = cryptoApi();
    const key = await resolveContentKey(fragment, passphrase);
    return c.decryptObject(key, ciphertext);
  }

  function fragmentNeedsPassphrase(fragment) {
    return String(fragment || '').replace(/^#/, '').startsWith('v1p.');
  }

  function buildReceiveUrl(origin, sendId, fragment) {
    const base = String(origin || '').replace(/\/$/, '');
    const frag = String(fragment || '').replace(/^#/, '');
    return `${base}/receive/${sendId}#${frag}`;
  }

  function assertNoFragmentLeak(url, body) {
    const u = String(url || '');
    if (u.includes('#')) {
      throw new Error('fragment must not appear in request URL');
    }
    const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
    if (/\bv1p?\.[A-Za-z0-9_-]{16,}/.test(raw)) {
      throw new Error('fragment must not appear in request body');
    }
  }

  /** Safe download filename from decrypted metadata only (never from the server). */
  function downloadNameFromPayload(fileMeta) {
    const name = String((fileMeta && fileMeta.name) || '').trim().replace(/[/\\]/g, '_');
    if (!name || name === '.' || name === '..') return GENERIC_DOWNLOAD_NAME;
    return name.slice(0, 255);
  }

  const api = {
    MAX_FILE_BYTES,
    MAX_EXPIRES_SECONDS,
    DEFAULT_EXPIRES_SECONDS,
    DEFAULT_MAX_VIEWS,
    LINK_STOPPED,
    GENERIC_DOWNLOAD_NAME,
    sealPayload,
    openPayload,
    resolveContentKey,
    fragmentNeedsPassphrase,
    buildReceiveUrl,
    assertNoFragmentLeak,
    downloadNameFromPayload,
    b64url,
    fromB64url,
  };

  global.NotesSecureSend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
