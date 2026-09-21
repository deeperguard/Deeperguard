/**
 * In-memory vault secrets and encrypted device-remember storage.
 * Passwords are never written to sessionStorage.
 */
(function (global) {
  'use strict';

  let vaultPassword = '';
  let accountPassword = '';

  const DEV_KEY = 'notes_device_key';
  const DEV_ENC = 'notes_device_password_enc';
  const BOOT_KEY = 'notes_boot_key';
  const BOOT_ENC = 'notes_boot_password_enc';

  function setVaultPassword(password) {
    vaultPassword = String(password || '').trim();
  }

  function getVaultPassword() {
    return vaultPassword;
  }

  function setAccountPassword(password) {
    accountPassword = String(password || '').trim();
  }

  function getAccountPassword() {
    return accountPassword;
  }

  async function getBootKey() {
    let raw = '';
    try {
      raw = sessionStorage.getItem(BOOT_KEY) || '';
    } catch (err) {
      raw = '';
    }
    if (!raw) {
      raw = bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
      try {
        sessionStorage.setItem(BOOT_KEY, raw);
      } catch (err) {
        /* ignore */
      }
    }
    return crypto.subtle.importKey('raw', b64ToBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function stashBootPassword(password) {
    const clean = String(password || '').trim();
    setVaultPassword(clean);
    setAccountPassword(clean);
    if (!clean) return;
    try {
      const key = await getBootKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(clean),
      );
      sessionStorage.setItem(BOOT_ENC, JSON.stringify({
        iv: bytesToB64(iv),
        data: bytesToB64(new Uint8Array(cipher)),
      }));
    } catch (err) {
      /* ignore quota / private mode */
    }
  }

  async function consumeBootPassword() {
    let payloadRaw = '';
    let bootKeyRaw = '';
    try {
      payloadRaw = sessionStorage.getItem(BOOT_ENC) || '';
      bootKeyRaw = sessionStorage.getItem(BOOT_KEY) || '';
      sessionStorage.removeItem(BOOT_ENC);
      sessionStorage.removeItem(BOOT_KEY);
    } catch (err) {
      return '';
    }
    if (!payloadRaw || !bootKeyRaw) return '';
    try {
      const payload = JSON.parse(payloadRaw);
      const key = await crypto.subtle.importKey(
        'raw',
        b64ToBytes(bootKeyRaw),
        'AES-GCM',
        false,
        ['decrypt'],
      );
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(payload.iv) },
        key,
        b64ToBytes(payload.data),
      );
      const password = new TextDecoder().decode(plain);
      setVaultPassword(password);
      setAccountPassword(password);
      return password;
    } catch (err) {
      return '';
    }
  }

  function clearBootPassword() {
    try {
      sessionStorage.removeItem(BOOT_ENC);
      sessionStorage.removeItem(BOOT_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  function bytesToB64(bytes) {
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function getDeviceKey() {
    let raw = '';
    try {
      raw = localStorage.getItem(DEV_KEY) || '';
    } catch (err) {
      raw = '';
    }
    if (!raw) {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      raw = bytesToB64(keyBytes);
      try {
        localStorage.setItem(DEV_KEY, raw);
      } catch (err) {
        /* ignore */
      }
    }
    return crypto.subtle.importKey('raw', b64ToBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function saveDevicePassword(password) {
    if (!password) {
      clearDevicePassword();
      return;
    }
    const key = await getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(String(password)),
    );
    const payload = {
      iv: bytesToB64(iv),
      data: bytesToB64(new Uint8Array(cipher)),
    };
    try {
      localStorage.setItem(DEV_ENC, JSON.stringify(payload));
      localStorage.removeItem('notes_device_password');
    } catch (err) {
      /* ignore */
    }
  }

  async function loadDevicePassword() {
    try {
      const legacy = localStorage.getItem('notes_device_password');
      if (legacy) {
        await saveDevicePassword(legacy);
        return legacy;
      }
    } catch (err) {
      /* ignore */
    }
    let payloadRaw = '';
    try {
      payloadRaw = localStorage.getItem(DEV_ENC) || '';
    } catch (err) {
      return '';
    }
    if (!payloadRaw) return '';
    try {
      const payload = JSON.parse(payloadRaw);
      const key = await getDeviceKey();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(payload.iv) },
        key,
        b64ToBytes(payload.data),
      );
      return new TextDecoder().decode(plain);
    } catch (err) {
      return '';
    }
  }

  function clearDevicePassword() {
    try {
      localStorage.removeItem(DEV_ENC);
      localStorage.removeItem('notes_device_password');
      localStorage.removeItem(DEV_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  function clearSecrets() {
    vaultPassword = '';
    accountPassword = '';
    clearBootPassword();
  }

  global.NotesVaultSecrets = {
    setVaultPassword,
    getVaultPassword,
    setAccountPassword,
    getAccountPassword,
    clearSecrets,
    stashBootPassword,
    consumeBootPassword,
    clearBootPassword,
    saveDevicePassword,
    loadDevicePassword,
    clearDevicePassword,
  };
})(typeof window !== 'undefined' ? window : globalThis);
