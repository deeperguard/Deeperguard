/**
 * Required recovery key step for a new account (docs/VAULT_RECOVERY.md 1.3, 3.1, 5.1).
 *
 * Registration marks the account as pending on this device. After the vault is
 * unlocked the app calls maybeShow(): it makes a recovery key in the browser,
 * shows it (print, download, copy), and only after the user ticks the box and
 * types one group of the key it wraps the vault key, checks that the displayed
 * key opens that wrap, and stores the wrap. The key itself never leaves the
 * page. On a failed save the user can try again; if they leave, the pending
 * mark stays and the step returns (with a new key) at the next unlock.
 */
(function (global) {
  'use strict';

  const PENDING_PREFIX = 'notes_recovery_key_pending:';
  const GROUPS = 8;

  function pendingKey(email) {
    return PENDING_PREFIX + String(email || '').trim().toLowerCase();
  }

  function markPending(email) {
    if (!email) return;
    try { global.localStorage.setItem(pendingKey(email), '1'); } catch (err) { /* ignore */ }
  }

  function clearPending(email) {
    try { global.localStorage.removeItem(pendingKey(email)); } catch (err) { /* ignore */ }
  }

  function isPending(email) {
    if (!email) return false;
    try { return global.localStorage.getItem(pendingKey(email)) === '1'; } catch (err) { return false; }
  }

  function normalizeGroup(text) {
    return String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  }

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  function csrfHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const csrf = global.sessionStorage.getItem('notes_csrf') || '';
      if (csrf) headers['X-CSRF-Token'] = csrf;
    } catch (err) { /* ignore */ }
    return headers;
  }

  async function requestJson(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: csrfHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function zero(bytes) {
    try { if (bytes && bytes.fill) bytes.fill(0); } catch (err) { /* ignore */ }
  }

  let session = null; // { email, rk, salt, text, group, deps }
  let bound = false;

  function el(id) { return global.document.getElementById(id); }

  function setError(message) {
    const box = el('recovery-key-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function setBusy(busy) {
    const dialog = el('recovery-key-dialog');
    const save = el('recovery-key-save');
    if (dialog) dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (save) {
      save.disabled = !!busy;
      if (busy) save.textContent = 'Saving…';
    }
  }

  function fileText() {
    const created = new Date().toISOString().slice(0, 10);
    return [
      'Deeperguard recovery key',
      `Account: ${session.email}`,
      `Created: ${created}`,
      '',
      session.text,
      '',
      'Keep this recovery key somewhere safe, away from this device.',
      'Deeperguard stores only an encrypted copy of your vault key that this recovery key opens.',
      'We cannot read your recovery key and cannot show it to you again.',
      'Treat it like your password: anyone who has it and can sign in to your account can open your notes.',
      '',
    ].join('\n');
  }

  function download() {
    if (!session) return;
    const blob = new Blob([fileText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = global.document.createElement('a');
    a.href = url;
    a.download = 'deeperguard-recovery-key.txt';
    a.rel = 'noopener';
    global.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function print() {
    if (!session) return;
    const body = global.document.body;
    const date = el('recovery-key-print-date');
    if (date) date.textContent = `Account: ${session.email} · Created: ${new Date().toISOString().slice(0, 10)}`;
    body.classList.add('recovery-key-printing');
    const done = () => {
      body.classList.remove('recovery-key-printing');
      global.removeEventListener('afterprint', done);
    };
    global.addEventListener('afterprint', done);
    try {
      global.print();
    } finally {
      // Chromium's print() blocks until the dialog closes; afterprint may not fire everywhere.
      setTimeout(done, 0);
    }
  }

  async function copy() {
    if (!session) return;
    const toast = session.deps.toast || (() => {});
    const helper = global.NotesClipboardSensitive;
    if (helper && helper.copySensitive) {
      await helper.copySensitive(session.text, { label: 'Recovery key', onToast: toast });
      return;
    }
    try {
      await global.navigator.clipboard.writeText(session.text);
      toast('Recovery key copied.');
    } catch (err) {
      toast('Copy failed. Select the key and copy it by hand.', true);
    }
  }

  function close() {
    const dialog = el('recovery-key-dialog');
    const backdrop = el('recovery-key-backdrop');
    if (dialog) dialog.hidden = true;
    if (backdrop) backdrop.hidden = true;
    const value = el('recovery-key-value');
    if (value) value.textContent = '';
    const input = el('recovery-key-confirm-group');
    if (input) input.value = '';
    const pw = el('recovery-key-password');
    if (pw) pw.value = '';
    if (session) {
      zero(session.rk);
      zero(session.salt);
    }
    session = null;
  }

  function isOpen() {
    const dialog = el('recovery-key-dialog');
    return !!(dialog && !dialog.hidden);
  }

  async function saveWrap() {
    const { deps } = session;
    const C = global.NotesCrypto;
    const status = await requestJson('GET', '/api/account/vault-keys');
    if (status.recovery && status.recovery.active) return { already: true };
    const password = deps.getPassword() || String(el('recovery-key-password')?.value || '');
    if (!password) {
      const err = new Error('Enter your password to save the recovery key.');
      err.needPassword = true;
      throw err;
    }
    const vk = deps.getVaultKey();
    if (!vk) {
      const err = new Error('The vault was locked. Unlock it to finish this step.');
      err.locked = true;
      throw err;
    }
    try {
      const accountId = String(status.account_id || '');
      const wrapKey = C.deriveRecoveryWrapKey(session.rk, session.salt);
      const wrap = await C.wrapVaultKey(vk, wrapKey, { accountId, type: 'recovery' });
      zero(wrapKey.raw);
      // Check the copy before storing it: the key exactly as shown on screen must open it.
      const shown = C.decodeRecoveryKey(session.text);
      const shownWrapKey = C.deriveRecoveryWrapKey(shown, session.salt);
      const opened = await C.unwrapVaultKey(shownWrapKey, wrap, { accountId, type: 'recovery' });
      const same = opened.raw.length === vk.raw.length && opened.raw.every((b, i) => b === vk.raw[i]);
      zero(opened.raw);
      zero(shownWrapKey.raw);
      zero(shown);
      if (!same) throw new Error('The recovery key copy did not check out. Nothing was saved.');
      const proof = C.hkdfSha256(session.rk, session.salt, 'deeperguard/recovery-proof/v1', 32);
      const proofHash = await C.hashBytes(proof);
      zero(proof);
      const body = {
        token: '',
        expected_key_rev: Number(status.key_rev) || 0,
        key_id: wrap.key_id,
        wrap_version: wrap.wrap_version,
        recovery_salt: toB64(session.salt),
        wrap: wrap.blob,
        proof_hash: proofHash,
      };
      let revRetried = false;
      for (let attempt = 1; ; attempt += 1) {
        if (!body.token) body.token = (await global.NotesSrpAuth.vaultKeysProve(session.email, password)).token;
        try {
          return await requestJson('PUT', '/api/account/vault-keys/recovery', body);
        } catch (err) {
          // The token lives in the session cookie; a background request that was
          // in flight during the proof can overwrite it. Prove again.
          if (err.status === 401 && err.data?.error === 'invalid or expired token' && attempt < 3) {
            body.token = '';
            continue;
          }
          if (err.status !== 409 || err.data?.error !== 'key_rev_mismatch' || revRetried) throw err;
          // Another device changed the wraps meanwhile: look again once (3.1 step 4).
          revRetried = true;
          const again = await requestJson('GET', '/api/account/vault-keys');
          if (again.recovery && again.recovery.active) return { already: true };
          body.expected_key_rev = Number(again.key_rev) || 0;
        }
      }
    } finally {
      zero(vk.raw);
    }
  }

  function saveErrorMessage(err) {
    if (err?.needPassword || err?.locked) return err.message;
    if (err?.status === 401 && /password/i.test(String(err.message))) {
      return 'That password is not right. Enter the password you use to sign in.';
    }
    if (err?.status === 409 && err.data?.error === 'key_id_mismatch') {
      return 'The vault password was changed on another device. Lock the vault and unlock it with the new password; this step returns after that.';
    }
    if (err?.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (!err?.status || err.status >= 500 || err.code === 'timeout') {
      return 'Could not save the recovery key. Check your connection and try again. If you leave now, this step returns with a new key the next time you unlock.';
    }
    return `Could not save the recovery key (${err.message}). Try again.`;
  }

  async function onSave() {
    if (!session) return;
    setError('');
    const box = el('recovery-key-stored');
    const input = el('recovery-key-confirm-group');
    if (!box?.checked) {
      setError('Tick the box to confirm that you stored your recovery key.');
      box?.focus();
      return;
    }
    const expected = session.text.split('-')[session.group - 1];
    if (normalizeGroup(input?.value) !== expected) {
      input?.setAttribute('aria-invalid', 'true');
      setError(`Group ${session.group} does not match your recovery key. Check what you stored.`);
      input?.focus();
      return;
    }
    input?.removeAttribute('aria-invalid');
    setBusy(true);
    let result;
    try {
      result = await saveWrap();
    } catch (err) {
      setBusy(false);
      const save = el('recovery-key-save');
      if (save) save.textContent = 'Try again';
      if (err?.needPassword || (err?.status === 401 && /password/i.test(String(err.message)))) {
        const wrapEl = el('recovery-key-password-row');
        if (wrapEl) wrapEl.hidden = false;
        el('recovery-key-password')?.focus();
      }
      setError(saveErrorMessage(err));
      if (err?.locked) close();
      return;
    }
    const { email, deps } = session;
    if (result && result.auth_security_at && deps.ackAuthSecurity) deps.ackAuthSecurity(result.auth_security_at);
    clearPending(email);
    setBusy(false);
    close();
    if (deps.toast) {
      deps.toast(result && result.already
        ? 'A recovery key was already set up for this account.'
        : 'Recovery key saved. Keep it somewhere safe.');
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    el('recovery-key-print')?.addEventListener('click', print);
    el('recovery-key-download')?.addEventListener('click', download);
    el('recovery-key-copy')?.addEventListener('click', () => { copy().catch(() => {}); });
    el('recovery-key-save')?.addEventListener('click', () => { onSave().catch(() => {}); });
    el('recovery-key-confirm-group')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSave().catch(() => {});
      }
    });
    // Required step: Escape does not dismiss it.
    el('recovery-key-dialog')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  function open(email, deps) {
    const C = global.NotesCrypto;
    const rk = C.generateRecoveryKey();
    const groupBytes = new Uint8Array(1);
    global.crypto.getRandomValues(groupBytes);
    session = {
      email,
      rk,
      salt: C.generateRecoverySalt(),
      text: C.encodeRecoveryKey(rk),
      group: (groupBytes[0] % GROUPS) + 1,
      deps,
    };
    bind();
    el('recovery-key-value').textContent = session.text;
    el('recovery-key-group-number').textContent = String(session.group);
    const box = el('recovery-key-stored');
    if (box) box.checked = false;
    const input = el('recovery-key-confirm-group');
    if (input) {
      input.value = '';
      input.removeAttribute('aria-invalid');
    }
    const pwRow = el('recovery-key-password-row');
    if (pwRow) pwRow.hidden = !!deps.getPassword();
    const save = el('recovery-key-save');
    if (save) {
      save.disabled = false;
      save.textContent = 'Continue';
    }
    setError('');
    el('recovery-key-backdrop').hidden = false;
    const dialog = el('recovery-key-dialog');
    dialog.setAttribute('aria-busy', 'false');
    dialog.hidden = false;
    el('recovery-key-download')?.focus();
  }

  /**
   * deps: { email, getVaultKey() -> {raw}|null, getPassword() -> string,
   *         ackAuthSecurity(at), toast(message, isError) }
   * Resolves true when the step is shown.
   */
  async function maybeShow(deps) {
    const email = String(deps?.email || '').trim().toLowerCase();
    if (!isPending(email) || isOpen()) return false;
    if (!global.NotesCrypto?.generateRecoveryKey || !global.NotesSrpAuth?.vaultKeysProve) return false;
    if (!el('recovery-key-dialog')) return false;
    let status;
    try {
      status = await requestJson('GET', '/api/account/vault-keys');
    } catch (err) {
      // 404: the server runs without strict zero-knowledge; the feature is off there.
      if (err.status === 404) clearPending(email);
      return false;
    }
    if (status.recovery && status.recovery.active) {
      clearPending(email);
      return false;
    }
    const probe = deps.getVaultKey();
    if (!probe) return false;
    zero(probe.raw);
    if (isOpen()) return false;
    open(email, deps);
    return true;
  }

  const api = { markPending, isPending, clearPending, maybeShow, close, isOpen, normalizeGroup };
  global.NotesRecoveryKeySetup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
