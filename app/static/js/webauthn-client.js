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

  global.NotesWebAuthn = {
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
