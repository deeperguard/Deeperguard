/**
 * Shared WebAuthn helpers for login and settings.
 */
(function (global) {
  'use strict';

  function bufferFromBase64url(value) {
    const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function bufferToBase64url(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function prepareRegistrationOptions(options) {
    const next = { ...options };
    next.challenge = bufferFromBase64url(options.challenge);
    next.user = {
      ...options.user,
      id: bufferFromBase64url(options.user.id),
    };
    if (options.excludeCredentials) {
      next.excludeCredentials = options.excludeCredentials.map((cred) => ({
        ...cred,
        id: bufferFromBase64url(cred.id),
      }));
    }
    return next;
  }

  function prepareAuthenticationOptions(options) {
    const next = { ...options };
    next.challenge = bufferFromBase64url(options.challenge);
    if (options.allowCredentials) {
      next.allowCredentials = options.allowCredentials.map((cred) => ({
        ...cred,
        id: bufferFromBase64url(cred.id),
      }));
    }
    return next;
  }

  function registrationCredentialJson(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        attestationObject: bufferToBase64url(response.attestationObject),
      },
      transports: response.getTransports ? response.getTransports() : [],
    };
  }

  function authenticationCredentialJson(assertion) {
    const response = assertion.response;
    return {
      id: assertion.id,
      rawId: assertion.id,
      type: assertion.type,
      response: {
        authenticatorData: bufferToBase64url(response.authenticatorData),
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        signature: bufferToBase64url(response.signature),
        userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
      },
    };
  }

  // ---- PRF extension (docs/VAULT_RECOVERY.md 1.4) ----
  // Before a ceremony: 'unsupported' (browser has no WebAuthn, or reports no PRF),
  // 'available' (browser reports PRF) or 'unknown' (WebAuthn present, browser cannot
  // say; only a ceremony shows it). The authenticator can still return nothing.
  async function prfBrowserSupport() {
    const PKC = global.PublicKeyCredential;
    if (typeof PKC === 'undefined') return 'unsupported';
    if (typeof PKC.getClientCapabilities === 'function') {
      try {
        const caps = await PKC.getClientCapabilities();
        if (caps && caps['extension:prf'] === true) return 'available';
        if (caps && caps['extension:prf'] === false) return 'unsupported';
      } catch (err) {
        /* fall through to unknown */
      }
    }
    return 'unknown';
  }

  function prfExtension(salt) {
    if (!(salt instanceof Uint8Array) || !salt.length) throw new Error('Missing PRF salt');
    return { prf: { eval: { first: salt } } };
  }

  // After a ceremony: the 32-byte PRF output, or null when browser/authenticator gave none.
  function prfOutputFromCredential(credential) {
    const results = credential && typeof credential.getClientExtensionResults === 'function'
      ? credential.getClientExtensionResults()
      : null;
    const first = results && results.prf && results.prf.results && results.prf.results.first;
    if (!first) return null;
    let bytes = null;
    if (first instanceof ArrayBuffer) bytes = new Uint8Array(first);
    else if (ArrayBuffer.isView(first)) bytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    return bytes && bytes.length === 32 ? new Uint8Array(bytes) : null;
  }

  // Runs a get() ceremony asking for PRF output. Returns {status:'ok', output, credentialId, credential}
  // or {status:'unsupported', reason:'browser'|'authenticator'}. A cancelled ceremony throws.
  async function requestPrfOutput(authOptions, salt) {
    if (await prfBrowserSupport() === 'unsupported') return { status: 'unsupported', reason: 'browser' };
    const publicKey = {
      ...authOptions,
      userVerification: 'required',
      extensions: { ...(authOptions.extensions || {}), ...prfExtension(salt) },
    };
    const credential = await global.navigator.credentials.get({ publicKey });
    if (!credential) throw new Error('Passkey request was cancelled');
    const output = prfOutputFromCredential(credential);
    if (!output) return { status: 'unsupported', reason: 'authenticator' };
    return { status: 'ok', output, credentialId: credential.id, credential };
  }

  global.NotesWebAuthn = {
    prfBrowserSupport,
    prfExtension,
    prfOutputFromCredential,
    requestPrfOutput,
    bufferFromBase64url,
    bufferToBase64url,
    prepareRegistrationOptions,
    prepareAuthenticationOptions,
    registrationCredentialJson,
    authenticationCredentialJson,
    isIpHost(hostname) {
      const host = String(hostname || '').trim().toLowerCase();
      if (!host) return false;
      if (host.includes(':')) return true;
      const parts = host.split('.');
      if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)) {
        return true;
      }
      return false;
    },
    passkeyHostError(preferredUrl) {
      const host = window.location.hostname;
      if (!this.isIpHost(host)) return null;
      const url = preferredUrl || 'https://www.deeperguard.com/';
      return `Passkeys need a hostname, not an IP address. Open ${url} on this device (DNS + trusted HTTPS cert).`;
    },
    supported() {
      return typeof window.PublicKeyCredential !== 'undefined';
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
