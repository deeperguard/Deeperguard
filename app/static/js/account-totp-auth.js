/**
 * Account 2FA helpers: SRP prove before disable, user-facing error mapping.
 */
(function (global) {
  'use strict';

  function accountTotpApiErrorMessage(err) {
    const msg = String(err?.message || '').trim();
    const lower = msg.toLowerCase();
    if (err?.status === 429) {
      if (lower.includes('hour')) return msg;
      if (lower.includes('too many attempts')) return 'Too many attempts. Try again in a few minutes.';
      return msg;
    }
    if (lower === 'invalid code' || msg === 'invalid code') {
      return "That code didn't work. Check your authenticator and try again.";
    }
    return msg;
  }

  function accountTotpProveErrorMessage(err) {
    if (err?.status === 401) return 'Password is incorrect.';
    return accountTotpApiErrorMessage(err) || String(err?.message || '');
  }

  function resolvePasswordChangeProve(passwordChangeProve) {
    if (typeof passwordChangeProve === 'function') return passwordChangeProve;
    return global.NotesSrpAuth?.passwordChangeProve;
  }

  async function srpTotpPasswordProve(email, password, { button, passwordChangeProve } = {}) {
    const prove = resolvePasswordChangeProve(passwordChangeProve);
    if (!prove) throw new Error('Secure sign-in did not load');
    const btn = button || null;
    const prevLabel = btn ? btn.textContent : '';
    const wasDisabled = btn ? btn.disabled : false;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }
    try {
      return await prove(email, password);
    } finally {
      if (btn) {
        btn.disabled = wasDisabled;
        btn.textContent = prevLabel;
      }
    }
  }

  /**
   * SRP rotation token for /api/totp/disable. Calls onToast(message, isError) and
   * onFocusPassword() when the password field should regain focus.
   */
  async function srpTotpDisableRotationToken({
    email,
    password,
    button,
    passwordChangeProve,
    onToast,
    onFocusPassword,
  }) {
    let proved;
    try {
      proved = await srpTotpPasswordProve(email, password, { button, passwordChangeProve });
    } catch (proveErr) {
      const message = accountTotpProveErrorMessage(proveErr);
      if (typeof onToast === 'function') {
        onToast(message || 'Could not verify your password.', true);
      }
      if (proveErr?.status === 401 && typeof onFocusPassword === 'function') {
        onFocusPassword();
      }
      return { ok: false, reason: 'prove_error', err: proveErr };
    }
    const rotationToken = String(proved?.rotation_token || '').trim();
    if (!rotationToken) {
      if (typeof onToast === 'function') {
        onToast('Could not verify your password — try again.', true);
      }
      if (typeof onFocusPassword === 'function') onFocusPassword();
      return { ok: false, reason: 'empty_token' };
    }
    return { ok: true, rotation_token: rotationToken };
  }

  global.NotesAccountTotpAuth = {
    accountTotpApiErrorMessage,
    accountTotpProveErrorMessage,
    srpTotpPasswordProve,
    srpTotpDisableRotationToken,
  };
})(typeof window !== 'undefined' ? window : globalThis);
